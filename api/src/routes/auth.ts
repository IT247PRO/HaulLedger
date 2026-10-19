import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Role } from '../types';
import { createSession, destroySession, requireAuth } from '../lib/auth';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../lib/crypto';
import { conflict, newId } from '../lib/http';
import { body } from '../lib/validate';
import { HTTPException } from 'hono/http-exception';

export const password = z.string().min(10, 'must be at least 10 characters').max(200);

const signupSchema = z.strictObject({
  company_name: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  email: z.email().trim().toLowerCase(),
  password,
});

const loginSchema = z.strictObject({
  email: z.email().trim().toLowerCase(),
  password: z.string().max(200),
});

export const auth = new Hono<AppEnv>();

/** Creates a new carrier (tenant) and its first owner. */
auth.post('/signup', async (c) => {
  const input = await body(c, signupSchema);
  const existing = await c.env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(input.email).first();
  if (existing) conflict('An account with that email already exists');

  const tenantId = newId();
  const userId = newId();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').bind(tenantId, input.company_name),
    c.env.DB.prepare(
      `INSERT INTO users (id, tenant_id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?, 'owner')`,
    ).bind(userId, tenantId, input.email, input.name, await hashPassword(input.password)),
  ]);
  const token = await createSession(c, tenantId, userId);
  return c.json({ token, user: await loadMe(c.env.DB, tenantId, userId) }, 201);
});

auth.post('/login', async (c) => {
  const input = await body(c, loginSchema);
  const user = await c.env.DB.prepare('SELECT id, tenant_id, password_hash FROM users WHERE email = ?')
    .bind(input.email)
    .first<{ id: string; tenant_id: string; password_hash: string }>();
  const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!user || !ok) throw new HTTPException(401, { message: 'Invalid email or password' });
  const token = await createSession(c, user.tenant_id, user.id);
  return c.json({ token, user: await loadMe(c.env.DB, user.tenant_id, user.id) });
});

auth.post('/logout', async (c) => {
  await destroySession(c);
  return c.body(null, 204);
});

auth.get('/me', requireAuth, async (c) => {
  const { tenantId, userId } = c.get('auth');
  return c.json({ user: await loadMe(c.env.DB, tenantId, userId) });
});

async function loadMe(db: D1Database, tenantId: string, userId: string) {
  return db
    .prepare(
      `SELECT u.id, u.email, u.name, u.role, u.driver_id, t.id AS tenant_id, t.name AS tenant_name
         FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE u.tenant_id = ? AND u.id = ?`,
    )
    .bind(tenantId, userId)
    .first<{ id: string; email: string; name: string; role: Role; driver_id: string | null; tenant_id: string; tenant_name: string }>();
}
