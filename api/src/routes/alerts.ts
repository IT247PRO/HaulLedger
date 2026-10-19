import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';

export const alerts = new Hono<AppEnv>();
alerts.use('*', requireRole('owner', 'dispatcher'));

/**
 * CDL and DOT medical-card expirations for active drivers: already expired, or
 * expiring within `within_days` (default 30). A driver with a lapsed card
 * cannot legally be dispatched, so these lead the dashboard.
 */
alerts.get('/expirations', async (c) => {
  const days = Math.min(Math.max(Number(c.req.query('within_days') ?? 30) || 30, 1), 365);
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT id AS driver_id, first_name || ' ' || last_name AS driver_name, 'license' AS kind, license_expires_on AS expires_on
       FROM drivers WHERE tenant_id = ?1 AND status = 'active' AND license_expires_on IS NOT NULL AND license_expires_on <= ?2
     UNION ALL
     SELECT id, first_name || ' ' || last_name, 'medical', medical_expires_on
       FROM drivers WHERE tenant_id = ?1 AND status = 'active' AND medical_expires_on IS NOT NULL AND medical_expires_on <= ?2
     ORDER BY expires_on`,
  )
    .bind(c.get('auth').tenantId, horizon)
    .all<{ driver_id: string; driver_name: string; kind: 'license' | 'medical'; expires_on: string }>();
  return c.json({
    within_days: days,
    alerts: results.map((r) => ({ ...r, expired: r.expires_on < today })),
  });
});
