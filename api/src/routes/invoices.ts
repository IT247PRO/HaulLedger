import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { badRequest, conflict, insertRow, newId, notFound, nowIso } from '../lib/http';
import { sum } from '../lib/money';
import { body, cents, isoDate, optText } from '../lib/validate';

export const invoices = new Hono<AppEnv>();
invoices.use('*', requireRole('owner', 'dispatcher'));

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const todayIso = () => new Date().toISOString().slice(0, 10);

/** Loads already on a live (non-void) invoice. */
async function billedLoads(db: D1Database, tenantId: string, loadIds: string[]): Promise<Set<string>> {
  if (!loadIds.length) return new Set();
  const { results } = await db
    .prepare(
      `SELECT DISTINCT il.load_id FROM invoice_lines il JOIN invoices i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
        WHERE il.tenant_id = ? AND i.status <> 'void' AND il.load_id IN (${loadIds.map(() => '?').join(',')})`,
    )
    .bind(tenantId, ...loadIds)
    .all<{ load_id: string }>();
  return new Set(results.map((r) => r.load_id));
}

/** Delivered loads not yet invoiced: the billing queue. POD status leads, because cash flow waits on it. */
invoices.get('/unbilled', async (c) => {
  const auth = c.get('auth');
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.load_number, l.reference_number, l.customer_id, cu.name AS customer_name, l.delivered_at, l.pod_received_at,
            l.rate_cents + l.fuel_surcharge_cents + l.accessorial_cents AS gross_cents,
            (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq LIMIT 1) AS origin,
            (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq DESC LIMIT 1) AS destination
       FROM loads l LEFT JOIN customers cu ON cu.tenant_id = l.tenant_id AND cu.id = l.customer_id
      WHERE l.tenant_id = ? AND l.status = 'delivered'
        AND NOT EXISTS (SELECT 1 FROM invoice_lines il JOIN invoices i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
                         WHERE il.tenant_id = l.tenant_id AND il.load_id = l.id AND i.status <> 'void')
      ORDER BY l.delivered_at`,
  )
    .bind(auth.tenantId)
    .all();
  return c.json({ loads: results });
});

invoices.get('/', async (c) => {
  const auth = c.get('auth');
  const q = c.req.query();
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.invoice_number, i.customer_id, cu.name AS customer_name, i.status, i.issued_on, i.due_on, i.total_cents, i.paid_cents,
            i.total_cents - i.paid_cents AS balance_cents, i.paid_on, i.sent_at,
            (SELECT COUNT(*) FROM invoice_lines il WHERE il.tenant_id = i.tenant_id AND il.invoice_id = i.id AND il.kind = 'linehaul') AS load_count
       FROM invoices i JOIN customers cu ON cu.tenant_id = i.tenant_id AND cu.id = i.customer_id
      WHERE i.tenant_id = ?1 AND (?2 IS NULL OR i.status = ?2) AND (?3 IS NULL OR i.customer_id = ?3)
      ORDER BY i.issued_on DESC, i.invoice_number DESC LIMIT 500`,
  )
    .bind(auth.tenantId, q.status ?? null, q.customer_id ?? null)
    .all();
  return c.json({ invoices: results });
});

export async function invoiceDetail(db: D1Database, tenantId: string, id: string) {
  const invoice = await db
    .prepare(
      `SELECT i.*, i.total_cents - i.paid_cents AS balance_cents, cu.name AS customer_name, cu.billing_address, cu.email AS customer_email,
              cu.mc_number AS customer_mc, t.name AS carrier_name
         FROM invoices i JOIN customers cu ON cu.tenant_id = i.tenant_id AND cu.id = i.customer_id JOIN tenants t ON t.id = i.tenant_id
        WHERE i.tenant_id = ? AND i.id = ?`,
    )
    .bind(tenantId, id)
    .first<Record<string, any> & { id: string; status: string; total_cents: number; paid_cents: number; invoice_number: string }>();
  if (!invoice) notFound('Invoice not found');
  const [lines, payments, docs] = await Promise.all([
    db.prepare(
      `SELECT il.id, il.seq, il.load_id, il.kind, il.description, il.amount_cents, l.load_number, l.reference_number, l.delivered_at, l.pod_received_at
         FROM invoice_lines il LEFT JOIN loads l ON l.tenant_id = il.tenant_id AND l.id = il.load_id
        WHERE il.tenant_id = ? AND il.invoice_id = ? ORDER BY il.seq`,
    ).bind(tenantId, id).all(),
    db.prepare('SELECT id, amount_cents, received_on, method, reference FROM invoice_payments WHERE tenant_id = ? AND invoice_id = ? ORDER BY received_on').bind(tenantId, id).all(),
    // The billing packet: rate con, BOL and POD for every load on the invoice.
    db.prepare(
      `SELECT d.id, d.kind, d.filename, d.load_id FROM documents d
        WHERE d.tenant_id = ?1 AND d.kind IN ('rate_confirmation', 'bol', 'pod', 'lumper', 'scale')
          AND d.load_id IN (SELECT load_id FROM invoice_lines WHERE tenant_id = ?1 AND invoice_id = ?2) ORDER BY d.load_id, d.kind`,
    ).bind(tenantId, id).all(),
  ]);
  return { ...invoice, lines: lines.results, payments: payments.results, documents: docs.results };
}

invoices.get('/:id', async (c) => c.json({ invoice: await invoiceDetail(c.env.DB, c.get('auth').tenantId, c.req.param('id')) }));

const createSchema = z.strictObject({
  customer_id: z.string().max(64),
  load_ids: z.array(z.string().max(64)).min(1).max(100),
  issued_on: isoDate.optional(),
  terms_days: z.int().min(0).max(180).optional(),
  notes: optText,
});

invoices.post('/', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, createSchema);
  const db = c.env.DB;
  const customer = await db.prepare('SELECT id FROM customers WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, input.customer_id).first();
  if (!customer) badRequest('customer_id: not found');
  const ids = [...new Set(input.load_ids)];
  const { results: loads } = await db
    .prepare(
      `SELECT l.id, l.load_number, l.reference_number, l.customer_id, l.status, l.rate_cents, l.fuel_surcharge_cents, l.accessorial_cents, l.pod_received_at,
              (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq LIMIT 1) AS origin,
              (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq DESC LIMIT 1) AS destination
         FROM loads l WHERE l.tenant_id = ? AND l.id IN (${ids.map(() => '?').join(',')}) ORDER BY l.delivered_at`,
    )
    .bind(auth.tenantId, ...ids)
    .all<{ id: string; load_number: string; reference_number: string | null; customer_id: string | null; status: string; rate_cents: number; fuel_surcharge_cents: number; accessorial_cents: number; pod_received_at: string | null; origin: string; destination: string }>();
  if (loads.length !== ids.length) badRequest('load_ids: one or more loads not found');
  for (const l of loads) {
    if (l.status !== 'delivered') badRequest(`${l.load_number} is not delivered yet`);
    if (l.customer_id !== input.customer_id) badRequest(`${l.load_number} belongs to a different customer`);
  }
  const billed = await billedLoads(db, auth.tenantId, ids);
  if (billed.size) conflict(`Already invoiced: ${loads.filter((l) => billed.has(l.id)).map((l) => l.load_number).join(', ')}`);

  const lines: { load_id: string; kind: string; description: string; amount_cents: number }[] = [];
  for (const l of loads) {
    const ref = l.reference_number ? ` (ref ${l.reference_number})` : '';
    lines.push({ load_id: l.id, kind: 'linehaul', description: `${l.load_number}${ref}: ${l.origin} → ${l.destination}`, amount_cents: l.rate_cents });
    if (l.fuel_surcharge_cents) lines.push({ load_id: l.id, kind: 'fuel_surcharge', description: `${l.load_number} fuel surcharge`, amount_cents: l.fuel_surcharge_cents });
    if (l.accessorial_cents) lines.push({ load_id: l.id, kind: 'accessorial', description: `${l.load_number} accessorials`, amount_cents: l.accessorial_cents });
  }
  const issued = input.issued_on ?? todayIso();
  const terms = input.terms_days ?? 30;
  const id = newId();
  const count = await db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ?').bind(auth.tenantId).first<{ n: number }>();
  const invoiceNumber = `INV-${10001 + (count?.n ?? 0)}`;
  await db.batch([
    insertRow(db, 'invoices', {
      id, tenant_id: auth.tenantId, invoice_number: invoiceNumber, customer_id: input.customer_id, issued_on: issued, terms_days: terms,
      due_on: addDays(issued, terms), total_cents: sum(lines.map((l) => l.amount_cents)), notes: input.notes ?? null, created_by: auth.userId,
    }),
    ...lines.map((l, i) => insertRow(db, 'invoice_lines', { id: newId(), tenant_id: auth.tenantId, invoice_id: id, seq: i + 1, ...l })),
  ]);
  const missingPod = loads.filter((l) => !l.pod_received_at).map((l) => l.load_number);
  return c.json({ invoice: await invoiceDetail(db, auth.tenantId, id), warnings: missingPod.length ? [`No POD on file for ${missingPod.join(', ')} — most customers and factors will not pay without one`] : [] }, 201);
});

const paymentSchema = z.strictObject({
  amount_cents: cents.min(1),
  received_on: isoDate,
  method: z.enum(['ach', 'check', 'wire', 'card', 'factor', 'other']).optional(),
  reference: optText,
});

invoices.post('/:id/payments', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, paymentSchema);
  const db = c.env.DB;
  const inv = await invoiceDetail(db, auth.tenantId, c.req.param('id'));
  if (inv.status === 'void') conflict('Invoice is void');
  if (input.amount_cents > inv.total_cents - inv.paid_cents) badRequest('Payment is more than the balance due');
  const paid = inv.paid_cents + input.amount_cents;
  const full = paid === inv.total_cents;
  await db.batch([
    insertRow(db, 'invoice_payments', { id: newId(), tenant_id: auth.tenantId, invoice_id: inv.id, created_by: auth.userId, ...input }),
    db.prepare(`UPDATE invoices SET paid_cents = ?, status = ?, paid_on = ? WHERE tenant_id = ? AND id = ? AND paid_cents = ?`).bind(
      paid, full ? 'paid' : 'open', full ? input.received_on : null, auth.tenantId, inv.id, inv.paid_cents,
    ),
  ]);
  return c.json({ invoice: await invoiceDetail(db, auth.tenantId, inv.id) }, 201);
});

invoices.post('/:id/mark-sent', async (c) => {
  const auth = c.get('auth');
  const res = await c.env.DB.prepare(`UPDATE invoices SET sent_at = COALESCE(sent_at, ?) WHERE tenant_id = ? AND id = ? AND status <> 'void'`).bind(nowIso(), auth.tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Invoice not found');
  return c.json({ invoice: await invoiceDetail(c.env.DB, auth.tenantId, c.req.param('id')) });
});

/** Voiding releases the loads for re-billing. An invoice with payments cannot be voided. */
invoices.post('/:id/void', async (c) => {
  const auth = c.get('auth');
  const res = await c.env.DB.prepare(`UPDATE invoices SET status = 'void' WHERE tenant_id = ? AND id = ? AND status = 'open' AND paid_cents = 0`).bind(auth.tenantId, c.req.param('id')).run();
  if (!res.meta.changes) conflict('Only an unpaid open invoice can be voided');
  return c.json({ invoice: await invoiceDetail(c.env.DB, auth.tenantId, c.req.param('id')) });
});
