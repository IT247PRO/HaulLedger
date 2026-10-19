import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, Auth } from '../types';
import { requireRole } from '../lib/auth';
import { badRequest, conflict, insertRow, newId, notFound, nowIso } from '../lib/http';
import { sum } from '../lib/money';
import { computeLoadPay, escrowHold, type PayLoad, type PayRate } from '../lib/pay';
import { body, isoDate } from '../lib/validate';
import { canReadDocument, DOC_COLUMNS, type DocumentRow } from './documents';
import { escrowBalance, getDriver } from './pay';

export const settlements = new Hono<AppEnv>();
const ownerOnly = requireRole('owner');

type LineKind = 'load_pay' | 'per_diem' | 'reimbursement' | 'advance' | 'deduction' | 'escrow_hold' | 'escrow_release';

interface NewLine {
  kind: LineKind;
  description: string;
  amount_cents: number;
  load_id?: string;
  pay_rate_id?: string;
  pay_kind?: string;
  quantity?: number;
  quantity_unit?: string;
  unit_rate?: number;
  gross_cents?: number | null;
  rate_bp?: number | null;
  advance_id?: string;
  charge_id?: string;
  reimbursement_id?: string;
  escrow_tx_id?: string;
}

/** Totals by bucket, always derived from the lines themselves. */
export function totals(lines: { kind: LineKind; amount_cents: number }[]) {
  const by = (...kinds: LineKind[]) => sum(lines.filter((l) => kinds.includes(l.kind)).map((l) => l.amount_cents));
  return {
    load_pay_cents: by('load_pay'),
    per_diem_cents: by('per_diem'),
    reimbursement_cents: by('reimbursement'),
    advance_cents: by('advance'),
    deduction_cents: by('deduction'),
    escrow_cents: by('escrow_hold', 'escrow_release'),
    net_cents: sum(lines.map((l) => l.amount_cents)),
  };
}

const generateSchema = z.strictObject({
  driver_id: z.string().max(64),
  period_start: isoDate,
  period_end: isoDate,
  /** Hold loads with no POD on file (the default): cash flow and disputes both start with the POD. */
  require_pod: z.boolean().optional(),
});

interface LoadForPay extends PayLoad {
  pod_received_at: string | null;
}

settlements.post('/', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const input = await body(c, generateSchema);
  if (input.period_end < input.period_start) badRequest('period_end is before period_start');
  const requirePod = input.require_pod ?? true;
  const db = c.env.DB;
  const driver = await getDriver(db, auth.tenantId, input.driver_id);

  const draft = await db.prepare(`SELECT settlement_number FROM settlements WHERE tenant_id = ? AND driver_id = ? AND status = 'draft'`)
    .bind(auth.tenantId, driver.id)
    .first<{ settlement_number: string }>();
  if (draft) conflict(`${draft.settlement_number} is still a draft for this driver; finalize or delete it first`);

  const settlementId = newId();
  const count = await db.prepare('SELECT COUNT(*) AS n FROM settlements WHERE tenant_id = ?').bind(auth.tenantId).first<{ n: number }>();
  const settlementNumber = `S-${1001 + (count?.n ?? 0)}`;
  const lines: NewLine[] = [];
  const warnings: string[] = [];
  const statements: D1PreparedStatement[] = [];

  // 1. Delivered, unpaid loads up to the period end (late paperwork from earlier weeks is included).
  const { results: loads } = await db
    .prepare(
      `SELECT l.id, l.load_number, l.rate_cents, l.fuel_surcharge_cents, l.accessorial_cents, l.loaded_miles, l.empty_miles,
              l.pay_hours_x100, l.dispatched_at, l.delivered_at, l.pod_received_at,
              (SELECT COUNT(*) FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id) AS stop_count
         FROM loads l
        WHERE l.tenant_id = ?1 AND l.driver_id = ?2 AND l.status = 'delivered' AND substr(l.delivered_at, 1, 10) <= ?3
          AND NOT EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl.tenant_id = l.tenant_id AND sl.load_id = l.id AND sl.pay_rate_id IS NOT NULL)
        ORDER BY l.delivered_at`,
    )
    .bind(auth.tenantId, driver.id, input.period_end)
    .all<LoadForPay>();
  const { results: rates } = await db
    .prepare('SELECT id, kind, rate, basis, effective_from, effective_to FROM driver_pay_rates WHERE tenant_id = ? AND driver_id = ?')
    .bind(auth.tenantId, driver.id)
    .all<PayRate & { effective_from: string; effective_to: string | null }>();

  for (const load of loads) {
    if (requirePod && !load.pod_received_at) {
      warnings.push(`${load.load_number}: held — no POD on file`);
      continue;
    }
    const day = load.delivered_at!.slice(0, 10);
    const applicable = rates.filter(
      (r) => r.effective_from <= day && (!r.effective_to || r.effective_to >= day) && (r.kind !== 'per_diem' || driver.pay_track === 'w2'),
    );
    if (applicable.length === 0) {
      warnings.push(`${load.load_number}: held — no pay rate in effect on ${day}`);
      continue;
    }
    for (const rate of applicable) {
      const result = computeLoadPay(load, rate);
      if ('skip' in result) {
        warnings.push(result.skip);
        continue;
      }
      const { line } = result;
      lines.push({
        kind: rate.kind === 'per_diem' ? 'per_diem' : 'load_pay',
        description: `${load.load_number} — ${line.description}`,
        amount_cents: line.amount_cents,
        load_id: load.id,
        pay_rate_id: line.pay_rate_id,
        pay_kind: line.pay_kind,
        quantity: line.quantity,
        quantity_unit: line.quantity_unit,
        unit_rate: line.unit_rate,
        gross_cents: line.gross_cents,
        rate_bp: line.rate_bp,
      });
    }
  }

  // 2. Approved reimbursements.
  const { results: reimbursements } = await db
    .prepare(
      `SELECT r.id, r.category, r.amount_cents, r.description, r.incurred_on FROM driver_reimbursements r
        WHERE r.tenant_id = ?1 AND r.driver_id = ?2 AND r.status = 'approved' AND r.incurred_on <= ?3
          AND NOT EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl.tenant_id = r.tenant_id AND sl.reimbursement_id = r.id)
        ORDER BY r.incurred_on`,
    )
    .bind(auth.tenantId, driver.id, input.period_end)
    .all<{ id: string; category: string; amount_cents: number; description: string; incurred_on: string }>();
  for (const r of reimbursements) {
    lines.push({ kind: 'reimbursement', description: `Reimbursement (${r.category}) ${r.incurred_on}: ${r.description}`, amount_cents: r.amount_cents, reimbursement_id: r.id });
  }

  // 3. Advances to recover.
  const { results: advances } = await db
    .prepare(
      `SELECT a.id, a.amount_cents, a.issued_on, a.method, a.reference, a.memo FROM driver_advances a
        WHERE a.tenant_id = ?1 AND a.driver_id = ?2 AND a.issued_on <= ?3
          AND NOT EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl.tenant_id = a.tenant_id AND sl.advance_id = a.id)
        ORDER BY a.issued_on`,
    )
    .bind(auth.tenantId, driver.id, input.period_end)
    .all<{ id: string; amount_cents: number; issued_on: string; method: string; reference: string | null; memo: string | null }>();
  for (const a of advances) {
    const ref = a.reference ? ` #${a.reference}` : '';
    lines.push({ kind: 'advance', description: `Advance ${a.issued_on} (${a.method}${ref})${a.memo ? `: ${a.memo}` : ''}`, amount_cents: -a.amount_cents, advance_id: a.id });
  }

  // 4. Recurring deductions become charge records first, so each line still cites a source row.
  const { results: recurring } = await db
    .prepare('SELECT id, category, amount_cents, description FROM recurring_deductions WHERE tenant_id = ? AND driver_id = ? AND active = 1 ORDER BY category')
    .bind(auth.tenantId, driver.id)
    .all<{ id: string; category: string; amount_cents: number; description: string }>();
  for (const r of recurring) {
    const chargeId = newId();
    statements.push(
      insertRow(db, 'driver_charges', {
        id: chargeId,
        tenant_id: auth.tenantId,
        driver_id: driver.id,
        category: r.category,
        amount_cents: r.amount_cents,
        incurred_on: input.period_end,
        description: r.description,
        recurring_deduction_id: r.id,
        origin_settlement_id: settlementId,
        created_by: auth.userId,
      }),
    );
    lines.push({ kind: 'deduction', description: `${label(r.category)} (recurring): ${r.description}`, amount_cents: -r.amount_cents, charge_id: chargeId });
  }

  // 5. One-off charges (fuel-card purchases, damage, carried-forward deficits...).
  const { results: charges } = await db
    .prepare(
      `SELECT ch.id, ch.category, ch.amount_cents, ch.description, ch.incurred_on FROM driver_charges ch
        WHERE ch.tenant_id = ?1 AND ch.driver_id = ?2 AND ch.incurred_on <= ?3
          AND NOT EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl.tenant_id = ch.tenant_id AND sl.charge_id = ch.id)
        ORDER BY ch.incurred_on`,
    )
    .bind(auth.tenantId, driver.id, input.period_end)
    .all<{ id: string; category: string; amount_cents: number; description: string; incurred_on: string }>();
  for (const ch of charges) {
    lines.push({ kind: 'deduction', description: `${label(ch.category)} ${ch.incurred_on}: ${ch.description}`, amount_cents: -ch.amount_cents, charge_id: ch.id });
  }

  // 6. Escrow (1099 only): pay out pending releases, then hold toward the target.
  if (driver.pay_track === '1099') {
    const { results: releases } = await db
      .prepare(`SELECT id, amount_cents, memo, occurred_on FROM escrow_transactions WHERE tenant_id = ? AND driver_id = ? AND kind = 'release' AND settlement_id IS NULL`)
      .bind(auth.tenantId, driver.id)
      .all<{ id: string; amount_cents: number; memo: string | null; occurred_on: string }>();
    for (const r of releases) {
      statements.push(
        db.prepare('UPDATE escrow_transactions SET settlement_id = ? WHERE tenant_id = ? AND id = ? AND settlement_id IS NULL').bind(settlementId, auth.tenantId, r.id),
      );
      lines.push({ kind: 'escrow_release', description: `Escrow release ${r.occurred_on}${r.memo ? `: ${r.memo}` : ''}`, amount_cents: -r.amount_cents, escrow_tx_id: r.id });
    }
    const hold = escrowHold({
      perSettlement: driver.escrow_per_settlement_cents,
      target: driver.escrow_target_cents,
      balance: await escrowBalance(db, auth.tenantId, driver.id),
      availableNet: Math.max(0, sum(lines.map((l) => l.amount_cents))),
    });
    if (hold > 0) {
      const txId = newId();
      statements.push(
        insertRow(db, 'escrow_transactions', {
          id: txId,
          tenant_id: auth.tenantId,
          driver_id: driver.id,
          kind: 'hold',
          amount_cents: hold,
          occurred_on: input.period_end,
          memo: `Held on ${settlementNumber}`,
          settlement_id: settlementId,
          created_by: auth.userId,
        }),
      );
      lines.push({ kind: 'escrow_hold', description: `Escrow hold toward ${money(driver.escrow_target_cents)} target`, amount_cents: -hold, escrow_tx_id: txId });
    }
  }

  const t = totals(lines);
  await db.batch([
    insertRow(db, 'settlements', {
      id: settlementId,
      tenant_id: auth.tenantId,
      settlement_number: settlementNumber,
      driver_id: driver.id,
      pay_track: driver.pay_track,
      period_start: input.period_start,
      period_end: input.period_end,
      created_by: auth.userId,
      ...t,
    }),
    ...statements,
    ...lines.map((line, i) => insertRow(db, 'settlement_lines', { id: newId(), tenant_id: auth.tenantId, settlement_id: settlementId, seq: i + 1, ...line })),
  ]);
  return c.json({ settlement: await settlementDetail(db, auth, settlementId), warnings }, 201);
});

settlements.get('/', async (c) => {
  const auth = c.get('auth');
  if (auth.role === 'dispatcher') throw new HTTPException(403, { message: 'Forbidden' });
  // Drivers see their own settlements once finalized; drafts can still change.
  const driverId = auth.role === 'driver' ? auth.driverId : (c.req.query('driver_id') ?? null);
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.settlement_number, s.driver_id, d.first_name || ' ' || d.last_name AS driver_name, s.pay_track,
            s.period_start, s.period_end, s.status, s.load_pay_cents, s.per_diem_cents, s.reimbursement_cents,
            s.advance_cents, s.deduction_cents, s.escrow_cents, s.net_cents, s.finalized_at, s.paid_at
       FROM settlements s JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
      WHERE s.tenant_id = ?1 AND (?2 IS NULL OR s.driver_id = ?2) AND (?3 = 0 OR s.status <> 'draft')
      ORDER BY s.period_end DESC, s.settlement_number DESC LIMIT 500`,
  )
    .bind(auth.tenantId, driverId, auth.role === 'driver' ? 1 : 0)
    .all();
  return c.json({ settlements: results });
});

settlements.get('/:id', async (c) => {
  const auth = c.get('auth');
  if (auth.role === 'dispatcher') throw new HTTPException(403, { message: 'Forbidden' });
  return c.json({ settlement: await settlementDetail(c.env.DB, auth, c.req.param('id')) });
});

settlements.post('/:id/finalize', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const s = await settlementDetail(db, auth, c.req.param('id'));
  if (s.status !== 'draft') conflict('Only a draft can be finalized');
  const t = totals(s.lines);
  const now = nowIso();
  const statements = [
    db.prepare(
      `UPDATE settlements SET status = 'finalized', finalized_at = ?, load_pay_cents = ?, per_diem_cents = ?, reimbursement_cents = ?,
         advance_cents = ?, deduction_cents = ?, escrow_cents = ?, net_cents = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'`,
    ).bind(now, t.load_pay_cents, t.per_diem_cents, t.reimbursement_cents, t.advance_cents, t.deduction_cents, t.escrow_cents, t.net_cents, auth.tenantId, s.id),
  ];
  // A negative net is owed by the driver: it carries forward as a charge on the next settlement.
  if (t.net_cents < 0) {
    statements.push(
      insertRow(db, 'driver_charges', {
        id: newId(),
        tenant_id: auth.tenantId,
        driver_id: s.driver_id,
        category: 'deficit',
        amount_cents: -t.net_cents,
        incurred_on: s.period_end,
        description: `Balance carried forward from ${s.settlement_number}`,
        origin_settlement_id: s.id,
        created_by: auth.userId,
      }),
    );
  }
  await db.batch(statements);
  return c.json({ settlement: await settlementDetail(db, auth, s.id) });
});

settlements.post('/:id/mark-paid', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const res = await c.env.DB.prepare(`UPDATE settlements SET status = 'paid', paid_at = ? WHERE tenant_id = ? AND id = ? AND status = 'finalized'`)
    .bind(nowIso(), auth.tenantId, c.req.param('id'))
    .run();
  if (!res.meta.changes) conflict('Only a finalized settlement can be marked paid');
  return c.json({ settlement: await settlementDetail(c.env.DB, auth, c.req.param('id')) });
});

/** Deleting a draft frees every source it claimed so they land on the next settlement. */
settlements.delete('/:id', ownerOnly, async (c) => {
  const auth = c.get('auth');
  const db = c.env.DB;
  const s = await db.prepare('SELECT id, status FROM settlements WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, c.req.param('id')).first<{ id: string; status: string }>();
  if (!s) notFound('Settlement not found');
  if (s.status !== 'draft') conflict('Finalized settlements are permanent records');
  await db.batch([
    db.prepare('DELETE FROM settlements WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, s.id), // cascades lines
    db.prepare(`DELETE FROM escrow_transactions WHERE tenant_id = ? AND settlement_id = ? AND kind = 'hold'`).bind(auth.tenantId, s.id),
    db.prepare(`UPDATE escrow_transactions SET settlement_id = NULL WHERE tenant_id = ? AND settlement_id = ? AND kind = 'release'`).bind(auth.tenantId, s.id),
    db.prepare('DELETE FROM driver_charges WHERE tenant_id = ? AND origin_settlement_id = ?').bind(auth.tenantId, s.id),
  ]);
  return c.body(null, 204);
});

/** Email the settlement sheet to the driver. Fails cleanly (501) until email is configured. */
settlements.post('/:id/email', ownerOnly, async (c) => {
  const auth = c.get('auth');
  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) {
    throw new HTTPException(501, { message: 'Email is not configured. Set RESEND_API_KEY and EMAIL_FROM with `wrangler secret put`.' });
  }
  const s = await settlementDetail(c.env.DB, auth, c.req.param('id'));
  if (s.status === 'draft') conflict('Finalize the settlement before sending it');
  const driver = await getDriver(c.env.DB, auth.tenantId, s.driver_id);
  if (!driver.email) badRequest('This driver has no email address on file');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: c.env.EMAIL_FROM,
      to: driver.email,
      subject: `Settlement ${s.settlement_number} (${s.period_start} – ${s.period_end})`,
      html: settlementEmailHtml(s),
    }),
  });
  if (!res.ok) throw new HTTPException(502, { message: `Email provider rejected the message (${res.status})` });
  return c.json({ sent_to: driver.email });
});

// ---------------------------------------------------------------- detail

const label = (category: string) =>
  category === 'eld' ? 'ELD' : category.replace(/_/g, ' ').replace(/^\w/, (ch) => ch.toUpperCase());
const money = (cents: number) => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
};

/**
 * The verifiable settlement sheet: every line with the record behind it. Load
 * lines carry the load's lane, miles, stops, delivery date and the documents the
 * viewer may open (percentage-paid drivers get the rate confirmation).
 */
type SettlementRow = Record<string, any> & {
  id: string;
  status: string;
  driver_id: string;
  pay_track: string;
  period_start: string;
  period_end: string;
  settlement_number: string;
  net_cents: number;
  driver_name: string;
  carrier_name: string;
};

export async function settlementDetail(db: D1Database, auth: Auth, id: string) {
  const s = await db
    .prepare(
      `SELECT s.*, d.first_name || ' ' || d.last_name AS driver_name, t.name AS carrier_name
         FROM settlements s
         JOIN drivers d ON d.tenant_id = s.tenant_id AND d.id = s.driver_id
         JOIN tenants t ON t.id = s.tenant_id
        WHERE s.tenant_id = ? AND s.id = ?`,
    )
    .bind(auth.tenantId, id)
    .first<SettlementRow>();
  if (!s || (auth.role === 'driver' && (s.driver_id !== auth.driverId || s.status === 'draft'))) notFound('Settlement not found');

  const { results: lines } = await db
    .prepare(
      `SELECT sl.id, sl.seq, sl.kind, sl.description, sl.load_id, sl.pay_rate_id, sl.pay_kind, sl.quantity, sl.quantity_unit,
              sl.unit_rate, sl.gross_cents, sl.rate_bp, sl.amount_cents, sl.advance_id, sl.charge_id, sl.reimbursement_id,
              sl.escrow_tx_id,
              ch.category AS charge_category, ch.fuel_transaction_id, ch.document_id AS charge_document_id,
              r.category AS reimbursement_category, r.document_id AS reimbursement_document_id
         FROM settlement_lines sl
         LEFT JOIN driver_charges ch ON ch.tenant_id = sl.tenant_id AND ch.id = sl.charge_id
         LEFT JOIN driver_reimbursements r ON r.tenant_id = sl.tenant_id AND r.id = sl.reimbursement_id
        WHERE sl.tenant_id = ? AND sl.settlement_id = ? ORDER BY sl.seq`,
    )
    .bind(auth.tenantId, id)
    .all<Record<string, any> & { kind: LineKind; amount_cents: number }>();

  const loadIds = [...new Set(lines.map((l) => l.load_id).filter(Boolean))] as string[];
  const loads: Record<string, unknown> = {};
  for (const loadId of loadIds) {
    const load = await db
      .prepare(
        `SELECT l.id, l.load_number, l.reference_number, l.delivered_at, l.loaded_miles, l.empty_miles, l.pay_hours_x100,
                l.rate_cents, l.fuel_surcharge_cents, l.accessorial_cents,
                t.unit_number AS truck_unit,
                (SELECT COUNT(*) FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id) AS stop_count,
                (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq LIMIT 1) AS origin,
                (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq DESC LIMIT 1) AS destination
           FROM loads l LEFT JOIN trucks t ON t.tenant_id = l.tenant_id AND t.id = l.truck_id
          WHERE l.tenant_id = ? AND l.id = ?`,
      )
      .bind(auth.tenantId, loadId)
      .first<Record<string, any>>();
    if (!load) continue;
    const percentPaid = lines.some((l) => l.load_id === loadId && l.pay_kind === 'percent');
    // The load's revenue is shown only where pay depends on it (Truth-in-Leasing) or to the owner.
    if (auth.role === 'driver' && !percentPaid) {
      delete load.rate_cents;
      delete load.fuel_surcharge_cents;
      delete load.accessorial_cents;
    }
    const { results: docs } = await db.prepare(`SELECT ${DOC_COLUMNS} FROM documents WHERE tenant_id = ? AND load_id = ? ORDER BY created_at`).bind(auth.tenantId, loadId).all<DocumentRow>();
    const visible = [];
    for (const d of docs) if (await canReadDocument(db, auth, d)) visible.push({ id: d.id, kind: d.kind, filename: d.filename });
    loads[loadId] = { ...load, documents: visible };
  }

  const escrow_balance_cents = s.pay_track === '1099' ? await escrowBalance(db, auth.tenantId, s.driver_id) : null;
  const ytd = await db
    .prepare(
      `SELECT COALESCE(SUM(load_pay_cents + per_diem_cents), 0) AS gross FROM settlements
        WHERE tenant_id = ? AND driver_id = ? AND status <> 'draft' AND substr(period_end, 1, 4) = ? AND period_end <= ?`,
    )
    .bind(auth.tenantId, s.driver_id, String(s.period_end).slice(0, 4), s.period_end)
    .first<{ gross: number }>();

  return { ...s, lines, loads, escrow_balance_cents, ytd_gross_pay_cents: ytd?.gross ?? 0 };
}

function settlementEmailHtml(s: Awaited<ReturnType<typeof settlementDetail>>): string {
  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const rows = s.lines
    .map((l) => `<tr><td style="padding:4px 8px">${esc(l.description)}</td><td style="padding:4px 8px;text-align:right">${money(l.amount_cents)}</td></tr>`)
    .join('');
  return `<h2>${esc(s.carrier_name)} — Settlement ${esc(s.settlement_number)}</h2>
<p>${esc(s.driver_name)} · ${esc(s.period_start)} to ${esc(s.period_end)}</p>
<table style="border-collapse:collapse">${rows}
<tr><td style="padding:4px 8px"><strong>Net pay</strong></td><td style="padding:4px 8px;text-align:right"><strong>${money(s.net_cents)}</strong></td></tr></table>
<p>Sign in to HaulLedger to see each load, its miles and its paperwork.</p>`;
}
