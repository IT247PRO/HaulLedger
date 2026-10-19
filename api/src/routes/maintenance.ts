import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { isStaff, requireRole } from '../lib/auth';
import { badRequest, conflict, forbidden, insertRow, newId, notFound, nowIso } from '../lib/http';
import { body, cents, isoDate, optText } from '../lib/validate';

export const maintenance = new Hono<AppEnv>();
export const dvirs = new Hono<AppEnv>();

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Open DVIR defects on a unit block its dispatch (49 CFR 396.11(a)(3)). */
export async function openDefects(db: D1Database, tenantId: string, truckId: string | null, trailerId: string | null) {
  if (!truckId && !trailerId) return [];
  const { results } = await db
    .prepare(
      `SELECT v.id, v.inspected_at, t.unit_number AS truck_unit, tr.unit_number AS trailer_unit
         FROM dvirs v LEFT JOIN trucks t ON t.tenant_id = v.tenant_id AND t.id = v.truck_id
         LEFT JOIN trailers tr ON tr.tenant_id = v.tenant_id AND tr.id = v.trailer_id
        WHERE v.tenant_id = ?1 AND v.status = 'defects_open' AND ((?2 IS NOT NULL AND v.truck_id = ?2) OR (?3 IS NOT NULL AND v.trailer_id = ?3))`,
    )
    .bind(tenantId, truckId, trailerId)
    .all<{ id: string; inspected_at: string; truck_unit: string | null; trailer_unit: string | null }>();
  return results;
}

// ---------------------------------------------------------------- PM schedules

export function pmStatus(s: { interval_miles: number | null; interval_days: number | null; last_done_on: string | null; last_done_odometer: number | null }, odometer: number | null, today = new Date().toISOString().slice(0, 10)) {
  const next_due_odometer = s.interval_miles && s.last_done_odometer !== null ? s.last_done_odometer + s.interval_miles : null;
  const next_due_on = s.interval_days && s.last_done_on ? addDays(s.last_done_on, s.interval_days) : null;
  const miles_remaining = next_due_odometer !== null && odometer !== null ? next_due_odometer - odometer : null;
  const never = (s.interval_miles && s.last_done_odometer === null) || (s.interval_days && !s.last_done_on);
  let status: 'ok' | 'due_soon' | 'overdue' | 'no_baseline' = 'ok';
  if ((miles_remaining !== null && miles_remaining <= 0) || (next_due_on !== null && next_due_on < today)) status = 'overdue';
  else if ((miles_remaining !== null && miles_remaining <= Math.max(1000, Math.floor((s.interval_miles ?? 0) / 10))) || (next_due_on !== null && next_due_on <= addDays(today, 14))) status = 'due_soon';
  else if (never) status = 'no_baseline';
  return { next_due_odometer, next_due_on, miles_remaining, status };
}

maintenance.use('*', requireRole('owner', 'dispatcher'));

maintenance.get('/schedules', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, t.unit_number AS truck_unit, t.odometer, tr.unit_number AS trailer_unit
       FROM pm_schedules s LEFT JOIN trucks t ON t.tenant_id = s.tenant_id AND t.id = s.truck_id
       LEFT JOIN trailers tr ON tr.tenant_id = s.tenant_id AND tr.id = s.trailer_id
      WHERE s.tenant_id = ? AND s.active = 1 ORDER BY COALESCE(t.unit_number, tr.unit_number), s.name`,
  )
    .bind(c.get('auth').tenantId)
    .all<any>();
  const order = { overdue: 0, due_soon: 1, no_baseline: 2, ok: 3 } as const;
  const schedules = results.map((s) => ({ ...s, ...pmStatus(s, s.odometer) })).sort((a, b) => order[a.status as keyof typeof order] - order[b.status as keyof typeof order]);
  return c.json({ schedules });
});

const scheduleSchema = z
  .strictObject({
    truck_id: z.string().max(64).nullable().optional(),
    trailer_id: z.string().max(64).nullable().optional(),
    name: z.string().trim().min(1).max(200),
    interval_miles: z.int().min(1).max(1_000_000).nullable().optional(),
    interval_days: z.int().min(1).max(3650).nullable().optional(),
    last_done_on: isoDate.nullable().optional(),
    last_done_odometer: z.int().min(0).nullable().optional(),
  })
  .refine((s) => !!s.truck_id !== !!s.trailer_id, 'Choose a truck or a trailer')
  .refine((s) => s.interval_miles || s.interval_days, 'Set an interval in miles, days, or both')
  .refine((s) => !s.interval_miles || s.truck_id, 'Mileage intervals apply to trucks');

async function assertUnit(db: D1Database, tenantId: string, truckId?: string | null, trailerId?: string | null) {
  if (truckId && !(await db.prepare('SELECT 1 FROM trucks WHERE tenant_id = ? AND id = ?').bind(tenantId, truckId).first())) badRequest('truck_id: not found');
  if (trailerId && !(await db.prepare('SELECT 1 FROM trailers WHERE tenant_id = ? AND id = ?').bind(tenantId, trailerId).first())) badRequest('trailer_id: not found');
}

maintenance.post('/schedules', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, scheduleSchema);
  await assertUnit(c.env.DB, auth.tenantId, input.truck_id, input.trailer_id);
  const id = newId();
  await insertRow(c.env.DB, 'pm_schedules', { id, tenant_id: auth.tenantId, ...input }).run();
  return c.json({ schedule: await c.env.DB.prepare('SELECT * FROM pm_schedules WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});

maintenance.patch('/schedules/:id', async (c) => {
  const { active } = await body(c, z.strictObject({ active: z.boolean() }));
  const res = await c.env.DB.prepare('UPDATE pm_schedules SET active = ? WHERE tenant_id = ? AND id = ?').bind(active ? 1 : 0, c.get('auth').tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Schedule not found');
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- repair history

const recordSchema = z
  .strictObject({
    truck_id: z.string().max(64).nullable().optional(),
    trailer_id: z.string().max(64).nullable().optional(),
    performed_on: isoDate,
    odometer: z.int().min(0).max(5_000_000).nullable().optional(),
    vendor: optText,
    description: z.string().trim().min(1).max(1000),
    cost_cents: cents.optional(),
    pm_schedule_id: z.string().max(64).nullable().optional(),
    dvir_id: z.string().max(64).nullable().optional(),
    document_id: z.string().max(64).nullable().optional(),
  })
  .refine((s) => !!s.truck_id !== !!s.trailer_id, 'Choose a truck or a trailer');

maintenance.get('/records', async (c) => {
  const q = c.req.query();
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, t.unit_number AS truck_unit, tr.unit_number AS trailer_unit, s.name AS pm_name
       FROM maintenance_records m LEFT JOIN trucks t ON t.tenant_id = m.tenant_id AND t.id = m.truck_id
       LEFT JOIN trailers tr ON tr.tenant_id = m.tenant_id AND tr.id = m.trailer_id
       LEFT JOIN pm_schedules s ON s.tenant_id = m.tenant_id AND s.id = m.pm_schedule_id
      WHERE m.tenant_id = ?1 AND (?2 IS NULL OR m.truck_id = ?2) AND (?3 IS NULL OR m.trailer_id = ?3)
      ORDER BY m.performed_on DESC LIMIT 500`,
  )
    .bind(c.get('auth').tenantId, q.truck_id ?? null, q.trailer_id ?? null)
    .all();
  return c.json({ records: results });
});

/** A repair or service. Its cost posts as a maintenance expense so per-truck P&L sees it. */
maintenance.post('/records', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, recordSchema);
  const db = c.env.DB;
  await assertUnit(db, auth.tenantId, input.truck_id, input.trailer_id);
  if (input.pm_schedule_id) {
    const s = await db.prepare('SELECT truck_id, trailer_id FROM pm_schedules WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, input.pm_schedule_id).first<{ truck_id: string | null; trailer_id: string | null }>();
    if (!s || s.truck_id !== (input.truck_id ?? null) || s.trailer_id !== (input.trailer_id ?? null)) badRequest('pm_schedule_id: not a schedule for this unit');
  }
  const id = newId();
  const statements: D1PreparedStatement[] = [];
  let expenseId: string | null = null;
  if (input.cost_cents) {
    expenseId = newId();
    statements.push(insertRow(db, 'expenses', {
      id: expenseId, tenant_id: auth.tenantId, category: 'maintenance', amount_cents: input.cost_cents, incurred_on: input.performed_on,
      vendor: input.vendor ?? null, description: input.description.slice(0, 500), truck_id: input.truck_id ?? null, trailer_id: input.trailer_id ?? null,
      document_id: input.document_id ?? null, created_by: auth.userId,
    }));
  }
  statements.push(insertRow(db, 'maintenance_records', { id, tenant_id: auth.tenantId, created_by: auth.userId, expense_id: expenseId, ...input, cost_cents: input.cost_cents ?? 0 }));
  if (input.pm_schedule_id) {
    statements.push(db.prepare('UPDATE pm_schedules SET last_done_on = ?, last_done_odometer = COALESCE(?, last_done_odometer) WHERE tenant_id = ? AND id = ?')
      .bind(input.performed_on, input.odometer ?? null, auth.tenantId, input.pm_schedule_id));
  }
  if (input.truck_id && input.odometer) {
    statements.push(db.prepare('UPDATE trucks SET odometer = ? WHERE tenant_id = ? AND id = ? AND (odometer IS NULL OR odometer < ?)').bind(input.odometer, auth.tenantId, input.truck_id, input.odometer));
  }
  await db.batch(statements);
  return c.json({ record: await db.prepare('SELECT * FROM maintenance_records WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});

// ---------------------------------------------------------------- DVIRs

/** Component list from 49 CFR 396.11(a)(2), plus "other". */
export const DVIR_COMPONENTS = [
  'service_brakes', 'parking_brake', 'steering', 'lighting_reflectors', 'tires', 'horn', 'windshield_wipers',
  'rear_vision_mirrors', 'coupling_devices', 'wheels_rims', 'emergency_equipment', 'other',
] as const;

const dvirSchema = z.strictObject({
  driver_id: z.string().max(64).optional(),
  truck_id: z.string().max(64),
  trailer_id: z.string().max(64).nullable().optional(),
  kind: z.enum(['pre_trip', 'post_trip']),
  odometer: z.int().min(0).max(5_000_000).nullable().optional(),
  location: optText,
  remarks: optText,
  signature_name: z.string().trim().min(2).max(200),
  defects: z
    .array(z.strictObject({ unit: z.enum(['truck', 'trailer']), component: z.enum(DVIR_COMPONENTS), description: z.string().trim().min(1).max(500), out_of_service: z.boolean().optional() }))
    .max(30),
});

const DVIR_SELECT = `SELECT v.*, t.unit_number AS truck_unit, tr.unit_number AS trailer_unit, d.first_name || ' ' || d.last_name AS driver_name
  FROM dvirs v JOIN trucks t ON t.tenant_id = v.tenant_id AND t.id = v.truck_id
  LEFT JOIN trailers tr ON tr.tenant_id = v.tenant_id AND tr.id = v.trailer_id
  JOIN drivers d ON d.tenant_id = v.tenant_id AND d.id = v.driver_id`;

async function withDefects(db: D1Database, tenantId: string, rows: any[]) {
  if (!rows.length) return rows;
  const { results } = await db.prepare(`SELECT * FROM dvir_defects WHERE tenant_id = ? AND dvir_id IN (${rows.map(() => '?').join(',')})`).bind(tenantId, ...rows.map((r) => r.id)).all<any>();
  return rows.map((r) => ({ ...r, defects: results.filter((d) => d.dvir_id === r.id).map((d) => ({ ...d, out_of_service: !!d.out_of_service })) }));
}

/**
 * Staff see every report. A driver sees their own, and the latest reports on a
 * truck they are about to drive (396.11(a)(3)(iii): the next driver reviews the
 * last report and its certification).
 */
dvirs.get('/', async (c) => {
  const auth = c.get('auth');
  const q = c.req.query();
  let rows;
  if (isStaff(auth)) {
    rows = (await c.env.DB.prepare(`${DVIR_SELECT} WHERE v.tenant_id = ?1 AND (?2 IS NULL OR v.truck_id = ?2) AND (?3 IS NULL OR v.status = ?3) ORDER BY v.inspected_at DESC LIMIT 200`)
      .bind(auth.tenantId, q.truck_id ?? null, q.status ?? null).all()).results;
  } else if (q.truck_id) {
    rows = (await c.env.DB.prepare(`${DVIR_SELECT} WHERE v.tenant_id = ? AND v.truck_id = ? ORDER BY v.inspected_at DESC LIMIT 3`).bind(auth.tenantId, q.truck_id).all()).results;
  } else {
    rows = (await c.env.DB.prepare(`${DVIR_SELECT} WHERE v.tenant_id = ? AND v.driver_id = ? ORDER BY v.inspected_at DESC LIMIT 100`).bind(auth.tenantId, auth.driverId).all()).results;
  }
  return c.json({ dvirs: await withDefects(c.env.DB, auth.tenantId, rows) });
});

dvirs.post('/', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, dvirSchema);
  const db = c.env.DB;
  const driverId = isStaff(auth) ? input.driver_id : auth.driverId;
  if (!driverId) badRequest('driver_id: required');
  if (!isStaff(auth) && input.driver_id && input.driver_id !== auth.driverId) forbidden('Drivers file their own inspection reports');
  if (!(await db.prepare('SELECT 1 FROM drivers WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, driverId).first())) badRequest('driver_id: not found');
  await assertUnit(db, auth.tenantId, input.truck_id, input.trailer_id);
  if (input.defects.some((d) => d.unit === 'trailer') && !input.trailer_id) badRequest('A trailer defect needs the trailer');
  const id = newId();
  const now = nowIso();
  const { defects, driver_id: _d, ...rest } = input;
  const statements = [
    insertRow(db, 'dvirs', { ...rest, id, tenant_id: auth.tenantId, driver_id: driverId, inspected_at: now, status: defects.length ? 'defects_open' : 'satisfactory' }),
    ...defects.map((d) => insertRow(db, 'dvir_defects', { id: newId(), tenant_id: auth.tenantId, dvir_id: id, ...d, out_of_service: d.out_of_service ? 1 : 0 })),
  ];
  if (input.odometer) {
    statements.push(db.prepare('UPDATE trucks SET odometer = ? WHERE tenant_id = ? AND id = ? AND (odometer IS NULL OR odometer < ?)').bind(input.odometer, auth.tenantId, input.truck_id, input.odometer));
  }
  await db.batch(statements);
  const [row] = await withDefects(db, auth.tenantId, [await db.prepare(`${DVIR_SELECT} WHERE v.tenant_id = ? AND v.id = ?`).bind(auth.tenantId, id).first()]);
  return c.json({ dvir: row }, 201);
});

const certifySchema = z.strictObject({
  result: z.enum(['repaired', 'no_repair_needed']),
  certified_name: z.string().trim().min(2).max(200),
  notes: optText,
});

/** The carrier certifies each defect was repaired, or that repair is unnecessary (396.11(a)(3)(ii)). */
dvirs.post('/:id/certify', requireRole('owner', 'dispatcher'), async (c) => {
  const auth = c.get('auth');
  const input = await body(c, certifySchema);
  const res = await c.env.DB.prepare(
    `UPDATE dvirs SET status = ?, certified_by = ?, certified_name = ?, certified_at = ?, certification_notes = ? WHERE tenant_id = ? AND id = ? AND status = 'defects_open'`,
  )
    .bind(input.result, auth.userId, input.certified_name, nowIso(), input.notes ?? null, auth.tenantId, c.req.param('id'))
    .run();
  if (!res.meta.changes) conflict('Only a report with open defects can be certified');
  const [row] = await withDefects(c.env.DB, auth.tenantId, [await c.env.DB.prepare(`${DVIR_SELECT} WHERE v.tenant_id = ? AND v.id = ?`).bind(auth.tenantId, c.req.param('id')).first()]);
  return c.json({ dvir: row });
});

/** The next driver acknowledges the previous report and its certification. */
dvirs.post('/:id/review', async (c) => {
  const auth = c.get('auth');
  if (!auth.driverId) forbidden('Drivers review inspection reports');
  const res = await c.env.DB.prepare('UPDATE dvirs SET reviewed_by_driver = ?, reviewed_at = ? WHERE tenant_id = ? AND id = ? AND reviewed_at IS NULL')
    .bind(auth.driverId, nowIso(), auth.tenantId, c.req.param('id'))
    .run();
  if (!res.meta.changes) notFound('Report not found or already reviewed');
  return c.json({ ok: true });
});
