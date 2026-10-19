import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Auth } from '../types';
import { isStaff, requireRole } from '../lib/auth';
import { badRequest, conflict, forbidden, insertRow, newId, notFound } from '../lib/http';
import { body, cents, isoDate, optText } from '../lib/validate';

/**
 * Everything that feeds a settlement. Owner-only, except that a driver may read
 * their own pay rates and escrow ledger and submit their own reimbursements.
 */
export const pay = new Hono<AppEnv>();

/**
 * The two pay tracks never share deduction types. W-2 drivers get payroll-style
 * items (benefits, garnishments); 1099 contractors get lease charges. Neither
 * track ever has tax withholding here: W-2 tax is the payroll provider's job,
 * and contractors are not withheld from.
 */
export const CHARGE_CATEGORIES = {
  w2: ['benefits', 'garnishment', 'uniform', 'equipment_damage', 'other', 'deficit'],
  '1099': [
    'fuel', 'insurance', 'cargo_insurance', 'occupational_accident', 'truck_lease', 'eld',
    'plates_permits', 'maintenance', 'equipment_damage', 'other', 'deficit',
  ],
} as const;

type PayTrack = 'w2' | '1099';

interface DriverPayInfo {
  id: string;
  pay_track: PayTrack;
  first_name: string;
  last_name: string;
  email: string | null;
  escrow_target_cents: number;
  escrow_per_settlement_cents: number;
}

export async function getDriver(db: D1Database, tenantId: string, driverId: string): Promise<DriverPayInfo> {
  const d = await db
    .prepare(
      `SELECT id, pay_track, first_name, last_name, email, escrow_target_cents, escrow_per_settlement_cents
         FROM drivers WHERE tenant_id = ? AND id = ?`,
    )
    .bind(tenantId, driverId)
    .first<DriverPayInfo>();
  if (!d) badRequest('driver_id: not found');
  return d;
}

function assertCategory(track: PayTrack, category: string) {
  if (!(CHARGE_CATEGORIES[track] as readonly string[]).includes(category)) {
    badRequest(`category: "${category}" is not allowed for ${track === 'w2' ? 'W-2 company drivers' : '1099 contractors'}`);
  }
}

async function assertLoadForDriver(db: D1Database, tenantId: string, loadId: string | null | undefined, driverId: string) {
  if (!loadId) return;
  const load = await db.prepare('SELECT driver_id FROM loads WHERE tenant_id = ? AND id = ?').bind(tenantId, loadId).first<{ driver_id: string | null }>();
  if (!load) badRequest('load_id: not found');
  if (load.driver_id !== driverId) badRequest('load_id: that load is not assigned to this driver');
}

async function assertDocument(db: D1Database, auth: Auth, documentId: string | null | undefined) {
  if (!documentId) return;
  const doc = await db.prepare('SELECT driver_id FROM documents WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, documentId).first<{ driver_id: string | null }>();
  if (!doc) badRequest('document_id: not found');
  if (!isStaff(auth) && doc.driver_id !== auth.driverId) badRequest('document_id: not found');
}

/** Drivers are pinned to themselves; staff may filter by any driver. */
function driverScope(auth: Auth, requested: string | undefined): string | null {
  if (auth.role === 'driver') return auth.driverId;
  return requested ?? null;
}

const ownerOnly = requireRole('owner');
const isSettled = async (db: D1Database, tenantId: string, column: string, id: string) =>
  !!(await db.prepare(`SELECT 1 FROM settlement_lines WHERE tenant_id = ? AND ${column} = ?`).bind(tenantId, id).first());

// ---------------------------------------------------------------- pay rates

const payRateSchema = z
  .strictObject({
    driver_id: z.string().max(64),
    kind: z.enum(['per_mile', 'percent', 'per_stop', 'hourly', 'per_diem']),
    rate: z.int().min(0).max(100_000_000),
    basis: z.enum(['loaded', 'all', 'extra']).nullable().optional(),
    effective_from: isoDate,
    effective_to: isoDate.nullable().optional(),
  })
  .refine((r) => r.kind !== 'percent' || r.rate <= 10_000, { message: 'percent rate is basis points (max 10000 = 100%)', path: ['rate'] })
  .refine((r) => r.kind !== 'per_mile' || r.basis === 'loaded' || r.basis === 'all', { message: 'per_mile needs basis "loaded" or "all"', path: ['basis'] })
  .refine((r) => r.kind !== 'per_stop' || r.basis === 'all' || r.basis === 'extra', { message: 'per_stop needs basis "all" or "extra"', path: ['basis'] })
  .refine((r) => ['per_mile', 'per_stop'].includes(r.kind) || !r.basis, { message: 'basis only applies to per_mile and per_stop', path: ['basis'] })
  .refine((r) => !r.effective_to || r.effective_to >= r.effective_from, { message: 'effective_to is before effective_from', path: ['effective_to'] });

const PAY_RATE_COLUMNS = 'id, driver_id, kind, rate, basis, effective_from, effective_to, created_at';

pay.get('/pay-rates', async (c) => {
  const auth = c.get('auth');
  if (auth.role === 'dispatcher') forbidden('Pay rates are visible to the owner only');
  const driverId = driverScope(auth, c.req.query('driver_id'));
  const { results } = await c.env.DB.prepare(
    `SELECT ${PAY_RATE_COLUMNS} FROM driver_pay_rates WHERE tenant_id = ?1 AND (?2 IS NULL OR driver_id = ?2) ORDER BY driver_id, kind, effective_from`,
  )
    .bind(auth.tenantId, driverId)
    .all();
  return c.json({ pay_rates: results });
});

pay.post('/pay-rates', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, payRateSchema);
  const driver = await getDriver(c.env.DB, auth.tenantId, input.driver_id);
  if (input.kind === 'per_diem' && driver.pay_track !== 'w2') badRequest('Per diem applies to W-2 company drivers only');
  // Rates of different kinds mix freely; two of the same kind may not overlap in time.
  const overlap = await c.env.DB.prepare(
    `SELECT 1 FROM driver_pay_rates WHERE tenant_id = ? AND driver_id = ? AND kind = ?
       AND effective_from <= COALESCE(?, '9999-12-31') AND COALESCE(effective_to, '9999-12-31') >= ?`,
  )
    .bind(auth.tenantId, input.driver_id, input.kind, input.effective_to ?? null, input.effective_from)
    .first();
  if (overlap) conflict(`This driver already has a ${input.kind} rate in effect for those dates; end it first`);
  const id = newId();
  await insertRow(c.env.DB, 'driver_pay_rates', { id, tenant_id: auth.tenantId, ...input, basis: input.basis ?? null }).run();
  const rate = await c.env.DB.prepare(`SELECT ${PAY_RATE_COLUMNS} FROM driver_pay_rates WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, id).first();
  return c.json({ pay_rate: rate }, 201);
});

/** Rates are history: they are ended, not edited. Only a never-used rate can be deleted. */
pay.post('/pay-rates/:id/end', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const { effective_to } = await body(c, z.strictObject({ effective_to: isoDate }));
  const res = await c.env.DB.prepare(
    'UPDATE driver_pay_rates SET effective_to = ?1 WHERE tenant_id = ?2 AND id = ?3 AND effective_from <= ?1',
  )
    .bind(effective_to, auth.tenantId, c.req.param('id'))
    .run();
  if (!res.meta.changes) notFound('Pay rate not found, or end date is before it starts');
  return c.json({ pay_rate: await c.env.DB.prepare(`SELECT ${PAY_RATE_COLUMNS} FROM driver_pay_rates WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, c.req.param('id')).first() });
});

pay.delete('/pay-rates/:id', ownerOnly, async (c) => {
  const auth = c.get('auth');
  if (await isSettled(c.env.DB, auth.tenantId, 'pay_rate_id', c.req.param('id'))) conflict('This rate has paid loads; end it instead of deleting it');
  const res = await c.env.DB.prepare('DELETE FROM driver_pay_rates WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Pay rate not found');
  return c.body(null, 204);
});

// ---------------------------------------------------------------- advances

const advanceSchema = z.strictObject({
  driver_id: z.string().max(64),
  amount_cents: cents.min(1),
  issued_on: isoDate,
  method: z.enum(['cash', 'comchek', 'efs_check', 'fuel_card', 'ach', 'other']).optional(),
  reference: optText,
  memo: optText,
  load_id: z.string().max(64).nullable().optional(),
});

const settledFlag = (table: string, column: string) =>
  `EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl.tenant_id = ${table}.tenant_id AND sl.${column} = ${table}.id) AS settled`;

pay.get('/advances', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT driver_advances.*, ${settledFlag('driver_advances', 'advance_id')}
       FROM driver_advances WHERE tenant_id = ?1 AND (?2 IS NULL OR driver_id = ?2) ORDER BY issued_on DESC LIMIT 500`,
  )
    .bind(auth.tenantId, c.req.query('driver_id') ?? null)
    .all();
  return c.json({ advances: results });
});

pay.post('/advances', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, advanceSchema);
  await getDriver(c.env.DB, auth.tenantId, input.driver_id);
  await assertLoadForDriver(c.env.DB, auth.tenantId, input.load_id, input.driver_id);
  const id = newId();
  await insertRow(c.env.DB, 'driver_advances', { id, tenant_id: auth.tenantId, created_by: auth.userId, ...input }).run();
  return c.json({ advance: await c.env.DB.prepare('SELECT * FROM driver_advances WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});

pay.delete('/advances/:id', ownerOnly, async (c) => {
  const auth = c.get('auth');
  if (await isSettled(c.env.DB, auth.tenantId, 'advance_id', c.req.param('id'))) conflict('Already on a settlement');
  const res = await c.env.DB.prepare('DELETE FROM driver_advances WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Advance not found');
  return c.body(null, 204);
});

// ---------------------------------------------------------------- charges (one-off deductions)

const chargeSchema = z.strictObject({
  driver_id: z.string().max(64),
  category: z.string().max(40),
  amount_cents: cents.min(1),
  incurred_on: isoDate,
  description: z.string().trim().min(1).max(500),
  load_id: z.string().max(64).nullable().optional(),
  document_id: z.string().max(64).nullable().optional(),
});

pay.get('/charges', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT driver_charges.*, ${settledFlag('driver_charges', 'charge_id')}
       FROM driver_charges WHERE tenant_id = ?1 AND (?2 IS NULL OR driver_id = ?2) ORDER BY incurred_on DESC LIMIT 500`,
  )
    .bind(auth.tenantId, c.req.query('driver_id') ?? null)
    .all();
  return c.json({ charges: results });
});

pay.post('/charges', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, chargeSchema);
  const driver = await getDriver(c.env.DB, auth.tenantId, input.driver_id);
  if (input.category === 'deficit') badRequest('Deficits are carried forward automatically by settlements');
  assertCategory(driver.pay_track, input.category);
  await assertLoadForDriver(c.env.DB, auth.tenantId, input.load_id, input.driver_id);
  await assertDocument(c.env.DB, auth, input.document_id);
  const id = newId();
  await insertRow(c.env.DB, 'driver_charges', { id, tenant_id: auth.tenantId, created_by: auth.userId, ...input }).run();
  return c.json({ charge: await c.env.DB.prepare('SELECT * FROM driver_charges WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});

pay.delete('/charges/:id', ownerOnly, async (c) => {
  const auth = c.get('auth');
  if (await isSettled(c.env.DB, auth.tenantId, 'charge_id', c.req.param('id'))) conflict('Already on a settlement');
  const res = await c.env.DB.prepare('DELETE FROM driver_charges WHERE tenant_id = ? AND id = ? AND origin_settlement_id IS NULL')
    .bind(auth.tenantId, c.req.param('id'))
    .run();
  if (!res.meta.changes) notFound('Charge not found (settlement-generated charges are removed with their settlement)');
  return c.body(null, 204);
});

// ---------------------------------------------------------------- recurring deductions

const recurringSchema = z.strictObject({
  driver_id: z.string().max(64),
  category: z.string().max(40),
  amount_cents: cents.min(1),
  description: z.string().trim().min(1).max(500),
});

pay.get('/recurring-deductions', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM recurring_deductions WHERE tenant_id = ?1 AND (?2 IS NULL OR driver_id = ?2) ORDER BY driver_id, category',
  )
    .bind(auth.tenantId, c.req.query('driver_id') ?? null)
    .all();
  return c.json({ recurring_deductions: results });
});

pay.post('/recurring-deductions', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, recurringSchema);
  const driver = await getDriver(c.env.DB, auth.tenantId, input.driver_id);
  if (input.category === 'deficit') badRequest('Deficits are carried forward automatically');
  assertCategory(driver.pay_track, input.category);
  const id = newId();
  await insertRow(c.env.DB, 'recurring_deductions', { id, tenant_id: auth.tenantId, ...input }).run();
  return c.json({ recurring_deduction: await c.env.DB.prepare('SELECT * FROM recurring_deductions WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});

pay.patch('/recurring-deductions/:id', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const { active } = await body(c, z.strictObject({ active: z.boolean() }));
  const res = await c.env.DB.prepare('UPDATE recurring_deductions SET active = ? WHERE tenant_id = ? AND id = ?')
    .bind(active ? 1 : 0, auth.tenantId, c.req.param('id'))
    .run();
  if (!res.meta.changes) notFound('Recurring deduction not found');
  return c.json({ recurring_deduction: await c.env.DB.prepare('SELECT * FROM recurring_deductions WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, c.req.param('id')).first() });
});

// ---------------------------------------------------------------- reimbursements

const reimbursementSchema = z.strictObject({
  driver_id: z.string().max(64).optional(),
  category: z.enum(['lumper', 'scale', 'tolls', 'parking', 'repair', 'fuel', 'other']),
  amount_cents: cents.min(1),
  incurred_on: isoDate,
  description: z.string().trim().min(1).max(500),
  load_id: z.string().max(64).nullable().optional(),
  document_id: z.string().max(64).nullable().optional(),
});

pay.get('/reimbursements', async (c) => {
  const auth = c.get('auth');
  if (auth.role === 'dispatcher') forbidden();
  const { results } = await c.env.DB.prepare(
    `SELECT driver_reimbursements.*, ${settledFlag('driver_reimbursements', 'reimbursement_id')}
       FROM driver_reimbursements WHERE tenant_id = ?1 AND (?2 IS NULL OR driver_id = ?2) ORDER BY incurred_on DESC LIMIT 500`,
  )
    .bind(auth.tenantId, driverScope(auth, c.req.query('driver_id')))
    .all();
  return c.json({ reimbursements: results });
});

/** Drivers submit their own (pending, receipt attached); the owner records approved ones directly. */
pay.post('/reimbursements', async (c) => {
  const auth = c.get('auth');
  if (auth.role === 'dispatcher') forbidden();
  const input = await body(c, reimbursementSchema);
  const driverId = auth.role === 'driver' ? auth.driverId! : input.driver_id;
  if (!driverId) badRequest('driver_id: required');
  if (auth.role === 'driver' && input.driver_id && input.driver_id !== driverId) forbidden();
  if (auth.role === 'driver' && !input.document_id) badRequest('document_id: attach a photo of the receipt');
  await getDriver(c.env.DB, auth.tenantId, driverId);
  await assertLoadForDriver(c.env.DB, auth.tenantId, input.load_id, driverId);
  await assertDocument(c.env.DB, auth, input.document_id);
  const id = newId();
  await insertRow(c.env.DB, 'driver_reimbursements', {
    ...input,
    id,
    tenant_id: auth.tenantId,
    driver_id: driverId,
    status: auth.role === 'owner' ? 'approved' : 'pending',
    created_by: auth.userId,
  }).run();
  return c.json({ reimbursement: await c.env.DB.prepare('SELECT * FROM driver_reimbursements WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});

pay.patch('/reimbursements/:id', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const { status } = await body(c, z.strictObject({ status: z.enum(['approved', 'rejected', 'pending']) }));
  if (await isSettled(c.env.DB, auth.tenantId, 'reimbursement_id', c.req.param('id'))) conflict('Already on a settlement');
  const res = await c.env.DB.prepare('UPDATE driver_reimbursements SET status = ? WHERE tenant_id = ? AND id = ?').bind(status, auth.tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Reimbursement not found');
  return c.json({ reimbursement: await c.env.DB.prepare('SELECT * FROM driver_reimbursements WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, c.req.param('id')).first() });
});

// ---------------------------------------------------------------- escrow

/**
 * Escrow balance. Holds count once their settlement is finalized; releases,
 * interest and withdrawals count as soon as they are recorded.
 */
export async function escrowBalance(db: D1Database, tenantId: string, driverId: string, opts: { excludeSettlement?: string } = {}): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(e.amount_cents), 0) AS balance
         FROM escrow_transactions e
         LEFT JOIN settlements s ON s.tenant_id = e.tenant_id AND s.id = e.settlement_id
        WHERE e.tenant_id = ?1 AND e.driver_id = ?2
          AND (e.kind <> 'hold' OR s.status IN ('finalized', 'paid'))
          AND (?3 IS NULL OR e.settlement_id IS NULL OR e.settlement_id <> ?3)`,
    )
    .bind(tenantId, driverId, opts.excludeSettlement ?? null)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

pay.get('/escrow', async (c) => {
  const auth = c.get('auth');
  if (auth.role === 'dispatcher') forbidden();
  const driverId = driverScope(auth, c.req.query('driver_id'));
  if (!driverId) badRequest('driver_id: required');
  const driver = await getDriver(c.env.DB, auth.tenantId, driverId);
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.kind, e.amount_cents, e.occurred_on, e.memo, e.settlement_id, s.settlement_number, s.status AS settlement_status
       FROM escrow_transactions e LEFT JOIN settlements s ON s.tenant_id = e.tenant_id AND s.id = e.settlement_id
      WHERE e.tenant_id = ? AND e.driver_id = ?
        AND (e.kind <> 'hold' OR s.status IN ('finalized', 'paid'))
      ORDER BY e.occurred_on, e.created_at`,
  )
    .bind(auth.tenantId, driverId)
    .all<{ amount_cents: number }>();
  let running = 0;
  const ledger = results.map((r) => ({ ...r, balance_cents: (running += r.amount_cents) }));
  return c.json({
    driver_id: driverId,
    target_cents: driver.escrow_target_cents,
    per_settlement_cents: driver.escrow_per_settlement_cents,
    balance_cents: running,
    ledger,
  });
});

const escrowEntrySchema = z.strictObject({
  driver_id: z.string().max(64),
  kind: z.enum(['interest', 'release', 'withdrawal']),
  amount_cents: cents.min(1),
  occurred_on: isoDate,
  memo: z.string().trim().min(1).max(500),
});

/**
 * Manual escrow entries. Interest is credited (376.12(k) requires it); a
 * release is paid to the driver on their next settlement; a withdrawal applies
 * escrow to an obligation named in the lease and must say which in the memo.
 */
pay.post('/escrow', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, escrowEntrySchema);
  const driver = await getDriver(c.env.DB, auth.tenantId, input.driver_id);
  if (driver.pay_track !== '1099') badRequest('Escrow applies to 1099 contractors only');
  const signed = input.kind === 'interest' ? input.amount_cents : -input.amount_cents;
  if (signed < 0 && input.amount_cents > (await escrowBalance(c.env.DB, auth.tenantId, input.driver_id))) {
    badRequest('Amount exceeds the escrow balance');
  }
  const id = newId();
  await insertRow(c.env.DB, 'escrow_transactions', {
    id,
    tenant_id: auth.tenantId,
    driver_id: input.driver_id,
    kind: input.kind,
    amount_cents: signed,
    occurred_on: input.occurred_on,
    memo: input.memo,
    created_by: auth.userId,
  }).run();
  return c.json({ escrow_transaction: await c.env.DB.prepare('SELECT * FROM escrow_transactions WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});
