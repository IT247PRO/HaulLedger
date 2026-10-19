import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { api, deliveredLoad, makeCarrier, stops, today, upload, type Carrier } from './helpers';

let c: Carrier;
let other: Carrier;
beforeAll(async () => {
  c = await makeCarrier('Network');
  other = await makeCarrier('OtherNetwork');
});
afterEach(() => vi.restoreAllMocks());

/** Mocks outbound fetch; every call is recorded for assertions. */
function mockFetch(handler: (url: string, init: RequestInit) => unknown | Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init: init ?? {} });
    const out = handler(url, init ?? {});
    return out instanceof Response ? out : Response.json(out);
  });
  return calls;
}

describe('integrations', () => {
  it('stores credentials encrypted and never returns them', async () => {
    const res = await api('PUT', '/api/integrations/traccar', { token: c.tokens.owner, body: { config: { base_url: 'https://gps.example.com' }, secret: { token: 'traccar-secret-token' } } });
    expect(res.status).toBe(200);
    const list = await api('GET', '/api/integrations', { token: c.tokens.owner });
    const traccar = list.body.integrations.find((i: any) => i.provider === 'traccar');
    expect(traccar).toMatchObject({ connected: true, config: { base_url: 'https://gps.example.com' } });
    expect(JSON.stringify(list.body)).not.toContain('traccar-secret-token');
    const row = await env.DB.prepare(`SELECT * FROM tenant_integrations WHERE provider = 'traccar'`).first<Record<string, string>>();
    expect(JSON.stringify(row)).not.toContain('traccar-secret-token');
  });

  it('only the owner manages integrations', async () => {
    expect((await api('GET', '/api/integrations', { token: c.tokens.dispatcher })).status).toBe(403);
    expect((await api('PUT', '/api/integrations/samsara', { token: c.tokens.dispatcher, body: { config: {}, secret: { api_token: 'x'.repeat(20) } } })).status).toBe(403);
  });

  it('load boards report that search needs partner access, without pretending', async () => {
    expect((await api('PUT', '/api/integrations/dat', { token: c.tokens.owner, body: { config: {}, secret: { username: 'a', password: 'b' } } })).status).toBe(501);
    const search = await api('GET', '/api/loadboard/search?provider=truckstop', { token: c.tokens.dispatcher });
    expect(search.status).toBe(501);
    expect(search.body.error).toContain('partner');
  });

  it('fails cleanly without the platform key', async () => {
    const res = await api('PUT', '/api/integrations/samsara', { token: c.tokens.owner, body: { config: {}, secret: { api_token: 'x'.repeat(20) } }, env: { INTEGRATIONS_KEY: undefined } });
    expect(res.status).toBe(501);
    expect(res.body.error).toContain('INTEGRATIONS_KEY');
  });
});

describe('GPS (Traccar)', () => {
  it('shows each truck at its last fix, using the stored token', async () => {
    await api('PATCH', `/api/trucks/${c.truck.id}`, { token: c.tokens.owner, body: { traccar_device_id: '7' } });
    const calls = mockFetch((url) =>
      url.endsWith('/api/positions')
        ? [{ id: 1, deviceId: 7, latitude: 32.78, longitude: -96.8, speed: 52.1, course: 90, fixTime: '2026-10-19T10:00:00Z' }, { id: 2, deviceId: 99, latitude: 0, longitude: 0, speed: 0, course: 0, fixTime: '2026-10-19T10:00:00Z' }]
        : [],
    );
    const res = await api('GET', '/api/tracking/positions', { token: c.tokens.dispatcher });
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe('https://gps.example.com/api/positions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer traccar-secret-token');
    const truck = res.body.trucks.find((t: any) => t.id === c.truck.id);
    expect(truck.position).toMatchObject({ latitude: 32.78, speed_mph: 60 });
    expect(JSON.stringify(res.body)).not.toContain('"device_id":"99"'); // devices not mapped to our trucks are not shown
  });

  it('turns vendor failures into clear errors, and is tenant-scoped', async () => {
    mockFetch(() => new Response('nope', { status: 401 }));
    const res = await api('GET', '/api/tracking/positions', { token: c.tokens.owner });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('rejected the credentials');
    // the other carrier has not connected Traccar: it cannot use ours
    expect((await api('GET', '/api/tracking/positions', { token: other.tokens.owner })).status).toBe(501);
    expect((await api('GET', '/api/tracking/positions', { token: c.tokens.driver })).status).toBe(403);
  });

  it("a row copied into another tenant will not decrypt", async () => {
    const otherTenant = (await api('GET', '/api/auth/me', { token: other.tokens.owner })).body.user.tenant_id;
    const row = await env.DB.prepare(`SELECT * FROM tenant_integrations WHERE provider = 'traccar'`).first<Record<string, string>>();
    await env.DB.prepare(`INSERT INTO tenant_integrations (id, tenant_id, provider, config, secret_iv, secret_ct) VALUES ('copy', ?, 'traccar', ?, ?, ?)`)
      .bind(otherTenant, row!.config, row!.secret_iv, row!.secret_ct).run();
    mockFetch(() => []);
    const res = await api('GET', '/api/tracking/positions', { token: other.tokens.owner });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('could not be decrypted');
    await env.DB.prepare(`DELETE FROM tenant_integrations WHERE id = 'copy'`).run();
  });
});

describe('ELD / HOS', () => {
  it('reads clocks from Samsara and matches them to drivers by ELD id', async () => {
    expect((await api('GET', '/api/hos/clocks', { token: c.tokens.dispatcher })).status).toBe(501);
    await api('PUT', '/api/integrations/samsara', { token: c.tokens.owner, body: { config: {}, secret: { api_token: 'samsara-token-123456' } } });
    await api('PATCH', `/api/drivers/${c.driver.id}`, { token: c.tokens.dispatcher, body: { eld_driver_id: '52' } });
    const calls = mockFetch(() => ({
      data: [
        { driver: { id: '52', name: 'Dana' }, currentDutyStatus: { hosStatusType: 'driving' }, clocks: { drive: { driveRemainingDurationMs: 7_200_000 } } },
        { driver: { id: '77', name: 'Somebody Else' }, clocks: {} },
      ],
      pagination: { hasNextPage: false },
    }));
    const res = await api('GET', '/api/hos/clocks', { token: c.tokens.dispatcher });
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe('https://api.samsara.com/fleet/hos/clocks');
    expect(res.body.drivers.find((d: any) => d.driver_id === c.driver.id).clock).toMatchObject({ duty_status: 'driving', drive_remaining_min: 120 });
    expect(res.body.unmapped).toEqual([{ eld_driver_id: '77', name: 'Somebody Else' }]);
  });
});

describe('load board booking', () => {
  it('books a posting into a load, finding or adding the broker by MC', async () => {
    const posting = {
      source: 'dat', posting_id: 'DAT-88112', broker: { name: 'Fast Freight Brokerage', mc_number: 'MC 555123', email: 'ops@fastfreight.test' },
      reference_number: 'FF-77120', rate_cents: 275_000, loaded_miles: 912, commodity: 'Paper', weight_lbs: 40_000, stops,
    };
    const first = await api('POST', '/api/loadboard/book', { token: c.tokens.dispatcher, body: posting });
    expect(first.status).toBe(201);
    const load = (await api('GET', `/api/loads/${first.body.load_id}`, { token: c.tokens.owner })).body.load;
    expect(load).toMatchObject({ status: 'planned', rate_cents: 275_000, reference_number: 'FF-77120', customer_name: 'Fast Freight Brokerage' });
    expect(load.notes).toContain('DAT posting DAT-88112');
    const second = await api('POST', '/api/loadboard/book', { token: c.tokens.dispatcher, body: { ...posting, broker: { name: 'Fast Freight', mc_number: 'mc555123' } } });
    expect(second.body.customer_id).toBe(first.body.customer_id);
    expect((await api('POST', '/api/loadboard/book', { token: c.tokens.driver, body: posting })).status).toBe(403);
  });
});

describe('factoring', () => {
  let invoiceId: string;
  let factorId: string;
  let loadId: string;
  beforeAll(async () => {
    const customer = (await api('POST', '/api/customers', { token: c.tokens.owner, body: { name: 'Factored Shipper' } })).body.customer;
    const load = await deliveredLoad(c, { body: { customer_id: customer.id, rate_cents: 300_000 }, pod: false });
    loadId = load.id;
    invoiceId = (await api('POST', '/api/invoices', { token: c.tokens.owner, body: { customer_id: customer.id, load_ids: [load.id] } })).body.invoice.id;
    factorId = (await api('POST', '/api/factoring/companies', { token: c.tokens.owner, body: { name: 'RTS Financial', submission_email: 'schedules@rts.test', fee_bp: 250 } })).body.company.id;
  });

  it('will not submit without a POD, nor without email configured', async () => {
    const noPod = await api('POST', '/api/factoring/submit', { token: c.tokens.dispatcher, body: { invoice_id: invoiceId, factor_id: factorId } });
    expect(noPod.status).toBe(400);
    expect(noPod.body.error).toContain('POD');
    await upload(c.tokens.owner, { kind: 'pod', load_id: loadId });
    expect((await api('POST', '/api/factoring/submit', { token: c.tokens.dispatcher, body: { invoice_id: invoiceId, factor_id: factorId } })).status).toBe(501);
  });

  it('emails the packet with paperwork attached, once', async () => {
    const calls = mockFetch(() => ({ id: 'email_1' }));
    const emailEnv = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'billing@carrier.test' };
    const res = await api('POST', '/api/factoring/submit', { token: c.tokens.dispatcher, body: { invoice_id: invoiceId, factor_id: factorId }, env: emailEnv });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sent_to: 'schedules@rts.test', attachments: 1 });
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent.to).toBe('schedules@rts.test');
    expect(sent.attachments[0].filename).toContain('pod');
    expect((await api('POST', '/api/factoring/submit', { token: c.tokens.dispatcher, body: { invoice_id: invoiceId, factor_id: factorId }, env: emailEnv })).status).toBe(409);
  });

  it('funding settles the invoice and books the fee', async () => {
    const sub = (await api('GET', '/api/factoring/submissions', { token: c.tokens.owner })).body.submissions[0];
    const res = await api('POST', `/api/factoring/submissions/${sub.id}/funded`, { token: c.tokens.owner, body: { funded_on: today(), reference: 'RTS-55' } });
    expect(res.body).toEqual({ funded_cents: 292_500, fee_cents: 7_500 });
    const inv = (await api('GET', `/api/invoices/${invoiceId}`, { token: c.tokens.owner })).body.invoice;
    expect(inv).toMatchObject({ status: 'paid', balance_cents: 0 });
    const fees = (await api('GET', '/api/expenses?category=factoring_fees', { token: c.tokens.owner })).body.expenses;
    expect(fees).toEqual([expect.objectContaining({ amount_cents: 7_500 })]);
    expect((await api('GET', '/api/factoring/submissions', { token: other.tokens.owner })).body.submissions).toEqual([]);
  });
});

describe('broker CRM', () => {
  it('shows lanes, rates, days-to-pay and AR from real history', async () => {
    const owner = c.tokens.owner;
    const customer = (await api('POST', '/api/customers', { token: owner, body: { name: 'Lane Broker', kind: 'broker', mc_number: 'MC-1' } })).body.customer;
    const lane = (rate: number) => deliveredLoad(c, { body: { customer_id: customer.id, rate_cents: rate, loaded_miles: 500 } });
    const a = await lane(200_000);
    await lane(220_000);
    const inv = (await api('POST', '/api/invoices', { token: owner, body: { customer_id: customer.id, load_ids: [a.id], issued_on: '2026-09-01' } })).body.invoice;
    await api('POST', `/api/invoices/${inv.id}/payments`, { token: owner, body: { amount_cents: 200_000, received_on: '2026-09-29' } });
    await api('POST', `/api/crm/customers/${customer.id}/contacts`, { token: c.tokens.dispatcher, body: { name: 'Jo Ops', role: 'Carrier sales', phone: '555-0100' } });
    await api('POST', `/api/crm/customers/${customer.id}/notes`, { token: c.tokens.dispatcher, body: { body: 'Pays quick-pay at 2%' } });

    const p = (await api('GET', `/api/crm/customers/${customer.id}`, { token: c.tokens.dispatcher })).body;
    expect(p.stats).toMatchObject({ loads: 2, gross_cents: 420_000, rate_per_loaded_mile_cents: 420, avg_days_to_pay: 28 });
    expect(p.lanes).toEqual([expect.objectContaining({ lane: 'Memphis, TN → Chicago, IL', loads: 2, avg_rate_cents: 210_000, rate_per_mile_cents: 420 })]);
    expect(p.contacts[0].name).toBe('Jo Ops');
    expect(p.notes[0].body).toContain('quick-pay');
    expect((await api('GET', `/api/crm/customers/${customer.id}`, { token: other.tokens.owner })).status).toBe(404);
    expect((await api('POST', `/api/crm/customers/${customer.id}/notes`, { token: other.tokens.owner, body: { body: 'x' } })).status).toBe(404);
  });
});

describe('rate calculator', () => {
  it('computes from inputs, with defaults drawn from actuals; owner only', async () => {
    const d = (await api('GET', '/api/rate-calculator/defaults', { token: c.tokens.owner })).body;
    expect(d.window_days).toBe(90);
    expect(d.miles_per_month).toBeGreaterThan(0);
    const res = await api('POST', '/api/rate-calculator', {
      token: c.tokens.owner,
      body: { rate_cents: 250_000, loaded_miles: 781, deadhead_miles: 69, fuel_price_x1000: 3_899, mpg_x100: 650, driver_pay_millicents_per_mile: 60_000, driver_pay_basis: 'all', driver_pay_percent_bp: 0, maintenance_millicents_per_mile: 15_000, tolls_cents: 2_500, fixed_monthly_cents: 600_000, miles_per_month: 10_000 },
    });
    expect(res.body.total_cost_cents).toBe(168_237);
    expect((await api('GET', '/api/rate-calculator/defaults', { token: c.tokens.dispatcher })).status).toBe(403);
  });
});

describe('subscription billing', () => {
  it('is not configured until Stripe keys are set', async () => {
    const status = (await api('GET', '/api/billing', { token: c.tokens.owner })).body;
    expect(status).toMatchObject({ subscription_status: 'none', configured: false, plans: { starter: { monthly_cents: 7_900 }, fleet: { monthly_cents: 12_900 } } });
    expect((await api('POST', '/api/billing/checkout', { token: c.tokens.owner, body: { plan: 'fleet' } })).status).toBe(501);
    expect((await api('GET', '/api/billing', { token: c.tokens.dispatcher })).status).toBe(403);
  });

  it('starts a flat, quantity-1 checkout for the carrier', async () => {
    const calls = mockFetch(() => ({ url: 'https://checkout.stripe.test/s/1' }));
    const res = await api('POST', '/api/billing/checkout', { token: c.tokens.owner, body: { plan: 'fleet' }, env: { STRIPE_SECRET_KEY: 'sk_test_1' } });
    expect(res.body.url).toBe('https://checkout.stripe.test/s/1');
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('line_items[0][price]')).toBe('price_fleet_test');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('mode')).toBe('subscription');
  });

  it('applies signed webhooks once and rejects unsigned ones', async () => {
    const tenantId = (await api('GET', '/api/auth/me', { token: c.tokens.owner })).body.user.tenant_id;
    const post = async (event: unknown, sign = true) => {
      const payload = JSON.stringify(event);
      const t = Math.floor(Date.now() / 1000);
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(sign ? 'whsec_test_secret' : 'wrong'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const res = await app.request('/api/stripe/webhook', { method: 'POST', headers: { 'Stripe-Signature': `t=${t},v1=${sig}` }, body: payload }, env);
      return { status: res.status, body: (await res.json()) as any };
    };
    const completed = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: tenantId, customer: 'cus_1', subscription: 'sub_1' } } };
    expect((await post(completed, false)).status).toBe(400);
    expect((await post(completed)).body).toEqual({ received: true });
    expect((await post(completed)).body).toEqual({ duplicate: true });
    await post({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', metadata: { tenant_id: tenantId }, current_period_end: 1_800_000_000, items: { data: [{ price: { id: 'price_fleet_test' } }] } } } });
    const status = (await api('GET', '/api/billing', { token: c.tokens.owner })).body;
    expect(status).toMatchObject({ subscription_status: 'active', plan: 'fleet', has_customer: true });
    expect(JSON.stringify(status)).not.toContain('cus_1');
    const otherStatus = (await api('GET', '/api/billing', { token: other.tokens.owner })).body;
    expect(otherStatus.subscription_status).toBe('none');
  });
});
