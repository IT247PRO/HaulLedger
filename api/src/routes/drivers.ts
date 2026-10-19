import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { isStaff, requireRole } from '../lib/auth';
import { badRequest, conflict, forbidden, insertRow, newId, notFound, nowIso, setClause } from '../lib/http';
import { body, cents, optDate, optText, usState } from '../lib/validate';

export const drivers = new Hono<AppEnv>();

const COLUMNS = `id, first_name, last_name, email, phone, pay_track, status, license_number, license_state,
  license_class, license_expires_on, medical_expires_on, hired_on, escrow_target_cents, escrow_per_settlement_cents,
  created_at, updated_at`;

// Fields a dispatcher may maintain. pay_track (W-2 vs 1099) is a pay decision: owner only.
const profileFields = {
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  email: z.email().nullable().optional(),
  phone: optText,
  status: z.enum(['active', 'inactive']).optional(),
  license_number: optText,
  license_state: usState.nullable().optional(),
  license_class: optText,
  license_expires_on: optDate,
  medical_expires_on: optDate,
  hired_on: optDate,
};

// Owner-only pay terms. Escrow exists only for 1099 contractors (49 CFR 376.12(k)).
const payFields = {
  pay_track: z.enum(['w2', '1099']),
  escrow_target_cents: cents.optional(),
  escrow_per_settlement_cents: cents.optional(),
};
const PAY_FIELDS = Object.keys(payFields) as (keyof typeof payFields)[];

const createSchema = z.strictObject({ ...profileFields, ...payFields });
const updateSchema = z.strictObject({
  ...profileFields,
  ...payFields,
  first_name: profileFields.first_name.optional(),
  last_name: profileFields.last_name.optional(),
  pay_track: payFields.pay_track.optional(),
});

function assertEscrowTrack(track: string, escrowTarget: number, escrowPer: number) {
  if (track === 'w2' && (escrowTarget > 0 || escrowPer > 0)) badRequest('Escrow applies to 1099 contractors only');
}

drivers.get('/', requireRole('owner', 'dispatcher'), async (c) => {
  const { tenantId } = c.get('auth');
  const status = c.req.query('status');
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM drivers WHERE tenant_id = ? AND (?2 IS NULL OR status = ?2) ORDER BY last_name, first_name`,
  )
    .bind(tenantId, status ?? null)
    .all();
  return c.json({ drivers: results });
});

drivers.get('/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  // A driver can read their own profile and nobody else's.
  if (!isStaff(auth) && auth.driverId !== id) notFound('Driver not found');
  const driver = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM drivers WHERE tenant_id = ? AND id = ?`)
    .bind(auth.tenantId, id)
    .first();
  if (!driver) notFound('Driver not found');
  return c.json({ driver });
});

drivers.post('/', requireRole('owner'), async (c) => {
  const { tenantId } = c.get('auth');
  const input = await body(c, createSchema);
  assertEscrowTrack(input.pay_track, input.escrow_target_cents ?? 0, input.escrow_per_settlement_cents ?? 0);
  const id = newId();
  await insertRow(c.env.DB, 'drivers', { id, tenant_id: tenantId, ...input }).run();
  const driver = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM drivers WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, id)
    .first();
  return c.json({ driver }, 201);
});

drivers.patch('/:id', requireRole('owner', 'dispatcher'), async (c) => {
  const { tenantId, role } = c.get('auth');
  const input = await body(c, updateSchema);
  if (PAY_FIELDS.some((f) => input[f] !== undefined) && role !== 'owner') forbidden('Only the owner can change pay terms');
  const current = await c.env.DB.prepare('SELECT pay_track, escrow_target_cents, escrow_per_settlement_cents FROM drivers WHERE tenant_id = ? AND id = ?')
    .bind(tenantId, c.req.param('id'))
    .first<{ pay_track: string; escrow_target_cents: number; escrow_per_settlement_cents: number }>();
  if (!current) notFound('Driver not found');
  if (input.pay_track && input.pay_track !== current.pay_track) {
    // Changing classification mid-settlement would blur the two tracks.
    const draft = await c.env.DB.prepare(`SELECT 1 FROM settlements WHERE tenant_id = ? AND driver_id = ? AND status = 'draft'`).bind(tenantId, c.req.param('id')).first();
    if (draft) conflict('Finalize or delete the draft settlement before changing pay track');
    if (input.pay_track === 'w2') {
      const bal = await c.env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS b FROM escrow_transactions WHERE tenant_id = ? AND driver_id = ?').bind(tenantId, c.req.param('id')).first<{ b: number }>();
      if ((bal?.b ?? 0) !== 0) conflict('Release the escrow balance before moving this driver to W-2');
      input.escrow_target_cents ??= 0;
      input.escrow_per_settlement_cents ??= 0;
    }
  }
  assertEscrowTrack(
    input.pay_track ?? current.pay_track,
    input.escrow_target_cents ?? current.escrow_target_cents,
    input.escrow_per_settlement_cents ?? current.escrow_per_settlement_cents,
  );
  const set = setClause(input);
  if (!set.sql) badRequest('Nothing to update');
  const res = await c.env.DB.prepare(`UPDATE drivers SET ${set.sql}, updated_at = ? WHERE tenant_id = ? AND id = ?`)
    .bind(...set.params, nowIso(), tenantId, c.req.param('id'))
    .run();
  if (!res.meta.changes) notFound('Driver not found');
  const driver = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM drivers WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, c.req.param('id'))
    .first();
  return c.json({ driver });
});
