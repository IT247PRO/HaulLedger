import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { uniqueGuard } from '../lib/crud';
import { insertRow, newId, notFound, nowIso } from '../lib/http';
import { decryptSecret, encryptSecret } from '../lib/secrets';
import { body, cents, optText, usState } from '../lib/validate';
import { motiveClocks, samsaraClocks, type HosClock } from '../integrations/eld';
import { normalizePosition, traccarDevices, traccarPositions, type TraccarConfig, type TraccarSecret } from '../integrations/traccar';

export const integrations = new Hono<AppEnv>();
export const tracking = new Hono<AppEnv>();
export const hos = new Hono<AppEnv>();
export const loadboard = new Hono<AppEnv>();

type Provider = 'traccar' | 'samsara' | 'motive' | 'dat' | 'truckstop';

const PROVIDERS: Record<Provider, { label: string; kind: string; config: z.ZodType; secret: z.ZodType; available: boolean; note?: string }> = {
  traccar: {
    label: 'Traccar GPS',
    kind: 'gps',
    config: z.strictObject({ base_url: z.url().refine((u) => /^https?:\/\//.test(u), 'http(s) URL') }),
    secret: z.union([z.strictObject({ token: z.string().min(8) }), z.strictObject({ email: z.string().min(3), password: z.string().min(1) })]),
    available: true,
  },
  samsara: { label: 'Samsara ELD', kind: 'eld', config: z.strictObject({}), secret: z.strictObject({ api_token: z.string().min(10) }), available: true },
  motive: { label: 'Motive ELD', kind: 'eld', config: z.strictObject({}), secret: z.strictObject({ api_key: z.string().min(10) }), available: true },
  dat: {
    label: 'DAT load board',
    kind: 'loadboard',
    config: z.strictObject({}),
    secret: z.strictObject({ username: z.string(), password: z.string() }),
    available: false,
    note: "DAT's load search API is available to approved partners only. Search will connect once HaulLedger's partner access is approved; booking a load you found on DAT works today.",
  },
  truckstop: {
    label: 'Truckstop load board',
    kind: 'loadboard',
    config: z.strictObject({}),
    secret: z.strictObject({ username: z.string(), password: z.string() }),
    available: false,
    note: "Truckstop's load search API is available to approved partners only. Search will connect once partner access is approved; booking a load you found on Truckstop works today.",
  },
};
const providerSchema = z.enum(Object.keys(PROVIDERS) as [Provider, ...Provider[]]);

const aad = (tenantId: string, provider: string) => `${tenantId}:${provider}`;

/** Loads and decrypts a carrier's integration, or fails with a 501 that says what to connect. */
export async function getIntegration<C, S>(env: AppEnv['Bindings'], tenantId: string, provider: Provider): Promise<{ config: C; secret: S }> {
  const row = await env.DB.prepare('SELECT config, secret_iv, secret_ct FROM tenant_integrations WHERE tenant_id = ? AND provider = ?').bind(tenantId, provider).first<{ config: string; secret_iv: string | null; secret_ct: string | null }>();
  if (!row || !row.secret_iv || !row.secret_ct) throw new HTTPException(501, { message: `${PROVIDERS[provider].label} is not connected. The owner can connect it under Settings → Integrations.` });
  let secret: S;
  try {
    secret = JSON.parse(await decryptSecret(env.INTEGRATIONS_KEY, row.secret_iv, row.secret_ct, aad(tenantId, provider))) as S;
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    throw new HTTPException(500, { message: `Stored ${PROVIDERS[provider].label} credentials could not be decrypted; reconnect the integration.` });
  }
  return { config: JSON.parse(row.config) as C, secret };
}

// ---------------------------------------------------------------- settings (owner)

integrations.use('*', requireRole('owner'));

integrations.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT provider, config, updated_at FROM tenant_integrations WHERE tenant_id = ?').bind(c.get('auth').tenantId).all<{ provider: Provider; config: string; updated_at: string }>();
  const connected = new Map(results.map((r) => [r.provider, r]));
  return c.json({
    integrations: (Object.keys(PROVIDERS) as Provider[]).map((p) => ({
      provider: p,
      label: PROVIDERS[p].label,
      kind: PROVIDERS[p].kind,
      available: PROVIDERS[p].available,
      note: PROVIDERS[p].note ?? null,
      connected: connected.has(p),
      config: connected.has(p) ? JSON.parse(connected.get(p)!.config) : null, // never the secret
      updated_at: connected.get(p)?.updated_at ?? null,
    })),
  });
});

integrations.put('/:provider', async (c) => {
  const auth = c.get('auth');
  const provider = providerSchema.safeParse(c.req.param('provider'));
  if (!provider.success) notFound('Unknown integration');
  const def = PROVIDERS[provider.data];
  if (!def.available) throw new HTTPException(501, { message: def.note ?? 'Not available yet' });
  const input = await body(c, z.strictObject({ config: def.config, secret: def.secret }));
  const { iv, ct } = await encryptSecret(c.env.INTEGRATIONS_KEY, JSON.stringify(input.secret), aad(auth.tenantId, provider.data));
  await c.env.DB.prepare(
    `INSERT INTO tenant_integrations (id, tenant_id, provider, config, secret_iv, secret_ct) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET config = excluded.config, secret_iv = excluded.secret_iv, secret_ct = excluded.secret_ct, updated_at = ?`,
  )
    .bind(newId(), auth.tenantId, provider.data, JSON.stringify(input.config), iv, ct, nowIso())
    .run();
  return c.json({ provider: provider.data, connected: true });
});

integrations.delete('/:provider', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM tenant_integrations WHERE tenant_id = ? AND provider = ?').bind(c.get('auth').tenantId, c.req.param('provider')).run();
  if (!res.meta.changes) notFound('Not connected');
  return c.body(null, 204);
});

/** Makes one real call with the stored credentials. */
integrations.post('/:provider/test', async (c) => {
  const auth = c.get('auth');
  const provider = providerSchema.parse(c.req.param('provider'));
  if (provider === 'traccar') {
    const { config, secret } = await getIntegration<TraccarConfig, TraccarSecret>(c.env, auth.tenantId, 'traccar');
    return c.json({ ok: true, detail: `${(await traccarDevices(config, secret)).length} devices visible` });
  }
  if (provider === 'samsara' || provider === 'motive') return c.json({ ok: true, detail: `${(await eldClocks(c.env, auth.tenantId, provider)).length} drivers with HOS clocks` });
  throw new HTTPException(501, { message: PROVIDERS[provider].note ?? 'Not available' });
});

// ---------------------------------------------------------------- GPS (Traccar)

tracking.use('*', requireRole('owner', 'dispatcher'));

tracking.get('/devices', async (c) => {
  const { config, secret } = await getIntegration<TraccarConfig, TraccarSecret>(c.env, c.get('auth').tenantId, 'traccar');
  const devices = await traccarDevices(config, secret);
  return c.json({ devices: devices.map((d) => ({ id: String(d.id), name: d.name, unique_id: d.uniqueId, status: d.status ?? null, last_update: d.lastUpdate ?? null })) });
});

/** Every truck with its last GPS fix. Trucks without a mapped device are listed with no position. */
tracking.get('/positions', async (c) => {
  const auth = c.get('auth');
  const { config, secret } = await getIntegration<TraccarConfig, TraccarSecret>(c.env, auth.tenantId, 'traccar');
  const [positions, trucks] = await Promise.all([
    traccarPositions(config, secret),
    c.env.DB.prepare(
      `SELECT t.id, t.unit_number, t.traccar_device_id,
              (SELECT l.load_number FROM loads l WHERE l.tenant_id = t.tenant_id AND l.truck_id = t.id AND l.status IN ('dispatched', 'at_pickup', 'in_transit') ORDER BY l.dispatched_at DESC LIMIT 1) AS load_number,
              (SELECT d.first_name || ' ' || d.last_name FROM loads l JOIN drivers d ON d.tenant_id = l.tenant_id AND d.id = l.driver_id
                WHERE l.tenant_id = t.tenant_id AND l.truck_id = t.id AND l.status IN ('dispatched', 'at_pickup', 'in_transit') ORDER BY l.dispatched_at DESC LIMIT 1) AS driver_name
         FROM trucks t WHERE t.tenant_id = ? AND t.status <> 'inactive' ORDER BY t.unit_number`,
    ).bind(auth.tenantId).all<{ id: string; unit_number: string; traccar_device_id: string | null; load_number: string | null; driver_name: string | null }>(),
  ]);
  const byDevice = new Map(positions.map((p) => [String(p.deviceId), normalizePosition(p)]));
  return c.json({
    trucks: trucks.results.map((t) => ({ ...t, position: t.traccar_device_id ? (byDevice.get(t.traccar_device_id) ?? null) : null })),
  });
});

// ---------------------------------------------------------------- HOS (ELD vendor)

async function eldClocks(env: AppEnv['Bindings'], tenantId: string, provider: 'samsara' | 'motive'): Promise<HosClock[]> {
  if (provider === 'samsara') {
    const { secret } = await getIntegration<unknown, { api_token: string }>(env, tenantId, 'samsara');
    return samsaraClocks(secret.api_token);
  }
  const { secret } = await getIntegration<unknown, { api_key: string }>(env, tenantId, 'motive');
  return motiveClocks(secret.api_key);
}

async function connectedEld(db: D1Database, tenantId: string): Promise<'samsara' | 'motive'> {
  const row = await db.prepare(`SELECT provider FROM tenant_integrations WHERE tenant_id = ? AND provider IN ('samsara', 'motive') ORDER BY updated_at DESC LIMIT 1`).bind(tenantId).first<{ provider: 'samsara' | 'motive' }>();
  if (!row) throw new HTTPException(501, { message: 'No ELD is connected. HaulLedger reads hours of service from Samsara or Motive; the owner can connect one under Settings → Integrations.' });
  return row.provider;
}

hos.use('*', requireRole('owner', 'dispatcher'));

/** HOS clocks per driver, joined to HaulLedger drivers by their ELD id. */
hos.get('/clocks', async (c) => {
  const auth = c.get('auth');
  const provider = await connectedEld(c.env.DB, auth.tenantId);
  const [clocks, drivers] = await Promise.all([
    eldClocks(c.env, auth.tenantId, provider),
    c.env.DB.prepare(`SELECT id, first_name || ' ' || last_name AS name, eld_driver_id FROM drivers WHERE tenant_id = ? AND status = 'active'`).bind(auth.tenantId).all<{ id: string; name: string; eld_driver_id: string | null }>(),
  ]);
  const byEld = new Map(clocks.map((cl) => [cl.eld_driver_id, cl]));
  const mapped = new Set(drivers.results.map((d) => d.eld_driver_id).filter(Boolean));
  return c.json({
    provider,
    drivers: drivers.results.map((d) => ({ driver_id: d.id, name: d.name, eld_driver_id: d.eld_driver_id, clock: d.eld_driver_id ? (byEld.get(d.eld_driver_id) ?? null) : null })),
    unmapped: clocks.filter((cl) => !mapped.has(cl.eld_driver_id)).map((cl) => ({ eld_driver_id: cl.eld_driver_id, name: cl.name })),
  });
});

// ---------------------------------------------------------------- load boards

loadboard.use('*', requireRole('owner', 'dispatcher'));

loadboard.get('/search', async (c) => {
  const provider = providerSchema.catch('dat').parse(c.req.query('provider'));
  throw new HTTPException(501, { message: PROVIDERS[provider].note ?? 'Search is not available for this board' });
});

const bookSchema = z.strictObject({
  source: z.enum(['dat', 'truckstop', 'direct', 'other']),
  posting_id: optText,
  broker: z.strictObject({ name: z.string().trim().min(1).max(200), mc_number: optText, email: z.email().nullable().optional(), phone: optText }),
  reference_number: optText,
  rate_cents: cents.min(1),
  loaded_miles: z.int().min(0).max(20_000).nullable().optional(),
  commodity: optText,
  weight_lbs: z.int().min(0).max(200_000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  stops: z
    .array(z.strictObject({ kind: z.enum(['pickup', 'delivery']), facility_name: optText, address: optText, city: z.string().trim().min(1).max(100), state: usState, postal_code: optText, scheduled_start: z.iso.datetime({ offset: true }).nullable().optional() }))
    .min(2)
    .refine((s) => s[0]?.kind === 'pickup' && s[s.length - 1]?.kind === 'delivery', 'first stop is a pickup, last is a delivery'),
});

/**
 * Books a load found on a board (or offered directly): finds the broker by MC
 * number (or name) or adds it, then creates the planned load from the rate
 * confirmation details. Attach the rate con PDF to the new load afterwards.
 */
loadboard.post('/book', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, bookSchema);
  const db = c.env.DB;
  const mc = input.broker.mc_number?.toUpperCase().replace(/\s+/g, '') ?? null;
  let customer = mc
    ? await db.prepare('SELECT id FROM customers WHERE tenant_id = ? AND upper(replace(mc_number, \' \', \'\')) = ?').bind(auth.tenantId, mc).first<{ id: string }>()
    : await db.prepare('SELECT id FROM customers WHERE tenant_id = ? AND lower(name) = lower(?)').bind(auth.tenantId, input.broker.name).first<{ id: string }>();
  const statements: D1PreparedStatement[] = [];
  if (!customer) {
    customer = { id: newId() };
    statements.push(insertRow(db, 'customers', { id: customer.id, tenant_id: auth.tenantId, name: input.broker.name, kind: 'broker', mc_number: mc, email: input.broker.email ?? null, phone: input.broker.phone ?? null }));
  }
  const loadId = newId();
  const count = await db.prepare('SELECT COUNT(*) AS n FROM loads WHERE tenant_id = ?').bind(auth.tenantId).first<{ n: number }>();
  const loadNumber = `L-${1001 + (count?.n ?? 0)}`;
  const source = input.source === 'direct' || input.source === 'other' ? '' : ` Booked from ${input.source.toUpperCase()}${input.posting_id ? ` posting ${input.posting_id}` : ''}.`;
  statements.push(
    insertRow(db, 'loads', {
      id: loadId, tenant_id: auth.tenantId, load_number: loadNumber, customer_id: customer.id, reference_number: input.reference_number ?? null,
      rate_cents: input.rate_cents, loaded_miles: input.loaded_miles ?? null, commodity: input.commodity ?? null, weight_lbs: input.weight_lbs ?? null,
      notes: [input.notes, source.trim()].filter(Boolean).join('\n') || null,
    }),
    ...input.stops.map((s, i) => insertRow(db, 'load_stops', { id: newId(), tenant_id: auth.tenantId, load_id: loadId, seq: i + 1, ...s })),
    insertRow(db, 'load_events', { id: newId(), tenant_id: auth.tenantId, load_id: loadId, to_status: 'planned', user_id: auth.userId }),
  );
  await uniqueGuard(`Load ${loadNumber}`, () => db.batch(statements));
  return c.json({ load_id: loadId, load_number: loadNumber, customer_id: customer.id }, 201);
});

