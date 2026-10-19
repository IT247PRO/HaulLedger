import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { computeIfta, quarterRange } from '../lib/ifta';
import { badRequest, insertRow, newId, notFound } from '../lib/http';
import { body, isoDate, optText, usState } from '../lib/validate';

export const ifta = new Hono<AppEnv>();
ifta.use('*', requireRole('owner', 'dispatcher'));

const quarterSchema = z.string().regex(/^\d{4}-Q[1-4]$/, 'quarter like 2026-Q3');
const fuelTypeSchema = z.enum(['diesel', 'gasoline']);

function parseQuarter(q: string | undefined) {
  const parsed = quarterSchema.safeParse(q);
  if (!parsed.success) badRequest('quarter: expected YYYY-Q1..Q4');
  return { quarter: parsed.data, ...quarterRange(parsed.data) };
}

export async function iftaReport(db: D1Database, tenantId: string, quarter: string, fuelType: 'diesel' | 'gasoline') {
  const { start, end } = quarterRange(quarter);
  const [miles, fuel, rates, loadCheck, unmatchedFuel, perTruck] = await Promise.all([
    db.prepare('SELECT state, SUM(miles) AS miles FROM jurisdiction_miles WHERE tenant_id = ? AND traveled_on BETWEEN ? AND ? GROUP BY state')
      .bind(tenantId, start, end).all<{ state: string; miles: number }>(),
    db.prepare(
      `SELECT state, SUM(gallons_milli) AS gallons FROM fuel_transactions
        WHERE tenant_id = ? AND product = ? AND truck_id IS NOT NULL AND substr(transacted_at, 1, 10) BETWEEN ? AND ? GROUP BY state`,
    ).bind(tenantId, fuelType, start, end).all<{ state: string; gallons: number }>(),
    db.prepare('SELECT state, rate_x10000 FROM ifta_tax_rates WHERE tenant_id = ? AND quarter = ? AND fuel_type = ?')
      .bind(tenantId, quarter, fuelType).all<{ state: string; rate_x10000: number }>(),
    // Every delivered load's state miles should add up to its loaded + empty miles.
    db.prepare(
      `SELECT l.id, l.load_number, COALESCE(l.loaded_miles, 0) + COALESCE(l.empty_miles, 0) AS expected,
              COALESCE((SELECT SUM(jm.miles) FROM jurisdiction_miles jm WHERE jm.tenant_id = l.tenant_id AND jm.load_id = l.id), 0) AS recorded
         FROM loads l
        WHERE l.tenant_id = ? AND l.status = 'delivered' AND l.truck_id IS NOT NULL AND substr(l.delivered_at, 1, 10) BETWEEN ? AND ?`,
    ).bind(tenantId, start, end).all<{ id: string; load_number: string; expected: number; recorded: number }>(),
    db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(gallons_milli), 0) AS gallons FROM fuel_transactions
        WHERE tenant_id = ? AND product = ? AND truck_id IS NULL AND substr(transacted_at, 1, 10) BETWEEN ? AND ?`,
    ).bind(tenantId, fuelType, start, end).first<{ n: number; gallons: number }>(),
    db.prepare(
      `SELECT t.unit_number,
              COALESCE((SELECT SUM(miles) FROM jurisdiction_miles jm WHERE jm.tenant_id = t.tenant_id AND jm.truck_id = t.id AND jm.traveled_on BETWEEN ?2 AND ?3), 0) AS miles,
              COALESCE((SELECT SUM(gallons_milli) FROM fuel_transactions f WHERE f.tenant_id = t.tenant_id AND f.truck_id = t.id AND f.product = ?4
                         AND substr(f.transacted_at, 1, 10) BETWEEN ?2 AND ?3), 0) AS gallons_milli
         FROM trucks t WHERE t.tenant_id = ?1 ORDER BY t.unit_number`,
    ).bind(tenantId, start, end, fuelType).all<{ unit_number: string; miles: number; gallons_milli: number }>(),
  ]);

  const report = computeIfta({
    milesByState: Object.fromEntries(miles.results.map((r) => [r.state, r.miles])),
    gallonsMilliByState: Object.fromEntries(fuel.results.map((r) => [r.state, r.gallons])),
    ratesX10000: Object.fromEntries(rates.results.map((r) => [r.state, r.rate_x10000])),
  });

  const warnings: string[] = [];
  const mismatched = loadCheck.results.filter((l) => l.recorded !== l.expected);
  for (const l of mismatched.slice(0, 50)) {
    warnings.push(l.recorded === 0 ? `${l.load_number}: no state miles recorded (${l.expected} mi on the load)` : `${l.load_number}: state miles add up to ${l.recorded}, load shows ${l.expected}`);
  }
  if (mismatched.length > 50) warnings.push(`…and ${mismatched.length - 50} more loads with state-mile gaps`);
  if (unmatchedFuel && unmatchedFuel.n > 0) warnings.push(`${unmatchedFuel.n} fuel purchases are not tied to a truck and are left out (assign them on the Fuel page)`);
  for (const t of perTruck.results) {
    if (t.miles > 0 && t.gallons_milli === 0) warnings.push(`Truck ${t.unit_number}: ${t.miles} miles but no ${fuelType} purchases`);
    if (t.miles === 0 && t.gallons_milli > 0) warnings.push(`Truck ${t.unit_number}: fuel purchased but no miles recorded`);
  }
  if (report.missing_rates.length) warnings.push(`No ${quarter} tax rate entered for: ${report.missing_rates.join(', ')}`);

  return { quarter, start, end, fuel_type: fuelType, ...report, trucks: perTruck.results, warnings };
}

ifta.get('/report', async (c) => {
  const { quarter } = parseQuarter(c.req.query('quarter'));
  const fuelType = fuelTypeSchema.catch('diesel').parse(c.req.query('fuel_type'));
  return c.json(await iftaReport(c.env.DB, c.get('auth').tenantId, quarter, fuelType));
});

ifta.get('/report.csv', async (c) => {
  const { quarter } = parseQuarter(c.req.query('quarter'));
  const fuelType = fuelTypeSchema.catch('diesel').parse(c.req.query('fuel_type'));
  const r = await iftaReport(c.env.DB, c.get('auth').tenantId, quarter, fuelType);
  const gal = (m: number | null) => (m === null ? '' : `${m < 0 ? '-' : ''}${Math.floor(Math.abs(m) / 1000)}.${String(Math.abs(m) % 1000).padStart(3, '0')}`);
  const usd = (c: number | null) => (c === null ? '' : `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`);
  const rate = (x: number | null) => (x === null ? '' : `${Math.floor(x / 10000)}.${String(x % 10000).padStart(4, '0')}`);
  const rows = [
    ['Jurisdiction', 'Total miles', 'Taxable gallons', 'Tax-paid gallons', 'Net taxable gallons', 'Tax rate', 'Tax due'],
    ...r.lines.map((l) => [l.state, String(l.miles), gal(l.taxable_gallons_milli), gal(l.tax_paid_gallons_milli), gal(l.net_taxable_gallons_milli), rate(l.rate_x10000), usd(l.tax_due_cents)]),
    ['TOTAL', String(r.total_miles), '', gal(r.total_gallons_milli), '', '', usd(r.total_tax_due_cents)],
    [],
    ['Fleet MPG', r.mpg_x100 === null ? '' : `${Math.floor(r.mpg_x100 / 100)}.${String(r.mpg_x100 % 100).padStart(2, '0')}`],
    ...r.warnings.map((w) => ['Warning', w]),
  ];
  const csv = rows.map((row) => row.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
  return c.body(csv, 200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="ifta-${quarter}-${fuelType}.csv"` });
});

// ---------------------------------------------------------------- miles

const stateMilesSchema = z.strictObject({
  miles: z.array(z.strictObject({ state: usState, miles: z.int().min(1).max(10_000) })).max(60),
});

ifta.get('/loads/:loadId/miles', async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare('SELECT id, state, miles, source FROM jurisdiction_miles WHERE tenant_id = ? AND load_id = ? ORDER BY miles DESC')
    .bind(auth.tenantId, c.req.param('loadId'))
    .all();
  return c.json({ miles: results });
});

/** Replaces a load's miles by state. A total that disagrees with the load is saved but flagged. */
ifta.put('/loads/:loadId/miles', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, stateMilesSchema);
  const load = await c.env.DB.prepare(
    'SELECT id, truck_id, loaded_miles, empty_miles, delivered_at, dispatched_at, created_at FROM loads WHERE tenant_id = ? AND id = ?',
  )
    .bind(auth.tenantId, c.req.param('loadId'))
    .first<{ id: string; truck_id: string | null; loaded_miles: number | null; empty_miles: number | null; delivered_at: string | null; dispatched_at: string | null; created_at: string }>();
  if (!load) notFound('Load not found');
  if (!load.truck_id) badRequest('Assign a truck before recording state miles');
  const states = input.miles.map((m) => m.state);
  if (new Set(states).size !== states.length) badRequest('Each state once');
  const day = (load.delivered_at ?? load.dispatched_at ?? load.created_at).slice(0, 10);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM jurisdiction_miles WHERE tenant_id = ? AND load_id = ?').bind(auth.tenantId, load.id),
    ...input.miles.map((m) =>
      insertRow(c.env.DB, 'jurisdiction_miles', { id: newId(), tenant_id: auth.tenantId, truck_id: load.truck_id, load_id: load.id, traveled_on: day, state: m.state, miles: m.miles, created_by: auth.userId }),
    ),
  ]);
  const recorded = input.miles.reduce((a, m) => a + m.miles, 0);
  const expected = (load.loaded_miles ?? 0) + (load.empty_miles ?? 0);
  return c.json({
    miles: input.miles,
    total: recorded,
    warnings: recorded !== expected ? [`State miles add up to ${recorded}; the load shows ${expected} (loaded + empty)`] : [],
  });
});

const truckMilesSchema = z.strictObject({
  truck_id: z.string().max(64),
  traveled_on: isoDate,
  state: usState,
  miles: z.int().min(1).max(10_000),
  note: optText,
});

/** Miles not on a load (bobtail, repositioning, to the shop) still count for IFTA. */
ifta.get('/miles', async (c) => {
  const { quarter, start, end } = parseQuarter(c.req.query('quarter'));
  const { results } = await c.env.DB.prepare(
    `SELECT jm.id, jm.truck_id, t.unit_number, jm.traveled_on, jm.state, jm.miles, jm.note, jm.source
       FROM jurisdiction_miles jm JOIN trucks t ON t.tenant_id = jm.tenant_id AND t.id = jm.truck_id
      WHERE jm.tenant_id = ? AND jm.load_id IS NULL AND jm.traveled_on BETWEEN ? AND ? ORDER BY jm.traveled_on`,
  )
    .bind(c.get('auth').tenantId, start, end)
    .all();
  return c.json({ quarter, miles: results });
});

ifta.post('/miles', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, truckMilesSchema);
  if (!(await c.env.DB.prepare('SELECT 1 FROM trucks WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, input.truck_id).first())) badRequest('truck_id: not found');
  const id = newId();
  await insertRow(c.env.DB, 'jurisdiction_miles', { id, tenant_id: auth.tenantId, created_by: auth.userId, ...input }).run();
  return c.json({ id }, 201);
});

ifta.delete('/miles/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM jurisdiction_miles WHERE tenant_id = ? AND id = ? AND load_id IS NULL').bind(c.get('auth').tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Entry not found');
  return c.body(null, 204);
});

// ---------------------------------------------------------------- rates

ifta.get('/rates', async (c) => {
  const { quarter } = parseQuarter(c.req.query('quarter'));
  const { results } = await c.env.DB.prepare('SELECT state, fuel_type, rate_x10000 FROM ifta_tax_rates WHERE tenant_id = ? AND quarter = ? ORDER BY fuel_type, state')
    .bind(c.get('auth').tenantId, quarter)
    .all();
  return c.json({ quarter, rates: results });
});

const ratesSchema = z.strictObject({
  quarter: quarterSchema,
  fuel_type: fuelTypeSchema,
  rates: z.array(z.strictObject({ state: usState, rate_x10000: z.int().min(0).max(100_000) })).min(1).max(80),
});

/** Upserts a quarter's rates (settings: owner only). */
ifta.put('/rates', requireRole('owner'), async (c) => {
  const auth = c.get('auth');
  const input = await body(c, ratesSchema);
  await c.env.DB.batch(
    input.rates.map((r) =>
      c.env.DB.prepare(
        `INSERT INTO ifta_tax_rates (id, tenant_id, quarter, state, fuel_type, rate_x10000) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, quarter, state, fuel_type) DO UPDATE SET rate_x10000 = excluded.rate_x10000`,
      ).bind(newId(), auth.tenantId, input.quarter, r.state, input.fuel_type, r.rate_x10000),
    ),
  );
  return c.json({ saved: input.rates.length });
});
