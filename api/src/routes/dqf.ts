import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { isStaff, requireRole } from '../lib/auth';
import { badRequest, insertRow, newId, notFound } from '../lib/http';
import { body, isoDate, optText } from '../lib/validate';

export const dqf = new Hono<AppEnv>();

type Recurrence = 'once' | 'annual' | 'expires' | 'per_medical';

/**
 * What an audit-ready driver qualification file holds (49 CFR 391.51), plus the
 * Part 382 Clearinghouse queries carriers keep alongside it. Annual items fall
 * due 12 months after the last one.
 */
export const DQF_REQUIREMENTS: { type: string; label: string; cite: string; recurrence: Recurrence; group: 'dqf' | 'part382' }[] = [
  { type: 'application', label: 'Employment application', cite: '391.21', recurrence: 'once', group: 'dqf' },
  { type: 'mvr_preemployment', label: 'Pre-employment MVR from each state licensed in the past 3 years', cite: '391.23(a)(1)', recurrence: 'once', group: 'dqf' },
  { type: 'safety_history', label: "Previous DOT employers' safety performance history (3 years)", cite: '391.23(a)(2), (d)', recurrence: 'once', group: 'dqf' },
  { type: 'road_test', label: 'Road test certificate, or license/certificate accepted in lieu', cite: '391.31(e) / 391.33', recurrence: 'once', group: 'dqf' },
  { type: 'medical_certificate', label: "Medical examiner's certificate", cite: '391.43', recurrence: 'expires', group: 'dqf' },
  { type: 'registry_verification', label: 'Note verifying the examiner is on the National Registry', cite: '391.23(m), 391.51(b)(9)', recurrence: 'per_medical', group: 'dqf' },
  { type: 'annual_mvr', label: 'Annual MVR from each state', cite: '391.25(a)', recurrence: 'annual', group: 'dqf' },
  { type: 'annual_review', label: 'Annual review of driving record', cite: '391.25(b)', recurrence: 'annual', group: 'dqf' },
  { type: 'clearinghouse_pre', label: 'Clearinghouse full pre-employment query', cite: '382.701(a)', recurrence: 'once', group: 'part382' },
  { type: 'clearinghouse_annual', label: 'Clearinghouse annual query', cite: '382.701(b)', recurrence: 'annual', group: 'part382' },
];
const TYPES = DQF_REQUIREMENTS.map((r) => r.type) as [string, ...string[]];

export type ItemStatus = 'complete' | 'missing' | 'expired' | 'expiring' | 'not_due';

interface ItemRow {
  id: string;
  item_type: string;
  completed_on: string;
  expires_on: string | null;
  document_id: string | null;
  notes: string | null;
  created_at: string;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Status of each requirement for one driver, from their recorded items. Pure; `today` is injectable for tests. */
export function dqfStatus(items: ItemRow[], hiredOn: string | null, today = new Date().toISOString().slice(0, 10)) {
  const soon = addDays(today, 30);
  const latest = (type: string) =>
    items.filter((i) => i.item_type === type).sort((a, b) => (a.completed_on < b.completed_on ? 1 : a.completed_on > b.completed_on ? -1 : a.created_at < b.created_at ? 1 : -1))[0];
  return DQF_REQUIREMENTS.map((req) => {
    const item = latest(req.type);
    let status: ItemStatus = item ? 'complete' : 'missing';
    let due_on: string | null = null;
    if (req.recurrence === 'annual') {
      if (item) due_on = item.expires_on ?? addDays(item.completed_on, 365);
      else if (hiredOn && hiredOn > addDays(today, -365)) {
        status = 'not_due';
        due_on = addDays(hiredOn, 365);
      }
    } else if (req.recurrence === 'expires' && item) {
      due_on = item.expires_on;
      if (!due_on) status = 'missing';
    } else if (req.recurrence === 'per_medical') {
      const med = latest('medical_certificate');
      // The verification must cover the current certificate, not an earlier one.
      if (item && med && item.completed_on < med.completed_on) status = 'missing';
      if (!med) status = item ? 'complete' : 'missing';
    }
    if (due_on && status === 'complete') status = due_on < today ? 'expired' : due_on <= soon ? 'expiring' : 'complete';
    return { ...req, status, due_on, latest: item ?? null };
  });
}

const overall = (statuses: { status: ItemStatus; group: string }[]) => {
  const s = statuses.map((x) => x.status);
  if (s.includes('expired') || s.includes('missing')) return 'attention';
  if (s.includes('expiring')) return 'expiring';
  return 'complete';
};

dqf.get('/', requireRole('owner', 'dispatcher'), async (c) => {
  const auth = c.get('auth');
  const [drivers, items] = await Promise.all([
    c.env.DB.prepare(`SELECT id, first_name, last_name, hired_on, status FROM drivers WHERE tenant_id = ? AND status = 'active' ORDER BY last_name, first_name`)
      .bind(auth.tenantId).all<{ id: string; first_name: string; last_name: string; hired_on: string | null }>(),
    c.env.DB.prepare('SELECT id, driver_id, item_type, completed_on, expires_on, document_id, notes, created_at FROM dqf_items WHERE tenant_id = ?')
      .bind(auth.tenantId).all<ItemRow & { driver_id: string }>(),
  ]);
  return c.json({
    drivers: drivers.results.map((d) => {
      const st = dqfStatus(items.results.filter((i) => i.driver_id === d.id), d.hired_on);
      const count = (k: ItemStatus) => st.filter((x) => x.status === k).length;
      return {
        driver_id: d.id,
        driver_name: `${d.first_name} ${d.last_name}`,
        overall: overall(st),
        missing: count('missing'),
        expired: count('expired'),
        expiring: count('expiring'),
        complete: count('complete'),
        next_due: st.map((x) => x.due_on).filter((x): x is string => !!x).sort()[0] ?? null,
      };
    }),
  });
});

dqf.get('/:driverId', async (c) => {
  const auth = c.get('auth');
  const driverId = c.req.param('driverId');
  if (!isStaff(auth) && auth.driverId !== driverId) notFound('Driver not found');
  const driver = await c.env.DB.prepare('SELECT id, first_name, last_name, hired_on, license_number, license_state, license_expires_on, medical_expires_on FROM drivers WHERE tenant_id = ? AND id = ?')
    .bind(auth.tenantId, driverId)
    .first<{ hired_on: string | null } & Record<string, unknown>>();
  if (!driver) notFound('Driver not found');
  const { results: items } = await c.env.DB.prepare(
    `SELECT i.id, i.item_type, i.completed_on, i.expires_on, i.document_id, i.notes, i.created_at, u.name AS recorded_by_name, d.filename
       FROM dqf_items i LEFT JOIN users u ON u.tenant_id = i.tenant_id AND u.id = i.recorded_by
       LEFT JOIN documents d ON d.tenant_id = i.tenant_id AND d.id = i.document_id
      WHERE i.tenant_id = ? AND i.driver_id = ? ORDER BY i.completed_on DESC`,
  )
    .bind(auth.tenantId, driverId)
    .all<ItemRow>();
  const requirements = dqfStatus(items, driver.hired_on);
  return c.json({ driver, overall: overall(requirements), requirements, history: items });
});

const itemSchema = z.strictObject({
  item_type: z.enum(TYPES),
  completed_on: isoDate,
  expires_on: isoDate.nullable().optional(),
  document_id: z.string().max(64).nullable().optional(),
  notes: optText,
});

dqf.post('/:driverId/items', requireRole('owner', 'dispatcher'), async (c) => {
  const auth = c.get('auth');
  const driverId = c.req.param('driverId');
  const input = await body(c, itemSchema);
  if (!(await c.env.DB.prepare('SELECT 1 FROM drivers WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, driverId).first())) notFound('Driver not found');
  if (input.item_type === 'medical_certificate' && !input.expires_on) badRequest('expires_on: a medical certificate has an expiration date');
  if (input.expires_on && input.expires_on < input.completed_on) badRequest('expires_on is before completed_on');
  if (input.document_id) {
    const doc = await c.env.DB.prepare('SELECT driver_id FROM documents WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, input.document_id).first<{ driver_id: string | null }>();
    if (!doc || (doc.driver_id && doc.driver_id !== driverId)) badRequest('document_id: not found for this driver');
  }
  const id = newId();
  const statements = [insertRow(c.env.DB, 'dqf_items', { id, tenant_id: auth.tenantId, driver_id: driverId, recorded_by: auth.userId, ...input })];
  // The medical card on the driver profile (dashboard alerts, dispatch) follows the newest certificate.
  if (input.item_type === 'medical_certificate') {
    statements.push(c.env.DB.prepare('UPDATE drivers SET medical_expires_on = ? WHERE tenant_id = ? AND id = ? AND (medical_expires_on IS NULL OR medical_expires_on < ?)')
      .bind(input.expires_on!, auth.tenantId, driverId, input.expires_on!));
  }
  await c.env.DB.batch(statements);
  return c.json({ item: await c.env.DB.prepare('SELECT * FROM dqf_items WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});

dqf.delete('/items/:id', requireRole('owner'), async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM dqf_items WHERE tenant_id = ? AND id = ?').bind(c.get('auth').tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Item not found');
  return c.body(null, 204);
});
