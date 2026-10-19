import { beforeAll, describe, expect, it } from 'vitest';
import { api, makeCarrier, PASSWORD, stops, type Carrier } from './helpers';

let c: Carrier;
beforeAll(async () => {
  c = await makeCarrier('Rbac');
});

describe('driver role', () => {
  it('cannot reach company-wide lists or settings', async () => {
    for (const path of ['/api/drivers', '/api/users', '/api/trucks', '/api/trailers', '/api/customers', '/api/alerts/expirations']) {
      expect((await api('GET', path, { token: c.tokens.driver })).status, path).toBe(403);
    }
  });

  it('sees only their own loads, never the linehaul rate', async () => {
    await api('POST', '/api/loads', {
      token: c.tokens.owner,
      body: { driver_id: c.otherDriver.id, rate_cents: 999_999, stops },
    });
    const list = await api('GET', '/api/loads', { token: c.tokens.driver });
    expect(list.status).toBe(200);
    expect(list.body.loads.map((l: any) => l.id)).toEqual([c.load.id]);
    expect(list.body.loads[0]).not.toHaveProperty('rate_cents');

    const one = await api('GET', `/api/loads/${c.load.id}`, { token: c.tokens.driver });
    expect(one.status).toBe(200);
    expect(one.body.load).not.toHaveProperty('rate_cents');
    expect(JSON.stringify(one.body)).not.toContain('250000');
  });

  it("cannot open another driver's load or profile, even by filtering", async () => {
    const other = await api('POST', '/api/loads', { token: c.tokens.owner, body: { driver_id: c.otherDriver.id, stops } });
    expect((await api('GET', `/api/loads/${other.body.load.id}`, { token: c.tokens.driver })).status).toBe(404);
    expect((await api('GET', `/api/drivers/${c.otherDriver.id}`, { token: c.tokens.driver })).status).toBe(404);
    const filtered = await api('GET', `/api/loads?driver_id=${c.otherDriver.id}`, { token: c.tokens.driver });
    expect(filtered.body.loads.every((l: any) => l.driver_id === c.driver.id)).toBe(true);
  });

  it('can read their own profile', async () => {
    const res = await api('GET', `/api/drivers/${c.driver.id}`, { token: c.tokens.driver });
    expect(res.status).toBe(200);
  });

  it('cannot create or edit loads, or change pay track', async () => {
    expect((await api('POST', '/api/loads', { token: c.tokens.driver, body: { stops } })).status).toBe(403);
    expect((await api('PATCH', `/api/loads/${c.load.id}`, { token: c.tokens.driver, body: { rate_cents: 1 } })).status).toBe(403);
    expect((await api('PATCH', `/api/drivers/${c.driver.id}`, { token: c.tokens.driver, body: { pay_track: 'w2' } })).status).toBe(403);
    expect((await api('DELETE', `/api/loads/${c.load.id}`, { token: c.tokens.driver })).status).toBe(403);
  });

  it('can only advance their own load along the road, not dispatch it', async () => {
    expect((await api('POST', `/api/loads/${c.load.id}/status`, { token: c.tokens.driver, body: { status: 'dispatched' } })).status).toBe(403);
    await api('POST', `/api/loads/${c.load.id}/status`, { token: c.tokens.owner, body: { status: 'dispatched' } });
    expect((await api('POST', `/api/loads/${c.load.id}/status`, { token: c.tokens.driver, body: { status: 'cancelled' } })).status).toBe(403);
    for (const status of ['at_pickup', 'in_transit', 'delivered']) {
      const res = await api('POST', `/api/loads/${c.load.id}/status`, { token: c.tokens.driver, body: { status } });
      expect(res.status, status).toBe(200);
      expect(res.body.load).not.toHaveProperty('rate_cents');
    }
  });
});

describe('dispatcher role', () => {
  it('runs dispatch: equipment, customers, loads', async () => {
    expect((await api('POST', '/api/trucks', { token: c.tokens.dispatcher, body: { unit_number: '202' } })).status).toBe(201);
    expect((await api('POST', '/api/customers', { token: c.tokens.dispatcher, body: { name: 'New Broker' } })).status).toBe(201);
    expect((await api('POST', '/api/loads', { token: c.tokens.dispatcher, body: { stops } })).status).toBe(201);
    expect((await api('GET', '/api/drivers', { token: c.tokens.dispatcher })).status).toBe(200);
  });

  it('can maintain license and medical dates', async () => {
    const res = await api('PATCH', `/api/drivers/${c.driver.id}`, { token: c.tokens.dispatcher, body: { medical_expires_on: '2031-05-01' } });
    expect(res.status).toBe(200);
    expect(res.body.driver.medical_expires_on).toBe('2031-05-01');
  });

  it('cannot change pay track, hire drivers, or manage logins', async () => {
    expect((await api('PATCH', `/api/drivers/${c.driver.id}`, { token: c.tokens.dispatcher, body: { pay_track: 'w2' } })).status).toBe(403);
    expect((await api('POST', '/api/drivers', { token: c.tokens.dispatcher, body: { first_name: 'A', last_name: 'B', pay_track: 'w2' } })).status).toBe(403);
    expect((await api('GET', '/api/users', { token: c.tokens.dispatcher })).status).toBe(403);
    expect((await api('POST', '/api/users', {
      token: c.tokens.dispatcher,
      body: { email: 'x@rbac.test', name: 'X', role: 'owner', password: PASSWORD },
    })).status).toBe(403);
  });
});

describe('owner role', () => {
  it('can change pay track', async () => {
    const res = await api('PATCH', `/api/drivers/${c.otherDriver.id}`, { token: c.tokens.owner, body: { pay_track: '1099' } });
    expect(res.status).toBe(200);
    expect(res.body.driver.pay_track).toBe('1099');
  });
});
