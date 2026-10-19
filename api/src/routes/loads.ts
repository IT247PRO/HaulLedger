import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Auth } from '../types';
import { isStaff, requireRole } from '../lib/auth';
import { uniqueGuard } from '../lib/crud';
import { badRequest, conflict, forbidden, insertRow, newId, notFound, nowIso, setClause } from '../lib/http';
import { body, cents, optText, usState } from '../lib/validate';
import { listDocuments } from './documents';

export const loads = new Hono<AppEnv>();

export const LOAD_STATUSES = ['planned', 'dispatched', 'at_pickup', 'in_transit', 'delivered', 'cancelled'] as const;
type LoadStatus = (typeof LOAD_STATUSES)[number];

/** Allowed status moves. Anything not listed is rejected. */
const TRANSITIONS: Record<LoadStatus, LoadStatus[]> = {
  planned: ['dispatched', 'cancelled'],
  dispatched: ['at_pickup', 'planned', 'cancelled'],
  at_pickup: ['in_transit', 'cancelled'],
  in_transit: ['delivered'],
  delivered: [],
  cancelled: ['planned'],
};

/** The moves a driver may make on their own load from the road. */
const DRIVER_TRANSITIONS: Partial<Record<LoadStatus, LoadStatus>> = {
  dispatched: 'at_pickup',
  at_pickup: 'in_transit',
  in_transit: 'delivered',
};

const stopSchema = z.strictObject({
  kind: z.enum(['pickup', 'delivery']),
  facility_name: optText,
  address: optText,
  city: z.string().trim().min(1).max(100),
  state: usState,
  postal_code: optText,
  scheduled_start: z.iso.datetime({ offset: true }).nullable().optional(),
  scheduled_end: z.iso.datetime({ offset: true }).nullable().optional(),
});

const stopsSchema = z
  .array(stopSchema)
  .min(2, 'a load needs at least a pickup and a delivery')
  .max(50)
  .refine((s) => s[0]?.kind === 'pickup', 'the first stop must be a pickup')
  .refine((s) => s[s.length - 1]?.kind === 'delivery', 'the last stop must be a delivery');

const id = z.string().min(1).max(64);
const loadFields = {
  load_number: z.string().trim().min(1).max(50),
  reference_number: optText,
  customer_id: id.nullable().optional(),
  driver_id: id.nullable().optional(),
  truck_id: id.nullable().optional(),
  trailer_id: id.nullable().optional(),
  rate_cents: cents.optional(),
  fuel_surcharge_cents: cents.optional(),
  accessorial_cents: cents.optional(),
  pay_hours_x100: z.int().min(0).max(100_000).nullable().optional(),
  loaded_miles: z.int().min(0).max(20_000).nullable().optional(),
  empty_miles: z.int().min(0).max(20_000).nullable().optional(),
  commodity: optText,
  weight_lbs: z.int().min(0).max(200_000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
};

const createSchema = z.strictObject({ ...loadFields, load_number: loadFields.load_number.optional(), stops: stopsSchema });
const updateSchema = z.strictObject({ ...loadFields, load_number: loadFields.load_number.optional(), stops: stopsSchema.optional() });
const statusSchema = z.strictObject({ status: z.enum(LOAD_STATUSES) });

const LOAD_SELECT = `
  SELECT l.id, l.load_number, l.reference_number, l.status, l.rate_cents, l.fuel_surcharge_cents, l.accessorial_cents,
         l.pay_hours_x100, l.pod_received_at, l.loaded_miles, l.empty_miles,
         l.commodity, l.weight_lbs, l.notes, l.dispatched_at, l.delivered_at, l.created_at, l.updated_at,
         l.customer_id, c.name AS customer_name,
         l.driver_id, d.first_name || ' ' || d.last_name AS driver_name,
         l.truck_id, t.unit_number AS truck_unit,
         l.trailer_id, tr.unit_number AS trailer_unit,
         (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq LIMIT 1) AS origin,
         (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq DESC LIMIT 1) AS destination
    FROM loads l
    LEFT JOIN customers c ON c.tenant_id = l.tenant_id AND c.id = l.customer_id
    LEFT JOIN drivers d   ON d.tenant_id = l.tenant_id AND d.id = l.driver_id
    LEFT JOIN trucks t    ON t.tenant_id = l.tenant_id AND t.id = l.truck_id
    LEFT JOIN trailers tr ON tr.tenant_id = l.tenant_id AND tr.id = l.trailer_id`;

type LoadRow = Record<string, unknown> & { id: string; status: LoadStatus; driver_id: string | null; truck_id: string | null };

/**
 * What a principal may see of a load. Drivers never see load revenue here; a
 * percentage-paid driver sees the gross on their settlement, with the rate
 * confirmation (Truth-in-Leasing).
 */
function present(auth: Auth, load: LoadRow) {
  if (isStaff(auth)) return load;
  const { rate_cents: _rate, fuel_surcharge_cents: _fsc, accessorial_cents: _acc, ...rest } = load;
  return rest;
}

async function fetchLoad(db: D1Database, auth: Auth, loadId: string): Promise<LoadRow> {
  const load = await db
    .prepare(`${LOAD_SELECT} WHERE l.tenant_id = ? AND l.id = ?`)
    .bind(auth.tenantId, loadId)
    .first<LoadRow>();
  // A driver asking for someone else's load gets the same 404 as a missing one.
  if (!load || (!isStaff(auth) && load.driver_id !== auth.driverId)) notFound('Load not found');
  return load;
}

async function fetchStops(db: D1Database, tenantId: string, loadId: string) {
  const { results } = await db
    .prepare(
      `SELECT id, seq, kind, facility_name, address, city, state, postal_code, scheduled_start, scheduled_end,
              arrived_at, departed_at
         FROM load_stops WHERE tenant_id = ? AND load_id = ? ORDER BY seq`,
    )
    .bind(tenantId, loadId)
    .all();
  return results;
}

/** Rejects references to records outside the caller's tenant (the composite FKs back this up). */
const REF_TABLES = { customer_id: 'customers', driver_id: 'drivers', truck_id: 'trucks', trailer_id: 'trailers' } as const;

async function assertRefs(db: D1Database, tenantId: string, input: Partial<Record<keyof typeof REF_TABLES, string | null>>) {
  for (const [field, table] of Object.entries(REF_TABLES)) {
    const value = input[field as keyof typeof REF_TABLES];
    if (!value) continue;
    const found = await db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ? AND id = ?`).bind(tenantId, value).first();
    if (!found) badRequest(`${field}: not found`);
  }
}

function stopInserts(db: D1Database, tenantId: string, loadId: string, stops: z.infer<typeof stopsSchema>) {
  return stops.map((stop, i) => insertRow(db, 'load_stops', { id: newId(), tenant_id: tenantId, load_id: loadId, seq: i + 1, ...stop }));
}

async function nextLoadNumber(db: D1Database, tenantId: string): Promise<string> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM loads WHERE tenant_id = ?').bind(tenantId).first<{ n: number }>();
  return `L-${1001 + (row?.n ?? 0)}`;
}

loads.get('/', async (c) => {
  const auth = c.get('auth');
  const status = c.req.query('status') ?? null;
  // Drivers are pinned to their own loads regardless of what they ask for.
  const driverId = isStaff(auth) ? (c.req.query('driver_id') ?? null) : auth.driverId;
  const { results } = await c.env.DB.prepare(
    `${LOAD_SELECT}
      WHERE l.tenant_id = ?1 AND (?2 IS NULL OR l.status = ?2) AND (?3 IS NULL OR l.driver_id = ?3)
      ORDER BY l.created_at DESC, l.load_number DESC
      LIMIT 500`,
  )
    .bind(auth.tenantId, status, driverId)
    .all<LoadRow>();
  return c.json({ loads: results.map((l) => present(auth, l)) });
});

loads.get('/:id', async (c) => {
  const auth = c.get('auth');
  const load = await fetchLoad(c.env.DB, auth, c.req.param('id'));
  const [stops, events] = await Promise.all([
    fetchStops(c.env.DB, auth.tenantId, load.id),
    c.env.DB.prepare(
      `SELECT e.id, e.from_status, e.to_status, e.created_at, u.name AS user_name
         FROM load_events e LEFT JOIN users u ON u.tenant_id = e.tenant_id AND u.id = e.user_id
        WHERE e.tenant_id = ? AND e.load_id = ? ORDER BY e.created_at`,
    )
      .bind(auth.tenantId, load.id)
      .all(),
  ]);
  const documents = await listDocuments(c.env.DB, auth, { load_id: load.id });
  return c.json({ load: { ...present(auth, load), stops, events: events.results, documents } });
});

loads.post('/', requireRole('owner', 'dispatcher'), async (c) => {
  const auth = c.get('auth');
  const { stops, ...input } = await body(c, createSchema);
  await assertRefs(c.env.DB, auth.tenantId, input);
  const loadId = newId();
  const loadNumber = input.load_number ?? (await nextLoadNumber(c.env.DB, auth.tenantId));
  await uniqueGuard(`Load ${loadNumber}`, () =>
    c.env.DB.batch([
      insertRow(c.env.DB, 'loads', { ...input, id: loadId, tenant_id: auth.tenantId, load_number: loadNumber }),
      ...stopInserts(c.env.DB, auth.tenantId, loadId, stops),
      insertRow(c.env.DB, 'load_events', { id: newId(), tenant_id: auth.tenantId, load_id: loadId, to_status: 'planned', user_id: auth.userId }),
    ]),
  );
  const load = await fetchLoad(c.env.DB, auth, loadId);
  return c.json({ load: { ...load, stops: await fetchStops(c.env.DB, auth.tenantId, loadId) } }, 201);
});

loads.patch('/:id', requireRole('owner', 'dispatcher'), async (c) => {
  const auth = c.get('auth');
  const existing = await fetchLoad(c.env.DB, auth, c.req.param('id'));
  const { stops, ...input } = await body(c, updateSchema);
  await assertRefs(c.env.DB, auth.tenantId, input);
  if (existing.status !== 'planned' && existing.status !== 'cancelled') {
    // A load on the road must keep a driver and a truck.
    if (input.driver_id === null || input.truck_id === null) badRequest('An active load must keep its driver and truck');
  }
  const set = setClause(input);
  if (!set.sql && !stops) badRequest('Nothing to update');
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`UPDATE loads SET ${set.sql ? `${set.sql}, ` : ''}updated_at = ? WHERE tenant_id = ? AND id = ?`).bind(
      ...set.params,
      nowIso(),
      auth.tenantId,
      existing.id,
    ),
  ];
  if (stops) {
    statements.push(c.env.DB.prepare('DELETE FROM load_stops WHERE tenant_id = ? AND load_id = ?').bind(auth.tenantId, existing.id));
    statements.push(...stopInserts(c.env.DB, auth.tenantId, existing.id, stops));
  }
  await uniqueGuard('Load number', () => c.env.DB.batch(statements));
  const load = await fetchLoad(c.env.DB, auth, existing.id);
  return c.json({ load: { ...load, stops: await fetchStops(c.env.DB, auth.tenantId, existing.id) } });
});

loads.post('/:id/status', async (c) => {
  const auth = c.get('auth');
  const load = await fetchLoad(c.env.DB, auth, c.req.param('id'));
  const { status: to } = await body(c, statusSchema);
  const from = load.status;

  if (!isStaff(auth) && DRIVER_TRANSITIONS[from] !== to) forbidden(`Drivers cannot move a load from ${from} to ${to}`);
  if (!TRANSITIONS[from].includes(to)) badRequest(`Cannot move a load from ${from} to ${to}`);
  if (to === 'dispatched' && (!load.driver_id || !load.truck_id)) badRequest('Assign a driver and a truck before dispatching');

  const now = nowIso();
  const stamps = to === 'dispatched' ? ', dispatched_at = ?5' : to === 'delivered' ? ', delivered_at = ?5' : '';
  const [update] = await c.env.DB.batch([
    // The status guard makes concurrent moves lose cleanly instead of skipping a step.
    c.env.DB.prepare(`UPDATE loads SET status = ?1, updated_at = ?5${stamps} WHERE tenant_id = ?2 AND id = ?3 AND status = ?4`).bind(
      to,
      auth.tenantId,
      load.id,
      from,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO load_events (id, tenant_id, load_id, from_status, to_status, user_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0`,
    ).bind(newId(), auth.tenantId, load.id, from, to, auth.userId, now),
  ]);
  if (!update?.meta.changes) conflict('The load changed while you were updating it; reload and try again');
  return c.json({ load: present(auth, await fetchLoad(c.env.DB, auth, load.id)) });
});

loads.delete('/:id', requireRole('owner', 'dispatcher'), async (c) => {
  const auth = c.get('auth');
  const load = await fetchLoad(c.env.DB, auth, c.req.param('id'));
  if (load.status !== 'planned' && load.status !== 'cancelled') conflict('Only planned or cancelled loads can be deleted');
  await c.env.DB.prepare('DELETE FROM loads WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, load.id).run();
  return c.body(null, 204);
});
