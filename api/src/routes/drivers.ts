import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { isStaff, requireRole } from '../lib/auth';
import { badRequest, forbidden, insertRow, newId, notFound, nowIso, setClause } from '../lib/http';
import { body, optDate, optText, usState } from '../lib/validate';

export const drivers = new Hono<AppEnv>();

const COLUMNS = `id, first_name, last_name, email, phone, pay_track, status, license_number, license_state,
  license_class, license_expires_on, medical_expires_on, hired_on, created_at, updated_at`;

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

const createSchema = z.strictObject({ ...profileFields, pay_track: z.enum(['w2', '1099']) });
const updateSchema = z.strictObject({
  ...profileFields,
  first_name: profileFields.first_name.optional(),
  last_name: profileFields.last_name.optional(),
  pay_track: z.enum(['w2', '1099']).optional(),
});

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
  if (input.pay_track !== undefined && role !== 'owner') forbidden('Only the owner can change a pay track');
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
