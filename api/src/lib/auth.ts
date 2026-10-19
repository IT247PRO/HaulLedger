import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, Auth, Role } from '../types';
import { newSessionToken, sha256Hex } from './crypto';
import { nowIso } from './http';

export const SESSION_COOKIE = 'hl_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(c: Context<AppEnv>, tenantId: string, userId: string): Promise<string> {
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await c.env.DB.prepare('INSERT INTO sessions (id, tenant_id, user_id, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), tenantId, userId, expires.toISOString())
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    expires,
  });
  return token;
}

function readToken(c: Context<AppEnv>): string | undefined {
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return getCookie(c, SESSION_COOKIE);
}

export async function destroySession(c: Context<AppEnv>): Promise<void> {
  const token = readToken(c);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/** Resolves the session to a principal. The tenant is taken from the session row only. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readToken(c);
  if (!token) throw new HTTPException(401, { message: 'Not signed in' });
  const row = await c.env.DB.prepare(
    `SELECT u.id AS user_id, u.tenant_id, u.role, u.driver_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
      WHERE s.id = ? AND s.expires_at > ?`,
  )
    .bind(await sha256Hex(token), nowIso())
    .first<{ user_id: string; tenant_id: string; role: Role; driver_id: string | null }>();
  if (!row) throw new HTTPException(401, { message: 'Session expired' });
  const auth: Auth = { userId: row.user_id, tenantId: row.tenant_id, role: row.role, driverId: row.driver_id };
  c.set('auth', auth);
  await next();
};

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roles.includes(c.get('auth').role)) throw new HTTPException(403, { message: 'Forbidden' });
    await next();
  };
}

export const isStaff = (auth: Auth) => auth.role === 'owner' || auth.role === 'dispatcher';
