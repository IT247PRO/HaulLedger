import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { badRequest, conflict, insertRow, newId, notFound, nowIso } from '../lib/http';
import { roundDiv } from '../lib/money';
import { body, cents, isoDate, optText } from '../lib/validate';
import { invoiceDetail } from './invoices';

/**
 * Factoring. RTS, Triumph and most factors accept schedules by email with the
 * invoice, rate confirmation, BOL and POD attached; HaulLedger sends that packet
 * and tracks funding. (A direct API submission can replace the email step per
 * factor once one offers a public API.)
 */
export const factoring = new Hono<AppEnv>();
factoring.use('*', requireRole('owner', 'dispatcher'));
const ownerOnly = requireRole('owner');

const companySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  submission_email: z.email(),
  fee_bp: z.int().min(0).max(2000),
  recourse: z.boolean().optional(),
});

factoring.get('/companies', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM factoring_companies WHERE tenant_id = ? ORDER BY name').bind(c.get('auth').tenantId).all();
  return c.json({ companies: results });
});

factoring.post('/companies', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, companySchema);
  const id = newId();
  await insertRow(c.env.DB, 'factoring_companies', { id, tenant_id: auth.tenantId, ...input, recourse: input.recourse ? 1 : 0 }).run();
  return c.json({ company: await c.env.DB.prepare('SELECT * FROM factoring_companies WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});

factoring.get('/submissions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, i.invoice_number, i.total_cents, f.name AS factor_name, cu.name AS customer_name
       FROM factoring_submissions s JOIN invoices i ON i.tenant_id = s.tenant_id AND i.id = s.invoice_id
       JOIN factoring_companies f ON f.tenant_id = s.tenant_id AND f.id = s.factor_id
       JOIN customers cu ON cu.tenant_id = i.tenant_id AND cu.id = i.customer_id
      WHERE s.tenant_id = ? ORDER BY s.submitted_at DESC LIMIT 500`,
  )
    .bind(c.get('auth').tenantId)
    .all();
  return c.json({ submissions: results });
});

const toBase64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

factoring.post('/submit', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, z.strictObject({ invoice_id: z.string().max(64), factor_id: z.string().max(64) }));
  const db = c.env.DB;
  const factor = await db.prepare('SELECT * FROM factoring_companies WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, input.factor_id).first<{ id: string; name: string; submission_email: string; fee_bp: number }>();
  if (!factor) badRequest('factor_id: not found');
  const inv = await invoiceDetail(db, auth.tenantId, input.invoice_id);
  if (inv.status !== 'open' || inv.paid_cents > 0) conflict('Only an open, unpaid invoice can be factored');
  const live = await db.prepare(`SELECT 1 FROM factoring_submissions WHERE tenant_id = ? AND invoice_id = ? AND status <> 'rejected'`).bind(auth.tenantId, inv.id).first();
  if (live) conflict('This invoice was already submitted to a factor');
  // Factors fund on paperwork: every load needs its POD in the packet.
  const loadIds = [...new Set((inv.lines as any[]).map((l) => l.load_id).filter(Boolean))] as string[];
  const docs = inv.documents as { id: string; kind: string; filename: string; load_id: string }[];
  const missing = (inv.lines as any[]).filter((l) => l.kind === 'linehaul' && !docs.some((d) => d.load_id === l.load_id && d.kind === 'pod')).map((l) => l.load_number);
  if (missing.length) badRequest(`Attach the POD before factoring: ${missing.join(', ')}`);
  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) throw new HTTPException(501, { message: 'Email is not configured. Set RESEND_API_KEY and EMAIL_FROM to send factoring packets.' });

  const attachments: { filename: string; content: string }[] = [];
  let bytes = 0;
  for (const d of docs) {
    const row = await db.prepare('SELECT r2_key FROM documents WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, d.id).first<{ r2_key: string }>();
    const obj = row ? await c.env.DOCS.get(row.r2_key) : null;
    if (!obj) continue;
    const buf = await obj.arrayBuffer();
    bytes += buf.byteLength;
    if (bytes > 30 * 1024 * 1024) badRequest('Packet is over 30 MB; send the largest files separately');
    const load = (inv.lines as any[]).find((l) => l.load_id === d.load_id);
    attachments.push({ filename: `${load?.load_number ?? 'load'}-${d.kind}-${d.filename}`, content: toBase64(buf) });
  }
  const money = (x: number) => `$${Math.floor(x / 100).toLocaleString('en-US')}.${String(x % 100).padStart(2, '0')}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: c.env.EMAIL_FROM,
      to: factor.submission_email,
      subject: `Schedule: ${inv.carrier_name} invoice ${inv.invoice_number} — ${inv.customer_name} — ${money(inv.total_cents)}`,
      html: `<p>${inv.carrier_name} submits invoice <strong>${inv.invoice_number}</strong> for purchase.</p>
<p>Debtor: ${inv.customer_name}${inv.customer_mc ? ` (${inv.customer_mc})` : ''}<br>Amount: ${money(inv.total_cents)}<br>Issued ${inv.issued_on}, due ${inv.due_on}<br>Loads: ${loadIds.length}</p>
<p>Attached: rate confirmations, BOLs and PODs.</p>`,
      attachments,
    }),
  });
  if (!res.ok) throw new HTTPException(502, { message: `Email provider rejected the packet (${res.status})` });
  const id = newId();
  await insertRow(db, 'factoring_submissions', { id, tenant_id: auth.tenantId, invoice_id: inv.id, factor_id: factor.id, submitted_at: nowIso(), created_by: auth.userId }).run();
  return c.json({ submission_id: id, sent_to: factor.submission_email, attachments: attachments.length }, 201);
});

const fundedSchema = z.strictObject({ funded_on: isoDate, fee_cents: cents.optional(), reference: optText });

/** Funding settles the invoice (the factor bought it) and books the fee as an expense. */
factoring.post('/submissions/:id/funded', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, fundedSchema);
  const db = c.env.DB;
  const sub = await db.prepare(
    `SELECT s.id, s.invoice_id, s.status, f.fee_bp, f.name, i.total_cents, i.paid_cents, i.invoice_number FROM factoring_submissions s
       JOIN factoring_companies f ON f.tenant_id = s.tenant_id AND f.id = s.factor_id JOIN invoices i ON i.tenant_id = s.tenant_id AND i.id = s.invoice_id
      WHERE s.tenant_id = ? AND s.id = ?`,
  )
    .bind(auth.tenantId, c.req.param('id'))
    .first<{ id: string; invoice_id: string; status: string; fee_bp: number; name: string; total_cents: number; paid_cents: number; invoice_number: string }>();
  if (!sub) notFound('Submission not found');
  if (sub.status !== 'submitted') conflict('Already resolved');
  const balance = sub.total_cents - sub.paid_cents;
  const fee = input.fee_cents ?? roundDiv(sub.total_cents * sub.fee_bp, 10_000);
  if (fee > balance) badRequest('Fee is more than the invoice');
  const statements = [
    db.prepare(`UPDATE factoring_submissions SET status = 'funded', funded_on = ?, fee_cents = ?, funded_cents = ?, reference = ? WHERE tenant_id = ? AND id = ? AND status = 'submitted'`)
      .bind(input.funded_on, fee, balance - fee, input.reference ?? null, auth.tenantId, sub.id),
    insertRow(db, 'invoice_payments', { id: newId(), tenant_id: auth.tenantId, invoice_id: sub.invoice_id, amount_cents: balance, received_on: input.funded_on, method: 'factor', reference: input.reference ?? sub.name, created_by: auth.userId }),
    db.prepare(`UPDATE invoices SET paid_cents = total_cents, status = 'paid', paid_on = ? WHERE tenant_id = ? AND id = ?`).bind(input.funded_on, auth.tenantId, sub.invoice_id),
  ];
  if (fee > 0) {
    statements.push(insertRow(db, 'expenses', { id: newId(), tenant_id: auth.tenantId, category: 'factoring_fees', amount_cents: fee, incurred_on: input.funded_on, vendor: sub.name, description: `Factoring fee on ${sub.invoice_number}`, created_by: auth.userId }));
  }
  await db.batch(statements);
  return c.json({ funded_cents: balance - fee, fee_cents: fee });
});

factoring.post('/submissions/:id/rejected', ownerOnly, async (c) => {
  const { notes } = await body(c, z.strictObject({ notes: optText }));
  const res = await c.env.DB.prepare(`UPDATE factoring_submissions SET status = 'rejected', notes = ? WHERE tenant_id = ? AND id = ? AND status = 'submitted'`)
    .bind(notes ?? null, c.get('auth').tenantId, c.req.param('id'))
    .run();
  if (!res.meta.changes) conflict('Only a pending submission can be rejected');
  return c.json({ ok: true });
});
