import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { hashPassword } from '../lib/crypto';
import { badRequest, conflict, newId, notFound, setClause } from '../lib/http';
import { body } from '../lib/validate';
import { password } from './auth';

// Managing logins is a setting: owner only.
export const users = new Hono<AppEnv>();
users.use('*', requireRole('owner'));

const COLUMNS = 'id, email, name, role, driver_id, created_at';

const createSchema = z.strictObject({
  email: z.email().trim().toLowerCase(),
  name: z.string().trim().min(1).max(200),
  role: z.enum(['owner', 'dispatcher', 'driver']),
  driver_id: z.string().nullable().optional(),
  password,
});

const updateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200).optional(),
  password: password.optional(),
});

users.get('/', async (c) => {
  const { tenantId } = c.get('auth');
  const { results } = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM users WHERE tenant_id = ? ORDER BY name`)
    .bind(tenantId)
    .all();
  return c.json({ users: results });
});

users.post('/', async (c) => {
  const { tenantId } = c.get('auth');
  const input = await body(c, createSchema);
  const driverId = input.role === 'driver' ? input.driver_id : null;
  if (input.role === 'driver') {
    if (!driverId) badRequest('driver_id is required for a driver login');
    const driver = await c.env.DB.prepare('SELECT 1 FROM drivers WHERE tenant_id = ? AND id = ?')
      .bind(tenantId, driverId)
      .first();
    if (!driver) badRequest('driver_id: unknown driver');
    const taken = await c.env.DB.prepare('SELECT 1 FROM users WHERE tenant_id = ? AND driver_id = ?')
      .bind(tenantId, driverId)
      .first();
    if (taken) conflict('That driver already has a login');
  }
  const exists = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(input.email).first();
  if (exists) conflict('An account with that email already exists');

  const id = newId();
  await c.env.DB.prepare(
    'INSERT INTO users (id, tenant_id, email, name, password_hash, role, driver_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, tenantId, input.email, input.name, await hashPassword(input.password), input.role, driverId ?? null)
    .run();
  const user = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM users WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, id)
    .first();
  return c.json({ user }, 201);
});

users.patch('/:id', async (c) => {
  const { tenantId } = c.get('auth');
  const { password: newPassword, ...rest } = await body(c, updateSchema);
  const patch: Record<string, unknown> = { ...rest };
  if (newPassword) patch.password_hash = await hashPassword(newPassword);
  const set = setClause(patch);
  if (!set.sql) badRequest('Nothing to update');
  const res = await c.env.DB.prepare(`UPDATE users SET ${set.sql} WHERE tenant_id = ? AND id = ?`)
    .bind(...set.params, tenantId, c.req.param('id'))
    .run();
  if (!res.meta.changes) notFound('User not found');
  if (newPassword) {
    // A password change signs the user out everywhere.
    await c.env.DB.prepare('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?')
      .bind(tenantId, c.req.param('id'))
      .run();
  }
  const user = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM users WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, c.req.param('id'))
    .first();
  return c.json({ user });
});

users.delete('/:id', async (c) => {
  const { tenantId, userId } = c.get('auth');
  const id = c.req.param('id');
  if (id === userId) badRequest('You cannot remove your own login');
  const res = await c.env.DB.prepare('DELETE FROM users WHERE tenant_id = ? AND id = ?').bind(tenantId, id).run();
  if (!res.meta.changes) notFound('User not found');
  return c.body(null, 204);
});
