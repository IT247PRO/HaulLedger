import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, deliveredLoad, fetchRaw, makeCarrier, PASSWORD, today, upload, type Carrier } from './helpers';

// The wedge: a settlement where every dollar traces to a record the driver can check.
let c: Carrier;
beforeAll(async () => {
  c = await makeCarrier('Settle');
});

const owner = () => c.tokens.owner;
const generate = (driverId: string, extra: Record<string, unknown> = {}) =>
  api('POST', '/api/settlements', { token: owner(), body: { driver_id: driverId, period_start: '2026-01-01', period_end: today(), ...extra } });

async function newDriver(pay_track: 'w2' | '1099', extra: Record<string, unknown> = {}) {
  const driver = (await api('POST', '/api/drivers', { token: owner(), body: { first_name: 'Pat', last_name: `${pay_track}-${Math.random()}`, pay_track, ...extra } })).body.driver;
  const email = `${driver.id}@settle.test`;
  await api('POST', '/api/users', { token: owner(), body: { email, name: 'Pat', role: 'driver', driver_id: driver.id, password: PASSWORD } });
  const token = (await api('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).body.token as string;
  return { driver, token };
}
const addRate = (driverId: string, body: Record<string, unknown>) =>
  api('POST', '/api/pay-rates', { token: owner(), body: { driver_id: driverId, effective_from: '2026-01-01', ...body } });

describe('1099 owner-operator settlement', () => {
  let d: Awaited<ReturnType<typeof newDriver>>;
  let settlement: any;
  let loadA: { id: string; load_number: string };
  let heldLoad: { id: string; load_number: string };

  beforeAll(async () => {
    d = await newDriver('1099', { escrow_target_cents: 250_000, escrow_per_settlement_cents: 10_000 });
    expect((await addRate(d.driver.id, { kind: 'percent', rate: 2_800 })).status).toBe(201);
    expect((await addRate(d.driver.id, { kind: 'per_stop', rate: 5_000, basis: 'extra' })).status).toBe(201);

    loadA = await deliveredLoad(c, {
      driverId: d.driver.id,
      driverToken: d.token, // the driver uploads the POD from their phone
      body: {
        rate_cents: 250_000,
        fuel_surcharge_cents: 31_250,
        accessorial_cents: 7_500,
        stops: [
          { kind: 'pickup', city: 'Dallas', state: 'TX' },
          { kind: 'delivery', city: 'Shreveport', state: 'LA' },
          { kind: 'delivery', city: 'Atlanta', state: 'GA' },
        ],
      },
    });
    await upload(owner(), { kind: 'rate_confirmation', load_id: loadA.id });
    heldLoad = await deliveredLoad(c, { driverId: d.driver.id, pod: false });

    await api('POST', '/api/advances', { token: owner(), body: { driver_id: d.driver.id, amount_cents: 20_000, issued_on: today(), method: 'comchek', reference: 'CK-881' } });
    await api('POST', '/api/charges', { token: owner(), body: { driver_id: d.driver.id, category: 'fuel', amount_cents: 41_234, incurred_on: today(), description: 'Pilot #412 Texarkana' } });
    await api('POST', '/api/recurring-deductions', { token: owner(), body: { driver_id: d.driver.id, category: 'occupational_accident', amount_cents: 3_850, description: 'Occ/Acc policy weekly' } });
    const receipt = await upload(d.token, { kind: 'lumper', load_id: loadA.id });
    const reimb = await api('POST', '/api/reimbursements', {
      token: d.token,
      body: { category: 'lumper', amount_cents: 7_500, incurred_on: today(), description: 'Lumper at Atlanta DC', load_id: loadA.id, document_id: receipt.body.document.id },
    });
    expect(reimb.body.reimbursement.status).toBe('pending');
    await api('PATCH', `/api/reimbursements/${reimb.body.reimbursement.id}`, { token: owner(), body: { status: 'approved' } });

    const res = await generate(d.driver.id);
    expect(res.status).toBe(201);
    settlement = res.body.settlement;
    expect(res.body.warnings).toEqual([`${heldLoad.load_number}: held — no POD on file`]);
  });

  it('pays the load per its rates with gross, percentage and amount on the line', () => {
    const pay = settlement.lines.filter((l: any) => l.kind === 'load_pay');
    expect(pay).toHaveLength(2);
    const percent = pay.find((l: any) => l.pay_kind === 'percent');
    // 28% of (2,500.00 + 312.50 + 75.00) = 808.50
    expect(percent).toMatchObject({ load_id: loadA.id, gross_cents: 288_750, rate_bp: 2_800, amount_cents: 80_850 });
    const stop = pay.find((l: any) => l.pay_kind === 'per_stop');
    expect(stop).toMatchObject({ quantity: 1, amount_cents: 5_000 });
  });

  it('itemizes advances, deductions, reimbursements and escrow — nothing lumped', () => {
    const byKind = (k: string) => settlement.lines.filter((l: any) => l.kind === k);
    expect(byKind('advance')).toEqual([expect.objectContaining({ amount_cents: -20_000, advance_id: expect.any(String) })]);
    expect(byKind('advance')[0].description).toContain('comchek #CK-881');
    expect(byKind('deduction').map((l: any) => [l.charge_category, l.amount_cents]).sort()).toEqual([
      ['fuel', -41_234],
      ['occupational_accident', -3_850],
    ]);
    expect(byKind('reimbursement')).toEqual([expect.objectContaining({ amount_cents: 7_500, reimbursement_category: 'lumper' })]);
    expect(byKind('escrow_hold')).toEqual([expect.objectContaining({ amount_cents: -10_000 })]);
  });

  it('every line cites its source record', () => {
    for (const l of settlement.lines) {
      const source = { load_pay: l.load_id && l.pay_rate_id, per_diem: l.load_id, reimbursement: l.reimbursement_id, advance: l.advance_id, deduction: l.charge_id, escrow_hold: l.escrow_tx_id, escrow_release: l.escrow_tx_id }[l.kind as string];
      expect(source, `${l.kind}: ${l.description}`).toBeTruthy();
    }
  });

  it('totals are the exact sum of the lines', () => {
    const net = settlement.lines.reduce((a: number, l: any) => a + l.amount_cents, 0);
    expect(settlement.net_cents).toBe(net);
    // 808.50 + 50.00 + 75.00 - 200.00 - 412.34 - 38.50 - 100.00 = 182.66
    expect(net).toBe(18_266);
    expect(settlement.load_pay_cents).toBe(85_850);
  });

  it('the database refuses a line with no source', async () => {
    await expect(
      env.DB.prepare(`INSERT INTO settlement_lines (id, tenant_id, settlement_id, seq, kind, description, amount_cents) VALUES ('x', ?, ?, 99, 'deduction', 'misc', -100)`)
        .bind(settlement.tenant_id, settlement.id)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it('drafts are hidden from the driver; finalize publishes them', async () => {
    expect((await api('GET', `/api/settlements/${settlement.id}`, { token: d.token })).status).toBe(404);
    expect((await api('GET', '/api/settlements', { token: d.token })).body.settlements).toEqual([]);
    const fin = await api('POST', `/api/settlements/${settlement.id}/finalize`, { token: owner() });
    expect(fin.status).toBe(200);
    expect(fin.body.settlement.status).toBe('finalized');
    expect((await api('GET', '/api/settlements', { token: d.token })).body.settlements).toHaveLength(1);
  });

  it('the driver can verify each pay line: load, lane, miles, POD and — for percentage pay — the rate confirmation', async () => {
    const res = await api('GET', `/api/settlements/${settlement.id}`, { token: d.token });
    expect(res.status).toBe(200);
    const load = res.body.settlement.loads[loadA.id];
    expect(load).toMatchObject({ load_number: loadA.load_number, origin: 'Dallas, TX', destination: 'Atlanta, GA', stop_count: 3, rate_cents: 250_000 });
    const kinds = load.documents.map((x: any) => x.kind).sort();
    expect(kinds).toEqual(['lumper', 'pod', 'rate_confirmation']);
    const rc = load.documents.find((x: any) => x.kind === 'rate_confirmation');
    expect((await fetchRaw(d.token, `/api/documents/${rc.id}/file`)).status).toBe(200);
  });

  it('escrow balance counts the hold once finalized', async () => {
    const ledger = await api('GET', '/api/escrow', { token: d.token });
    expect(ledger.body.balance_cents).toBe(10_000);
    expect(ledger.body.ledger).toEqual([expect.objectContaining({ kind: 'hold', amount_cents: 10_000, balance_cents: 10_000 })]);
  });

  it('nothing is paid twice: the next settlement picks up only what is new', async () => {
    await upload(owner(), { kind: 'pod', load_id: heldLoad.id }); // paperwork arrives late
    const next = await generate(d.driver.id);
    expect(next.status).toBe(201);
    const lines = next.body.settlement.lines;
    expect(lines.filter((l: any) => l.kind === 'load_pay').every((l: any) => l.load_id === heldLoad.id)).toBe(true);
    expect(lines.some((l: any) => l.advance_id)).toBe(false);
    // the recurring deduction recurs; the one-off fuel charge does not
    expect(lines.filter((l: any) => l.kind === 'deduction').map((l: any) => l.charge_category)).toEqual(['occupational_accident']);
    await api('DELETE', `/api/settlements/${next.body.settlement.id}`, { token: owner() });
  });

  it('finalized settlements cannot be deleted or regenerated', async () => {
    expect((await api('DELETE', `/api/settlements/${settlement.id}`, { token: owner() })).status).toBe(409);
    expect((await api('POST', `/api/settlements/${settlement.id}/finalize`, { token: owner() })).status).toBe(409);
    expect((await api('POST', `/api/settlements/${settlement.id}/mark-paid`, { token: owner() })).body.settlement.status).toBe('paid');
  });
});

describe('drafts', () => {
  it('deleting a draft frees its sources for the next settlement', async () => {
    const d = await newDriver('1099', { escrow_target_cents: 100_000, escrow_per_settlement_cents: 5_000 });
    await addRate(d.driver.id, { kind: 'per_mile', rate: 60_000, basis: 'loaded' });
    await deliveredLoad(c, { driverId: d.driver.id });
    await api('POST', '/api/advances', { token: owner(), body: { driver_id: d.driver.id, amount_cents: 5_000, issued_on: today() } });
    await api('POST', '/api/recurring-deductions', { token: owner(), body: { driver_id: d.driver.id, category: 'eld', amount_cents: 1_500, description: 'ELD' } });

    const first = (await generate(d.driver.id)).body.settlement;
    expect((await generate(d.driver.id)).status).toBe(409); // one draft at a time
    expect((await api('DELETE', `/api/settlements/${first.id}`, { token: owner() })).status).toBe(204);
    const again = (await generate(d.driver.id)).body.settlement;
    expect(again.net_cents).toBe(first.net_cents);
    expect(again.lines.map((l: any) => l.kind)).toEqual(first.lines.map((l: any) => l.kind));
    // the deleted draft's generated charge and escrow hold are gone, not orphaned
    const charges = await env.DB.prepare('SELECT COUNT(*) AS n FROM driver_charges WHERE driver_id = ?').bind(d.driver.id).first<{ n: number }>();
    expect(charges?.n).toBe(1);
    const holds = await env.DB.prepare(`SELECT COUNT(*) AS n FROM escrow_transactions WHERE driver_id = ? AND kind = 'hold'`).bind(d.driver.id).first<{ n: number }>();
    expect(holds?.n).toBe(1);
  });
});

describe('deficits', () => {
  it('a negative net carries forward to the next settlement as a sourced charge', async () => {
    const d = await newDriver('1099');
    await addRate(d.driver.id, { kind: 'per_mile', rate: 50_000, basis: 'loaded' });
    await deliveredLoad(c, { driverId: d.driver.id }); // 500 mi × $0.50 = $250
    await api('POST', '/api/advances', { token: owner(), body: { driver_id: d.driver.id, amount_cents: 40_000, issued_on: today() } });
    const s1 = (await generate(d.driver.id)).body.settlement;
    expect(s1.net_cents).toBe(-15_000);
    await api('POST', `/api/settlements/${s1.id}/finalize`, { token: owner() });

    await deliveredLoad(c, { driverId: d.driver.id });
    const s2 = (await generate(d.driver.id)).body.settlement;
    const deficit = s2.lines.find((l: any) => l.charge_category === 'deficit');
    expect(deficit).toMatchObject({ amount_cents: -15_000 });
    expect(deficit.description).toContain(s1.settlement_number);
    expect(s2.net_cents).toBe(25_000 - 15_000);
  });
});

describe('W-2 company driver', () => {
  it('gets per diem and payroll-style deductions, never escrow or lease charges', async () => {
    const d = await newDriver('w2');
    await addRate(d.driver.id, { kind: 'per_mile', rate: 58_000, basis: 'all' });
    expect((await addRate(d.driver.id, { kind: 'per_diem', rate: 6_900 })).status).toBe(201);
    expect((await api('POST', '/api/charges', { token: owner(), body: { driver_id: d.driver.id, category: 'truck_lease', amount_cents: 100, incurred_on: today(), description: 'x' } })).status).toBe(400);
    expect((await api('POST', '/api/charges', { token: owner(), body: { driver_id: d.driver.id, category: 'garnishment', amount_cents: 12_500, incurred_on: today(), description: 'Order #44-1' } })).status).toBe(201);
    expect((await api('PATCH', `/api/drivers/${d.driver.id}`, { token: owner(), body: { escrow_per_settlement_cents: 100 } })).status).toBe(400);
    expect((await api('POST', '/api/escrow', { token: owner(), body: { driver_id: d.driver.id, kind: 'interest', amount_cents: 100, occurred_on: today(), memo: 'x' } })).status).toBe(400);

    await deliveredLoad(c, { driverId: d.driver.id });
    const s = (await generate(d.driver.id)).body.settlement;
    expect(s.pay_track).toBe('w2');
    expect(s.lines.find((l: any) => l.kind === 'per_diem')).toMatchObject({ quantity: 1, quantity_unit: 'days', amount_cents: 6_900 });
    expect(s.lines.find((l: any) => l.kind === 'load_pay')).toMatchObject({ quantity: 540, amount_cents: 31_320 });
    expect(s.lines.some((l: any) => l.kind.startsWith('escrow'))).toBe(false);
    expect(s.escrow_balance_cents).toBeNull();
  });

  it('1099 contractors cannot get per diem or garnishments', async () => {
    const d = await newDriver('1099');
    expect((await addRate(d.driver.id, { kind: 'per_diem', rate: 6_900 })).status).toBe(400);
    expect((await api('POST', '/api/charges', { token: owner(), body: { driver_id: d.driver.id, category: 'garnishment', amount_cents: 100, incurred_on: today(), description: 'x' } })).status).toBe(400);
  });

  it('pay track cannot change while a draft is open', async () => {
    const d = await newDriver('w2');
    await addRate(d.driver.id, { kind: 'per_mile', rate: 58_000, basis: 'all' });
    await deliveredLoad(c, { driverId: d.driver.id });
    await generate(d.driver.id);
    expect((await api('PATCH', `/api/drivers/${d.driver.id}`, { token: owner(), body: { pay_track: '1099' } })).status).toBe(409);
  });
});

describe('pay rates', () => {
  it('mix freely by kind but never overlap within a kind', async () => {
    const d = await newDriver('1099');
    expect((await addRate(d.driver.id, { kind: 'per_mile', rate: 50_000, basis: 'loaded', effective_to: '2026-06-30' })).status).toBe(201);
    expect((await addRate(d.driver.id, { kind: 'per_mile', rate: 55_000, basis: 'loaded', effective_from: '2026-06-01' })).status).toBe(409);
    expect((await addRate(d.driver.id, { kind: 'per_mile', rate: 55_000, basis: 'loaded', effective_from: '2026-07-01' })).status).toBe(201);
    expect((await addRate(d.driver.id, { kind: 'hourly', rate: 2_500 })).status).toBe(201);
    expect((await addRate(d.driver.id, { kind: 'percent', rate: 10_001 })).status).toBe(400);
    expect((await addRate(d.driver.id, { kind: 'per_mile', rate: 1 })).status).toBe(400); // basis required
  });

  it('a load with no rate in effect is held, not paid at a guessed rate', async () => {
    const d = await newDriver('1099');
    const load = await deliveredLoad(c, { driverId: d.driver.id });
    const res = await generate(d.driver.id);
    expect(res.body.warnings[0]).toContain(`${load.load_number}: held — no pay rate`);
    expect(res.body.settlement.lines).toEqual([]);
  });
});

describe('settlement access', () => {
  it('drivers see only their own; dispatchers see none', async () => {
    const a = await newDriver('1099');
    const b = await newDriver('1099');
    await addRate(a.driver.id, { kind: 'per_mile', rate: 50_000, basis: 'loaded' });
    await deliveredLoad(c, { driverId: a.driver.id });
    const s = (await generate(a.driver.id)).body.settlement;
    await api('POST', `/api/settlements/${s.id}/finalize`, { token: owner() });

    expect((await api('GET', `/api/settlements/${s.id}`, { token: b.token })).status).toBe(404);
    expect((await api('GET', '/api/settlements', { token: b.token })).body.settlements).toEqual([]);
    expect((await api('GET', `/api/settlements?driver_id=${a.driver.id}`, { token: b.token })).body.settlements).toEqual([]);
    expect((await api('GET', '/api/settlements', { token: c.tokens.dispatcher })).status).toBe(403);
    expect((await api('GET', `/api/settlements/${s.id}`, { token: c.tokens.dispatcher })).status).toBe(403);
    expect((await api('POST', '/api/settlements', { token: c.tokens.dispatcher, body: { driver_id: a.driver.id, period_start: '2026-01-01', period_end: today() } })).status).toBe(403);
    expect((await api('GET', `/api/pay-rates?driver_id=${a.driver.id}`, { token: b.token })).body.pay_rates).toEqual([]);
    expect((await api('GET', '/api/pay-rates', { token: a.token })).body.pay_rates).toHaveLength(1);
    expect((await api('GET', '/api/pay-rates', { token: c.tokens.dispatcher })).status).toBe(403);
    expect((await api('POST', '/api/pay-rates', { token: c.tokens.dispatcher, body: { driver_id: a.driver.id, kind: 'hourly', rate: 1, effective_from: '2026-01-01' } })).status).toBe(403);
    expect((await api('GET', `/api/escrow?driver_id=${a.driver.id}`, { token: b.token })).body.driver_id).toBe(b.driver.id);
  });

  it('email fails cleanly when not configured', async () => {
    const list = await api('GET', '/api/settlements', { token: owner() });
    const finalized = list.body.settlements.find((s: any) => s.status !== 'draft');
    const res = await api('POST', `/api/settlements/${finalized.id}/email`, { token: owner() });
    expect(res.status).toBe(501);
    expect(res.body.error).toContain('not configured');
  });
});
