import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { badRequest, insertRow, newId, notFound } from '../lib/http';
import { body, cents, isoDate, optText } from '../lib/validate';

export const expenses = new Hono<AppEnv>();
expenses.use('*', requireRole('owner', 'dispatcher'));

export const EXPENSE_CATEGORIES = [
  'maintenance', 'tires', 'tolls', 'insurance', 'truck_payment', 'trailer_payment', 'permits_licenses',
  'parking', 'lumper', 'factoring_fees', 'office', 'software', 'other',
] as const;

const schema = z.strictObject({
  category: z.enum(EXPENSE_CATEGORIES),
  amount_cents: cents.min(1),
  incurred_on: isoDate,
  vendor: optText,
  description: z.string().trim().min(1).max(500),
  truck_id: z.string().max(64).nullable().optional(),
  trailer_id: z.string().max(64).nullable().optional(),
  load_id: z.string().max(64).nullable().optional(),
  document_id: z.string().max(64).nullable().optional(),
});

const COLUMNS = `e.id, e.category, e.amount_cents, e.incurred_on, e.vendor, e.description, e.truck_id, e.trailer_id, e.load_id, e.document_id, e.created_at,
  t.unit_number AS truck_unit, tr.unit_number AS trailer_unit, l.load_number`;
const FROM = `FROM expenses e
  LEFT JOIN trucks t ON t.tenant_id = e.tenant_id AND t.id = e.truck_id
  LEFT JOIN trailers tr ON tr.tenant_id = e.tenant_id AND tr.id = e.trailer_id
  LEFT JOIN loads l ON l.tenant_id = e.tenant_id AND l.id = e.load_id`;

expenses.get('/', async (c) => {
  const q = c.req.query();
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLUMNS} ${FROM}
      WHERE e.tenant_id = ?1 AND (?2 IS NULL OR e.incurred_on >= ?2) AND (?3 IS NULL OR e.incurred_on <= ?3)
        AND (?4 IS NULL OR e.truck_id = ?4) AND (?5 IS NULL OR e.category = ?5)
      ORDER BY e.incurred_on DESC LIMIT 1000`,
  )
    .bind(c.get('auth').tenantId, q.from ?? null, q.to ?? null, q.truck_id ?? null, q.category ?? null)
    .all();
  return c.json({ expenses: results });
});

expenses.post('/', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, schema);
  for (const [field, table] of [['truck_id', 'trucks'], ['trailer_id', 'trailers'], ['load_id', 'loads'], ['document_id', 'documents']] as const) {
    const v = input[field];
    if (v && !(await c.env.DB.prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, v).first())) badRequest(`${field}: not found`);
  }
  const id = newId();
  await insertRow(c.env.DB, 'expenses', { id, tenant_id: auth.tenantId, created_by: auth.userId, ...input }).run();
  return c.json({ expense: await c.env.DB.prepare(`SELECT ${COLUMNS} ${FROM} WHERE e.tenant_id = ? AND e.id = ?`).bind(auth.tenantId, id).first() }, 201);
});

expenses.delete('/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM expenses WHERE tenant_id = ? AND id = ?').bind(c.get('auth').tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Expense not found');
  return c.body(null, 204);
});
