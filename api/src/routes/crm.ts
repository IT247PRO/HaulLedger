import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { insertRow, newId, notFound } from '../lib/http';
import { roundDiv } from '../lib/money';
import { body, optText } from '../lib/validate';

/** Broker / shipper CRM: contacts, notes, and lane + rate history from real loads. */
export const crm = new Hono<AppEnv>();
crm.use('*', requireRole('owner', 'dispatcher'));

async function assertCustomer(db: D1Database, tenantId: string, id: string) {
  if (!(await db.prepare('SELECT 1 FROM customers WHERE tenant_id = ? AND id = ?').bind(tenantId, id).first())) notFound('Customer not found');
}

crm.get('/customers/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const db = c.env.DB;
  const customer = await db.prepare('SELECT * FROM customers WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first();
  if (!customer) notFound('Customer not found');
  const [contacts, notes, loads, pay, ar] = await Promise.all([
    db.prepare('SELECT id, name, role, email, phone FROM customer_contacts WHERE tenant_id = ? AND customer_id = ? ORDER BY name').bind(auth.tenantId, id).all(),
    db.prepare(`SELECT n.id, n.body, n.created_at, u.name AS author FROM customer_notes n LEFT JOIN users u ON u.tenant_id = n.tenant_id AND u.id = n.created_by
                 WHERE n.tenant_id = ? AND n.customer_id = ? ORDER BY n.created_at DESC LIMIT 100`).bind(auth.tenantId, id).all(),
    db.prepare(
      `SELECT l.id, l.load_number, l.status, l.delivered_at, l.created_at, l.rate_cents + l.fuel_surcharge_cents + l.accessorial_cents AS gross_cents, l.loaded_miles,
              (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq LIMIT 1) AS origin,
              (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq DESC LIMIT 1) AS destination
         FROM loads l WHERE l.tenant_id = ? AND l.customer_id = ? AND l.status <> 'cancelled' ORDER BY l.created_at DESC`,
    ).bind(auth.tenantId, id).all<{ id: string; load_number: string; status: string; delivered_at: string | null; created_at: string; gross_cents: number; loaded_miles: number | null; origin: string; destination: string }>(),
    db.prepare(`SELECT AVG(julianday(paid_on) - julianday(issued_on)) AS days, COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND customer_id = ? AND status = 'paid' AND paid_on IS NOT NULL`)
      .bind(auth.tenantId, id).first<{ days: number | null; n: number }>(),
    db.prepare(`SELECT COALESCE(SUM(total_cents - paid_cents), 0) AS open, COALESCE(SUM(CASE WHEN due_on < date('now') THEN total_cents - paid_cents ELSE 0 END), 0) AS past_due
                  FROM invoices WHERE tenant_id = ? AND customer_id = ? AND status = 'open'`).bind(auth.tenantId, id).first<{ open: number; past_due: number }>(),
  ]);

  // Lane history: what this customer pays on each origin → destination.
  const lanes = new Map<string, { lane: string; loads: number; gross_cents: number; miles: number; last_rate_cents: number; last_date: string }>();
  for (const l of loads.results) {
    const key = `${l.origin} → ${l.destination}`;
    const day = (l.delivered_at ?? l.created_at).slice(0, 10);
    const lane = lanes.get(key) ?? { lane: key, loads: 0, gross_cents: 0, miles: 0, last_rate_cents: l.gross_cents, last_date: day };
    lane.loads++;
    lane.gross_cents += l.gross_cents;
    lane.miles += l.loaded_miles ?? 0;
    if (day > lane.last_date) {
      lane.last_date = day;
      lane.last_rate_cents = l.gross_cents;
    }
    lanes.set(key, lane);
  }
  const totalGross = loads.results.reduce((a, l) => a + l.gross_cents, 0);
  const totalMiles = loads.results.reduce((a, l) => a + (l.loaded_miles ?? 0), 0);
  return c.json({
    customer,
    contacts: contacts.results,
    notes: notes.results,
    stats: {
      loads: loads.results.length,
      gross_cents: totalGross,
      rate_per_loaded_mile_cents: totalMiles ? roundDiv(totalGross, totalMiles) : null,
      avg_days_to_pay: pay?.days === null || pay?.days === undefined ? null : Math.round(pay.days),
      paid_invoices: pay?.n ?? 0,
      open_ar_cents: ar?.open ?? 0,
      past_due_cents: ar?.past_due ?? 0,
    },
    lanes: [...lanes.values()]
      .map((l) => ({ ...l, avg_rate_cents: roundDiv(l.gross_cents, l.loads), rate_per_mile_cents: l.miles ? roundDiv(l.gross_cents, l.miles) : null }))
      .sort((a, b) => b.loads - a.loads),
    recent_loads: loads.results.slice(0, 20),
  });
});

const contactSchema = z.strictObject({ name: z.string().trim().min(1).max(200), role: optText, email: z.email().nullable().optional(), phone: optText });

crm.post('/customers/:id/contacts', async (c) => {
  const auth = c.get('auth');
  await assertCustomer(c.env.DB, auth.tenantId, c.req.param('id'));
  const input = await body(c, contactSchema);
  const id = newId();
  await insertRow(c.env.DB, 'customer_contacts', { id, tenant_id: auth.tenantId, customer_id: c.req.param('id'), ...input }).run();
  return c.json({ id }, 201);
});

crm.delete('/contacts/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM customer_contacts WHERE tenant_id = ? AND id = ?').bind(c.get('auth').tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Contact not found');
  return c.body(null, 204);
});

crm.post('/customers/:id/notes', async (c) => {
  const auth = c.get('auth');
  await assertCustomer(c.env.DB, auth.tenantId, c.req.param('id'));
  const { body: text } = await body(c, z.strictObject({ body: z.string().trim().min(1).max(5000) }));
  const id = newId();
  await insertRow(c.env.DB, 'customer_notes', { id, tenant_id: auth.tenantId, customer_id: c.req.param('id'), body: text, created_by: auth.userId }).run();
  return c.json({ id }, 201);
});
