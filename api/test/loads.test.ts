import { beforeAll, describe, expect, it } from 'vitest';
import { api, makeCarrier, stops, type Carrier } from './helpers';

let c: Carrier;
beforeAll(async () => {
  c = await makeCarrier('Loads');
});

const move = (id: string, status: string) => api('POST', `/api/loads/${id}/status`, { token: c.tokens.owner, body: { status } });

describe('loads', () => {
  it('numbers loads automatically and keeps explicit numbers unique', async () => {
    const auto = await api('POST', '/api/loads', { token: c.tokens.owner, body: { stops } });
    expect(auto.body.load.load_number).toBe('L-1002');
    expect((await api('POST', '/api/loads', { token: c.tokens.owner, body: { load_number: 'L-1002', stops } })).status).toBe(409);
  });

  it('requires a pickup first and a delivery last', async () => {
    const bad = [
      [],
      [{ kind: 'pickup', city: 'A', state: 'TX' }],
      [{ kind: 'delivery', city: 'A', state: 'TX' }, { kind: 'delivery', city: 'B', state: 'GA' }],
      [{ kind: 'pickup', city: 'A', state: 'TX' }, { kind: 'pickup', city: 'B', state: 'GA' }],
    ];
    for (const s of bad) expect((await api('POST', '/api/loads', { token: c.tokens.owner, body: { stops: s } })).status).toBe(400);
  });

  it('rejects fractional or negative money', async () => {
    expect((await api('POST', '/api/loads', { token: c.tokens.owner, body: { rate_cents: 100.5, stops } })).status).toBe(400);
    expect((await api('POST', '/api/loads', { token: c.tokens.owner, body: { rate_cents: -1, stops } })).status).toBe(400);
  });

  it('will not dispatch without a driver and truck', async () => {
    const load = (await api('POST', '/api/loads', { token: c.tokens.owner, body: { stops } })).body.load;
    expect((await move(load.id, 'dispatched')).status).toBe(400);
    await api('PATCH', `/api/loads/${load.id}`, { token: c.tokens.owner, body: { driver_id: c.driver.id, truck_id: c.truck.id } });
    expect((await move(load.id, 'dispatched')).status).toBe(200);
    // ...and a dispatched load cannot lose them.
    expect((await api('PATCH', `/api/loads/${load.id}`, { token: c.tokens.owner, body: { driver_id: null } })).status).toBe(400);
  });

  it('walks pickup to delivery, stamps times, and records who moved it', async () => {
    const load = (await api('POST', '/api/loads', {
      token: c.tokens.owner,
      body: { driver_id: c.driver.id, truck_id: c.truck.id, stops },
    })).body.load;
    expect((await move(load.id, 'delivered')).status).toBe(400); // cannot skip steps
    for (const s of ['dispatched', 'at_pickup', 'in_transit', 'delivered']) expect((await move(load.id, s)).status, s).toBe(200);
    expect((await move(load.id, 'cancelled')).status).toBe(400); // delivered is final

    const detail = (await api('GET', `/api/loads/${load.id}`, { token: c.tokens.owner })).body.load;
    expect(detail.status).toBe('delivered');
    expect(detail.dispatched_at).toBeTruthy();
    expect(detail.delivered_at).toBeTruthy();
    expect(detail.events.map((e: any) => e.to_status)).toEqual(['planned', 'dispatched', 'at_pickup', 'in_transit', 'delivered']);
    expect(detail.events[1].user_name).toBe('Loads Owner');
    expect((await api('DELETE', `/api/loads/${load.id}`, { token: c.tokens.owner })).status).toBe(409);
  });

  it('replaces stops on update and reports origin/destination', async () => {
    const load = (await api('POST', '/api/loads', { token: c.tokens.owner, body: { stops } })).body.load;
    const res = await api('PATCH', `/api/loads/${load.id}`, {
      token: c.tokens.owner,
      body: {
        stops: [
          { kind: 'pickup', city: 'Laredo', state: 'tx' },
          { kind: 'delivery', city: 'Joliet', state: 'IL' },
          { kind: 'delivery', city: 'Gary', state: 'IN' },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.load.stops.map((s: any) => s.seq)).toEqual([1, 2, 3]);
    expect(res.body.load.origin).toBe('Laredo, TX');
    expect(res.body.load.destination).toBe('Gary, IN');
  });

  it('deletes planned loads', async () => {
    const load = (await api('POST', '/api/loads', { token: c.tokens.owner, body: { stops } })).body.load;
    expect((await api('DELETE', `/api/loads/${load.id}`, { token: c.tokens.owner })).status).toBe(204);
    expect((await api('GET', `/api/loads/${load.id}`, { token: c.tokens.owner })).status).toBe(404);
  });
});

describe('expiration alerts', () => {
  it('flags expired and soon-expiring licenses and medical cards for active drivers', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const d1 = (await api('POST', '/api/drivers', {
      token: c.tokens.owner,
      body: { first_name: 'Exp', last_name: 'Ired', pay_track: 'w2', medical_expires_on: '2020-01-01', license_expires_on: soon },
    })).body.driver;
    await api('POST', '/api/drivers', {
      token: c.tokens.owner,
      body: { first_name: 'Gone', last_name: 'Driver', pay_track: 'w2', status: 'inactive', medical_expires_on: '2020-01-01' },
    });
    const res = await api('GET', '/api/alerts/expirations', { token: c.tokens.dispatcher });
    expect(res.status).toBe(200);
    const mine = res.body.alerts.filter((a: any) => a.driver_id === d1.id);
    expect(mine).toEqual([
      expect.objectContaining({ kind: 'medical', expired: true }),
      expect.objectContaining({ kind: 'license', expired: false, expires_on: soon }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain('Gone Driver');
    expect(JSON.stringify(res.body)).not.toContain(c.driver.id); // expires 2030
  });
});
