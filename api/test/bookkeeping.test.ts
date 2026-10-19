import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/index';
import { api, deliveredLoad, makeCarrier, stops, today, type Carrier } from './helpers';

let c: Carrier;
beforeAll(async () => {
  c = await makeCarrier('Books');
});

async function importCsv(token: string, csv: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set('provider', fields.provider ?? 'efs');
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set('file', new File([csv], 'efs.csv', { type: 'text/csv' }));
  const res = await app.request('/api/fuel/imports', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }, env);
  return { status: res.status, body: (await res.json()) as any };
}
const stamp = (offsetMin: number) => {
  const d = new Date(Date.now() + offsetMin * 60_000);
  return { date: `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`, time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` };
};

describe('fuel-card import', () => {
  let load: { id: string; load_number: string };
  let first: any;
  let csv: string;

  beforeAll(async () => {
    // c.driver is a 1099 contractor driving truck 101.
    const l = (await api('POST', '/api/loads', { token: c.tokens.owner, body: { driver_id: c.driver.id, truck_id: c.truck.id, rate_cents: 300_000, loaded_miles: 900, stops } })).body.load;
    await api('POST', `/api/loads/${l.id}/status`, { token: c.tokens.owner, body: { status: 'dispatched' } });
    load = l;
    // the dispatch stamp must precede the fuel stop
    const s = stamp(1);
    csv = [
      'Card #,Tran Date,Tran Time,Invoice,Unit,Driver Name,Location Name,City,State/ Prov,Item,Qty,Amt',
      `70830512345678904321,${s.date},${s.time},INV-5501,0101,"${c.driver.last_name}, ${c.driver.first_name}","Pilot #412, Texarkana",Texarkana,AR,ULSD,120.456,$481.82`,
      `70830512345678904321,${s.date},${s.time},INV-5501,0101,"${c.driver.last_name}, ${c.driver.first_name}","Pilot #412, Texarkana",Texarkana,AR,DEF,5.000,$18.50`,
      `70830512345678904321,${s.date},${s.time},INV-5502,0101,"${c.driver.last_name}, ${c.driver.first_name}",Loves #300,Hope,AR,CADV,,$100.00`,
      `11112222333344445555,${s.date},${s.time},INV-5503,999,Nobody,TA Dallas,Dallas,TX,ULSD,80,$320.00`,
      `11112222333344445555,not-a-date,${s.time},INV-5504,999,Nobody,TA Dallas,Dallas,TX,ULSD,80,$320.00`,
    ].join('\n');
  });

  it('imports, matches truck/driver/load, and reports errors by row', async () => {
    const res = await importCsv(c.tokens.owner, csv, { charge_back: 'true' });
    expect(res.status).toBe(201);
    first = res.body;
    expect(res.body.import).toMatchObject({ row_count: 5, imported_count: 4, duplicate_count: 0, unmatched_count: 1, error_count: 1 });
    expect(res.body.errors).toEqual([{ row: 6, error: 'unreadable date "not-a-date"' }]);
    const txs = (await api('GET', '/api/fuel/transactions', { token: c.tokens.owner })).body.transactions;
    const diesel = txs.find((t: any) => t.product === 'diesel' && t.state === 'AR');
    expect(diesel).toMatchObject({ truck_id: c.truck.id, driver_id: c.driver.id, load_id: load.id, gallons_milli: 120_456, amount_cents: 48_182, card_last4: '4321' });
    expect(txs.find((t: any) => t.state === 'TX').truck_id).toBeNull();
  });

  it('charges fuel back to the contractor as sourced deductions, and card cash as an advance', async () => {
    expect(first.chargebacks).toBe(3);
    const charges = (await api('GET', `/api/charges?driver_id=${c.driver.id}`, { token: c.tokens.owner })).body.charges;
    expect(charges.map((ch: any) => [ch.category, ch.amount_cents, !!ch.fuel_transaction_id]).sort()).toEqual([
      ['fuel', 1_850, true],
      ['fuel', 48_182, true],
    ]);
    expect(charges.find((ch: any) => ch.amount_cents === 48_182).description).toContain('120.456 gal diesel');
    const advances = (await api('GET', `/api/advances?driver_id=${c.driver.id}`, { token: c.tokens.owner })).body.advances;
    expect(advances).toEqual([expect.objectContaining({ amount_cents: 10_000, method: 'fuel_card', fuel_transaction_id: expect.any(String) })]);
  });

  it('re-importing the same file adds nothing', async () => {
    const res = await importCsv(c.tokens.owner, csv, { charge_back: 'true' });
    expect(res.body.import).toMatchObject({ imported_count: 0, duplicate_count: 4 });
    expect(res.body.chargebacks).toBe(0);
  });

  it('explains missing columns and accepts a mapping', async () => {
    const odd = 'When,Where,Cost\n2026-10-01,OK,$10.00\n';
    const res = await importCsv(c.tokens.owner, odd);
    expect(res.status).toBe(422);
    expect(res.body.headers).toEqual(['When', 'Where', 'Cost']);
    const mapped = await importCsv(c.tokens.owner, odd, { mapping: JSON.stringify({ date: 'When', state: 'Where', amount: 'Cost' }) });
    expect(mapped.status).toBe(201);
    expect((await importCsv(c.tokens.owner, odd, { mapping: '{nope' })).status).toBe(400);
  });

  it('only the owner can charge fuel back; drivers cannot import', async () => {
    expect((await importCsv(c.tokens.dispatcher, csv, { charge_back: 'true' })).status).toBe(403);
    expect((await importCsv(c.tokens.dispatcher, csv)).status).toBe(201);
    expect((await importCsv(c.tokens.driver, csv)).status).toBe(403);
  });

  it('fixing an unmatched row attaches it; moving a charged row moves its charge-back', async () => {
    const txs = (await api('GET', '/api/fuel/transactions?unmatched=1', { token: c.tokens.owner })).body.transactions;
    const res = await api('PATCH', `/api/fuel/transactions/${txs[0].id}`, { token: c.tokens.owner, body: { truck_id: c.truck.id } });
    expect(res.body.transaction.truck_unit).toBe('101');

    const all = (await api('GET', '/api/fuel/transactions', { token: c.tokens.owner })).body.transactions;
    const charged = all.find((t: any) => t.charge_id && t.product === 'def');
    // otherDriver is W-2: their fuel is a company cost, so the charge-back is dropped
    await api('PATCH', `/api/fuel/transactions/${charged.id}`, { token: c.tokens.owner, body: { driver_id: c.otherDriver.id } });
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM driver_charges WHERE fuel_transaction_id = ?').bind(charged.id).first<{ n: number }>();
    expect(after?.n).toBe(0);
  });

  it('a fuel charge-back shows on the settlement citing its card transaction', async () => {
    await api('POST', '/api/pay-rates', { token: c.tokens.owner, body: { driver_id: c.driver.id, kind: 'per_mile', rate: 60_000, basis: 'loaded', effective_from: '2026-01-01' } });
    const s = (await api('POST', '/api/settlements', { token: c.tokens.owner, body: { driver_id: c.driver.id, period_start: '2026-01-01', period_end: today() } })).body.settlement;
    const fuelLine = s.lines.find((l: any) => l.charge_category === 'fuel');
    expect(fuelLine).toMatchObject({ amount_cents: -48_182, fuel_transaction_id: expect.any(String) });
    await api('DELETE', `/api/settlements/${s.id}`, { token: c.tokens.owner });
  });
});

describe('invoicing', () => {
  let customer: any;
  let l1: { id: string; load_number: string };
  let l2: { id: string; load_number: string };

  beforeAll(async () => {
    customer = (await api('POST', '/api/customers', { token: c.tokens.owner, body: { name: 'Acme Shipping', billing_address: '1 Dock St' } })).body.customer;
    l1 = await deliveredLoad(c, { body: { customer_id: customer.id, rate_cents: 210_000, fuel_surcharge_cents: 25_000, accessorial_cents: 5_000 } });
    l2 = await deliveredLoad(c, { body: { customer_id: customer.id, rate_cents: 150_000 }, pod: false });
  });

  it('bills delivered loads with linehaul, fuel surcharge and accessorial lines', async () => {
    const queue = (await api('GET', '/api/invoices/unbilled', { token: c.tokens.dispatcher })).body.loads;
    expect(queue.map((l: any) => l.id)).toEqual(expect.arrayContaining([l1.id, l2.id]));
    const res = await api('POST', '/api/invoices', { token: c.tokens.dispatcher, body: { customer_id: customer.id, load_ids: [l1.id, l2.id], issued_on: '2026-09-01', terms_days: 30 } });
    expect(res.status).toBe(201);
    const inv = res.body.invoice;
    expect(inv.total_cents).toBe(390_000);
    expect(inv.due_on).toBe('2026-10-01');
    expect(inv.lines.map((l: any) => l.kind)).toEqual(['linehaul', 'fuel_surcharge', 'accessorial', 'linehaul']);
    expect(res.body.warnings[0]).toContain(l2.load_number);
    expect(inv.documents.map((d: any) => d.kind)).toContain('pod');
  });

  it('never bills a load twice, and checks customer and status', async () => {
    expect((await api('POST', '/api/invoices', { token: c.tokens.owner, body: { customer_id: customer.id, load_ids: [l1.id] } })).status).toBe(409);
    const other = (await api('POST', '/api/customers', { token: c.tokens.owner, body: { name: 'Other' } })).body.customer;
    const l3 = await deliveredLoad(c, { body: { customer_id: customer.id } });
    expect((await api('POST', '/api/invoices', { token: c.tokens.owner, body: { customer_id: other.id, load_ids: [l3.id] } })).status).toBe(400);
    const open = (await api('POST', '/api/loads', { token: c.tokens.owner, body: { customer_id: customer.id, stops } })).body.load;
    expect((await api('POST', '/api/invoices', { token: c.tokens.owner, body: { customer_id: customer.id, load_ids: [open.id] } })).status).toBe(400);
  });

  it('takes partial payments, then marks paid; void frees loads for re-billing', async () => {
    const inv = (await api('GET', '/api/invoices', { token: c.tokens.owner })).body.invoices.find((i: any) => i.total_cents === 390_000);
    expect((await api('POST', `/api/invoices/${inv.id}/payments`, { token: c.tokens.owner, body: { amount_cents: 500_000, received_on: today() } })).status).toBe(400);
    const p1 = await api('POST', `/api/invoices/${inv.id}/payments`, { token: c.tokens.owner, body: { amount_cents: 90_000, received_on: today(), method: 'check', reference: '1042' } });
    expect(p1.body.invoice).toMatchObject({ status: 'open', paid_cents: 90_000, balance_cents: 300_000 });
    expect((await api('POST', `/api/invoices/${inv.id}/void`, { token: c.tokens.owner })).status).toBe(409);
    const p2 = await api('POST', `/api/invoices/${inv.id}/payments`, { token: c.tokens.owner, body: { amount_cents: 300_000, received_on: today() } });
    expect(p2.body.invoice).toMatchObject({ status: 'paid', balance_cents: 0, paid_on: today() });

    const l4 = await deliveredLoad(c, { body: { customer_id: customer.id } });
    const inv2 = (await api('POST', '/api/invoices', { token: c.tokens.owner, body: { customer_id: customer.id, load_ids: [l4.id] } })).body.invoice;
    expect((await api('POST', `/api/invoices/${inv2.id}/void`, { token: c.tokens.owner })).status).toBe(200);
    expect((await api('POST', '/api/invoices', { token: c.tokens.owner, body: { customer_id: customer.id, load_ids: [l4.id] } })).status).toBe(201);
  });

  it('ages receivables by days past due', async () => {
    const l5 = await deliveredLoad(c, { body: { customer_id: customer.id, rate_cents: 100_000 } });
    await api('POST', '/api/invoices', { token: c.tokens.owner, body: { customer_id: customer.id, load_ids: [l5.id], issued_on: '2026-01-02', terms_days: 30 } });
    const aging = (await api('GET', '/api/reports/ar-aging', { token: c.tokens.owner })).body;
    const row = aging.customers.find((r: any) => r.customer_id === customer.id);
    expect(row.over_90).toBe(100_000);
    expect(row.total).toBeGreaterThanOrEqual(100_000);
  });
});

describe('P&L', () => {
  it('per truck and per load, with actual pay separated from estimates', async () => {
    const p = await makeCarrier('Pnl');
    const owner = p.tokens.owner;
    // makeCarrier's own load is planned, so it is not in the P&L.
    await api('POST', '/api/pay-rates', { token: owner, body: { driver_id: p.driver.id, kind: 'per_mile', rate: 60_000, basis: 'all', effective_from: '2026-01-01' } });
    const settledLoad = await deliveredLoad(p, { body: { rate_cents: 200_000, fuel_surcharge_cents: 20_000, loaded_miles: 500, empty_miles: 40 } });
    const s = (await api('POST', '/api/settlements', { token: owner, body: { driver_id: p.driver.id, period_start: '2026-01-01', period_end: today() } })).body.settlement;
    await api('POST', `/api/settlements/${s.id}/finalize`, { token: owner });
    const openLoad = await deliveredLoad(p, { body: { rate_cents: 100_000, loaded_miles: 300, empty_miles: 0 } });
    await api('POST', '/api/expenses', { token: owner, body: { category: 'tires', amount_cents: 45_000, incurred_on: today(), description: 'Steer tires', truck_id: p.truck.id } });
    await api('POST', '/api/expenses', { token: owner, body: { category: 'office', amount_cents: 9_900, incurred_on: today(), description: 'Software' } });
    await api('POST', '/api/fuel/transactions', { token: owner, body: { transacted_at: new Date().toISOString(), state: 'TX', product: 'diesel', gallons_milli: 100_000, amount_cents: 40_000, truck_id: p.truck.id, load_id: settledLoad.id } });

    const res = await api('GET', `/api/reports/pnl?from=2026-01-01&to=${today()}`, { token: owner });
    expect(res.status).toBe(200);
    const truck = res.body.trucks.find((t: any) => t.key === p.truck.id);
    // revenue 2,200 + 1,000; pay 540 mi × $0.60 = 324 actual, 300 × 0.60 = 180 estimated
    expect(truck).toMatchObject({
      load_count: 2, revenue_cents: 320_000, driver_pay_cents: 32_400, driver_pay_estimated_cents: 18_000,
      fuel_cents: 40_000, expenses_cents: 45_000, expenses_by_category: { tires: 45_000 }, loaded_miles: 800, empty_miles: 40,
    });
    expect(truck.net_cents).toBe(320_000 - 32_400 - 18_000 - 40_000 - 45_000);
    expect(truck.revenue_per_mile_cents).toBe(381); // 3200 / 840 mi = $3.8095
    const overhead = res.body.trucks.find((t: any) => t.key === 'unassigned');
    expect(overhead.expenses_cents).toBe(9_900);
    expect(res.body.total.net_cents).toBe(truck.net_cents - 9_900);

    const loads = Object.fromEntries(res.body.loads.map((l: any) => [l.key, l]));
    expect(loads[settledLoad.id]).toMatchObject({ pay_basis: 'settled', driver_pay_cents: 32_400, fuel_cents: 40_000, net_cents: 220_000 - 32_400 - 40_000 });
    expect(loads[openLoad.id]).toMatchObject({ pay_basis: 'estimated', driver_pay_estimated_cents: 18_000, net_cents: 100_000 - 18_000 });
  });

  it('is owner-only', async () => {
    expect((await api('GET', '/api/reports/pnl?from=2026-01-01&to=2026-12-31', { token: c.tokens.dispatcher })).status).toBe(403);
    expect((await api('GET', '/api/reports/pnl?from=2026-01-01&to=2026-12-31', { token: c.tokens.driver })).status).toBe(403);
    expect((await api('GET', '/api/reports/ar-aging', { token: c.tokens.driver })).status).toBe(403);
    expect((await api('GET', '/api/reports/pnl?from=bad&to=2026-12-31', { token: c.tokens.owner })).status).toBe(400);
  });
});

describe('bookkeeping isolation', () => {
  it('invoices, expenses, fuel and reports never cross tenants', async () => {
    const x = await makeCarrier('Xeno');
    const invoices = (await api('GET', '/api/invoices', { token: c.tokens.owner })).body.invoices;
    expect((await api('GET', `/api/invoices/${invoices[0].id}`, { token: x.tokens.owner })).status).toBe(404);
    expect((await api('POST', `/api/invoices/${invoices[0].id}/payments`, { token: x.tokens.owner, body: { amount_cents: 1, received_on: today() } })).status).toBe(404);
    expect((await api('GET', '/api/invoices', { token: x.tokens.owner })).body.invoices).toEqual([]);
    expect((await api('GET', '/api/invoices/unbilled', { token: x.tokens.owner })).body.loads).toEqual([]);
    expect((await api('GET', '/api/fuel/transactions', { token: x.tokens.owner })).body.transactions).toEqual([]);
    const tx = (await api('GET', '/api/fuel/transactions', { token: c.tokens.owner })).body.transactions[0];
    expect((await api('PATCH', `/api/fuel/transactions/${tx.id}`, { token: x.tokens.owner, body: { truck_id: null } })).status).toBe(404);
    expect((await api('POST', '/api/expenses', { token: x.tokens.owner, body: { category: 'tires', amount_cents: 1, incurred_on: today(), description: 'x', truck_id: c.truck.id } })).status).toBe(400);
    const pnl = (await api('GET', `/api/reports/pnl?from=2026-01-01&to=${today()}`, { token: x.tokens.owner })).body;
    expect(pnl.total.revenue_cents).toBe(0);
    expect(JSON.stringify(pnl)).not.toContain(c.truck.id);
    expect((await api('GET', '/api/reports/ar-aging', { token: x.tokens.owner })).body.customers).toEqual([]);
  });

  it('drivers cannot reach bookkeeping', async () => {
    for (const path of ['/api/invoices', '/api/expenses', '/api/fuel/transactions', '/api/fuel/cards']) {
      expect((await api('GET', path, { token: c.tokens.driver })).status, path).toBe(403);
    }
  });
});

