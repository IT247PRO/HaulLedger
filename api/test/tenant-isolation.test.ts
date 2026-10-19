import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, makeCarrier, stops, type Carrier } from './helpers';

// Tenant A must never read, change, or reference anything belonging to tenant B,
// whatever its role and however it phrases the request.
let a: Carrier;
let b: Carrier;

beforeAll(async () => {
  a = await makeCarrier('Alpha');
  b = await makeCarrier('Bravo');
});

const roles = ['owner', 'dispatcher', 'driver'] as const;

describe('reads', () => {
  const resources = [
    ['drivers', (c: Carrier) => c.driver.id],
    ['trucks', (c: Carrier) => c.truck.id],
    ['trailers', (c: Carrier) => c.trailer.id],
    ['customers', (c: Carrier) => c.customer.id],
    ['loads', (c: Carrier) => c.load.id],
  ] as const;

  for (const [resource, idOf] of resources) {
    for (const role of roles) {
      it(`${role} of A cannot fetch B's ${resource} by id`, async () => {
        const res = await api('GET', `/api/${resource}/${idOf(b)}`, { token: a.tokens[role] });
        expect([403, 404]).toContain(res.status);
        expect(JSON.stringify(res.body)).not.toContain(idOf(b));
      });
    }

    it(`A's ${resource} list never contains B's rows`, async () => {
      const res = await api('GET', `/api/${resource}`, { token: a.tokens.owner });
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).toContain(idOf(a));
      expect(body).not.toContain(idOf(b));
    });
  }

  it("A's user list never contains B's users", async () => {
    const res = await api('GET', '/api/users', { token: a.tokens.owner });
    expect(res.body.users.length).toBe(3);
    expect(JSON.stringify(res.body)).not.toContain('Bravo');
  });

  it("A's expiration alerts never mention B's drivers", async () => {
    await api('PATCH', `/api/drivers/${b.driver.id}`, { token: b.tokens.owner, body: { medical_expires_on: '2020-01-01' } });
    const res = await api('GET', '/api/alerts/expirations', { token: a.tokens.owner });
    expect(JSON.stringify(res.body)).not.toContain(b.driver.id);
    const own = await api('GET', '/api/alerts/expirations', { token: b.tokens.owner });
    expect(JSON.stringify(own.body)).toContain(b.driver.id);
  });

  it('a driver filter cannot be pointed at another tenant', async () => {
    const res = await api('GET', `/api/loads?driver_id=${b.driver.id}`, { token: a.tokens.owner });
    expect(res.body.loads).toEqual([]);
  });
});

describe('writes', () => {
  it("A cannot update B's records", async () => {
    const attempts = [
      api('PATCH', `/api/drivers/${b.driver.id}`, { token: a.tokens.owner, body: { first_name: 'Hacked' } }),
      api('PATCH', `/api/trucks/${b.truck.id}`, { token: a.tokens.owner, body: { make: 'Hacked' } }),
      api('PATCH', `/api/trailers/${b.trailer.id}`, { token: a.tokens.owner, body: { plate: 'HACKED' } }),
      api('PATCH', `/api/customers/${b.customer.id}`, { token: a.tokens.owner, body: { name: 'Hacked' } }),
      api('PATCH', `/api/loads/${b.load.id}`, { token: a.tokens.owner, body: { rate_cents: 1 } }),
      api('POST', `/api/loads/${b.load.id}/status`, { token: a.tokens.owner, body: { status: 'cancelled' } }),
      api('DELETE', `/api/loads/${b.load.id}`, { token: a.tokens.owner }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);

    const load = await api('GET', `/api/loads/${b.load.id}`, { token: b.tokens.owner });
    expect(load.body.load.rate_cents).toBe(250_000);
    expect(load.body.load.status).toBe('planned');
    const driver = await api('GET', `/api/drivers/${b.driver.id}`, { token: b.tokens.owner });
    expect(driver.body.driver.first_name).toBe('Dana');
  });

  it("A cannot edit or remove B's users", async () => {
    const bUsers = await api('GET', '/api/users', { token: b.tokens.owner });
    const target = bUsers.body.users[0].id;
    expect((await api('PATCH', `/api/users/${target}`, { token: a.tokens.owner, body: { password: 'x'.repeat(12) } })).status).toBe(404);
    expect((await api('DELETE', `/api/users/${target}`, { token: a.tokens.owner })).status).toBe(404);
  });

  it("A cannot attach B's driver, truck, trailer or customer to a load", async () => {
    for (const ref of [
      { driver_id: b.driver.id },
      { truck_id: b.truck.id },
      { trailer_id: b.trailer.id },
      { customer_id: b.customer.id },
    ]) {
      const created = await api('POST', '/api/loads', { token: a.tokens.owner, body: { ...ref, stops } });
      expect(created.status).toBe(400);
      const patched = await api('PATCH', `/api/loads/${a.load.id}`, { token: a.tokens.owner, body: ref });
      expect(patched.status).toBe(400);
    }
  });

  it("A cannot create a login bound to B's driver", async () => {
    const res = await api('POST', '/api/users', {
      token: a.tokens.owner,
      body: { email: 'sneaky@alpha.test', name: 'Sneaky', role: 'driver', driver_id: b.driver.id, password: 'x'.repeat(12) },
    });
    expect(res.status).toBe(400);
  });

  it('tenant_id in a request body is rejected, not honoured', async () => {
    const res = await api('POST', '/api/trucks', { token: a.tokens.owner, body: { unit_number: '999', tenant_id: 'x' } });
    expect(res.status).toBe(400);
  });
});

describe('database guarantees', () => {
  it('composite foreign keys reject a cross-tenant reference even if the API is bypassed', async () => {
    const tenantA = (await api('GET', '/api/auth/me', { token: a.tokens.owner })).body.user.tenant_id;
    await expect(
      env.DB.prepare(`INSERT INTO loads (id, tenant_id, load_number, driver_id) VALUES ('x', ?, 'X-1', ?)`)
        .bind(tenantA, b.driver.id)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('every table except tenants carries a NOT NULL tenant_id', async () => {
    const { results: tables } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('tenants', 'd1_migrations')`,
    ).all<{ name: string }>();
    expect(tables.length).toBeGreaterThan(5);
    for (const { name } of tables) {
      const { results: cols } = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string; notnull: number }>();
      const tenant = cols.find((c) => c.name === 'tenant_id');
      expect(tenant, `${name}.tenant_id`).toBeDefined();
      expect(tenant?.notnull, `${name}.tenant_id NOT NULL`).toBe(1);
    }
  });
});
