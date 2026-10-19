import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { badRequest } from '../lib/http';
import { roundDiv } from '../lib/money';
import { computeLoadPay, type PayLoad, type PayRate } from '../lib/pay';

// Company financials: owner only. Drivers never see P&L; dispatchers don't either.
export const reports = new Hono<AppEnv>();
reports.use('*', requireRole('owner'));

const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface PnlRow {
  key: string;
  label: string;
  load_count: number;
  loaded_miles: number;
  empty_miles: number;
  revenue_cents: number;
  driver_pay_cents: number;
  driver_pay_estimated_cents: number;
  reimbursements_cents: number;
  fuel_cents: number;
  fuel_recovered_cents: number;
  expenses_cents: number;
  expenses_by_category: Record<string, number>;
  net_cents: number;
  revenue_per_mile_cents: number | null;
  cost_per_mile_cents: number | null;
}

const blank = (key: string, label: string): PnlRow => ({
  key, label, load_count: 0, loaded_miles: 0, empty_miles: 0, revenue_cents: 0, driver_pay_cents: 0, driver_pay_estimated_cents: 0,
  reimbursements_cents: 0, fuel_cents: 0, fuel_recovered_cents: 0, expenses_cents: 0, expenses_by_category: {}, net_cents: 0,
  revenue_per_mile_cents: null, cost_per_mile_cents: null,
});

function finish(r: PnlRow): PnlRow {
  const costs = r.driver_pay_cents + r.driver_pay_estimated_cents + r.reimbursements_cents + r.fuel_cents - r.fuel_recovered_cents + r.expenses_cents;
  const miles = r.loaded_miles + r.empty_miles;
  return {
    ...r,
    net_cents: r.revenue_cents - costs,
    revenue_per_mile_cents: miles ? roundDiv(r.revenue_cents, miles) : null,
    cost_per_mile_cents: miles && costs >= 0 ? roundDiv(costs, miles) : null,
  };
}

/**
 * P&L for loads delivered in [from, to] and costs incurred in [from, to].
 * Driver pay is actual where a finalized settlement paid the load; for loads not
 * yet settled it is computed from the driver's pay rates and reported separately
 * as an estimate, never mixed silently into actual pay.
 */
export async function pnl(db: D1Database, tenantId: string, from: string, to: string) {
  const [loads, paid, rates, reimb, fuelTx, recovered, expenses, trucks] = await Promise.all([
    db.prepare(
      `SELECT l.id, l.load_number, l.truck_id, l.driver_id, l.rate_cents, l.fuel_surcharge_cents, l.accessorial_cents, l.loaded_miles, l.empty_miles,
              l.pay_hours_x100, l.dispatched_at, l.delivered_at,
              (SELECT COUNT(*) FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id) AS stop_count,
              (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq LIMIT 1) AS origin,
              (SELECT city || ', ' || state FROM load_stops s WHERE s.tenant_id = l.tenant_id AND s.load_id = l.id ORDER BY seq DESC LIMIT 1) AS destination
         FROM loads l WHERE l.tenant_id = ?1 AND l.status = 'delivered' AND substr(l.delivered_at, 1, 10) BETWEEN ?2 AND ?3`,
    ).bind(tenantId, from, to).all<PayLoad & { truck_id: string | null; driver_id: string | null; origin: string; destination: string }>(),
    db.prepare(
      `SELECT sl.load_id, SUM(sl.amount_cents) AS cents FROM settlement_lines sl
         JOIN settlements s ON s.tenant_id = sl.tenant_id AND s.id = sl.settlement_id
        WHERE sl.tenant_id = ? AND s.status <> 'draft' AND sl.kind IN ('load_pay', 'per_diem') GROUP BY sl.load_id`,
    ).bind(tenantId).all<{ load_id: string; cents: number }>(),
    db.prepare('SELECT id, driver_id, kind, rate, basis, effective_from, effective_to FROM driver_pay_rates WHERE tenant_id = ?').bind(tenantId)
      .all<PayRate & { driver_id: string; effective_from: string; effective_to: string | null }>(),
    db.prepare(`SELECT load_id, SUM(amount_cents) AS cents FROM driver_reimbursements WHERE tenant_id = ? AND status = 'approved' AND load_id IS NOT NULL GROUP BY load_id`)
      .bind(tenantId).all<{ load_id: string; cents: number }>(),
    db.prepare(
      `SELECT id, truck_id, load_id, amount_cents FROM fuel_transactions
        WHERE tenant_id = ? AND product <> 'cash_advance' AND substr(transacted_at, 1, 10) BETWEEN ? AND ?`,
    ).bind(tenantId, from, to).all<{ id: string; truck_id: string | null; load_id: string | null; amount_cents: number }>(),
    db.prepare(`SELECT fuel_transaction_id, amount_cents FROM driver_charges WHERE tenant_id = ? AND category = 'fuel' AND fuel_transaction_id IS NOT NULL`)
      .bind(tenantId).all<{ fuel_transaction_id: string; amount_cents: number }>(),
    db.prepare('SELECT truck_id, load_id, category, amount_cents FROM expenses WHERE tenant_id = ? AND incurred_on BETWEEN ? AND ?')
      .bind(tenantId, from, to).all<{ truck_id: string | null; load_id: string | null; category: string; amount_cents: number }>(),
    db.prepare('SELECT id, unit_number FROM trucks WHERE tenant_id = ? ORDER BY unit_number').bind(tenantId).all<{ id: string; unit_number: string }>(),
  ]);

  const paidByLoad = new Map(paid.results.map((p) => [p.load_id, p.cents]));
  const reimbByLoad = new Map(reimb.results.map((r) => [r.load_id, r.cents]));
  const recoveredByTx = new Map(recovered.results.map((r) => [r.fuel_transaction_id, r.amount_cents]));

  const byTruck = new Map<string, PnlRow>();
  for (const t of trucks.results) byTruck.set(t.id, blank(t.id, `Truck ${t.unit_number}`));
  const UNASSIGNED = 'unassigned';
  const truckRow = (id: string | null) => {
    const key = id ?? UNASSIGNED;
    if (!byTruck.has(key)) byTruck.set(key, blank(key, 'Not tied to a truck'));
    return byTruck.get(key)!;
  };
  const loadRows = new Map<string, PnlRow & { load_number: string; lane: string; truck_id: string | null; pay_basis: 'settled' | 'estimated' | 'none' }>();

  for (const l of loads.results) {
    const revenue = l.rate_cents + l.fuel_surcharge_cents + l.accessorial_cents;
    const row = { ...blank(l.id, l.load_number), load_number: l.load_number, lane: `${l.origin} → ${l.destination}`, truck_id: l.truck_id, pay_basis: 'none' as 'settled' | 'estimated' | 'none' };
    row.load_count = 1;
    row.revenue_cents = revenue;
    row.loaded_miles = l.loaded_miles ?? 0;
    row.empty_miles = l.empty_miles ?? 0;
    row.reimbursements_cents = reimbByLoad.get(l.id) ?? 0;
    const actual = paidByLoad.get(l.id);
    if (actual !== undefined) {
      row.driver_pay_cents = actual;
      row.pay_basis = 'settled';
    } else if (l.driver_id) {
      const day = l.delivered_at!.slice(0, 10);
      const applicable = rates.results.filter((r) => r.driver_id === l.driver_id && r.effective_from <= day && (!r.effective_to || r.effective_to >= day));
      let est = 0;
      for (const r of applicable) {
        const res = computeLoadPay(l, r);
        if ('line' in res) est += res.line.amount_cents;
      }
      row.driver_pay_estimated_cents = est;
      row.pay_basis = applicable.length ? 'estimated' : 'none';
    }
    loadRows.set(l.id, row);
    const t = truckRow(l.truck_id);
    for (const k of ['load_count', 'loaded_miles', 'empty_miles', 'revenue_cents', 'driver_pay_cents', 'driver_pay_estimated_cents', 'reimbursements_cents'] as const) t[k] += row[k];
  }

  for (const f of fuelTx.results) {
    const rec = recoveredByTx.get(f.id) ?? 0;
    const t = truckRow(f.truck_id);
    t.fuel_cents += f.amount_cents;
    t.fuel_recovered_cents += rec;
    const lr = f.load_id ? loadRows.get(f.load_id) : undefined;
    if (lr) {
      lr.fuel_cents += f.amount_cents;
      lr.fuel_recovered_cents += rec;
    }
  }

  for (const e of expenses.results) {
    const t = truckRow(e.truck_id);
    t.expenses_cents += e.amount_cents;
    t.expenses_by_category[e.category] = (t.expenses_by_category[e.category] ?? 0) + e.amount_cents;
    const lr = e.load_id ? loadRows.get(e.load_id) : undefined;
    if (lr) {
      lr.expenses_cents += e.amount_cents;
      lr.expenses_by_category[e.category] = (lr.expenses_by_category[e.category] ?? 0) + e.amount_cents;
    }
  }

  const truckList = [...byTruck.values()].map(finish);
  const total = blank('total', 'All trucks');
  for (const t of truckList) {
    for (const k of ['load_count', 'loaded_miles', 'empty_miles', 'revenue_cents', 'driver_pay_cents', 'driver_pay_estimated_cents', 'reimbursements_cents', 'fuel_cents', 'fuel_recovered_cents', 'expenses_cents'] as const) total[k] += t[k];
    for (const [cat, v] of Object.entries(t.expenses_by_category)) total.expenses_by_category[cat] = (total.expenses_by_category[cat] ?? 0) + v;
  }
  return {
    from,
    to,
    trucks: truckList,
    loads: [...loadRows.values()].map((r) => ({ ...finish(r), load_number: r.load_number, lane: r.lane, truck_id: r.truck_id, pay_basis: r.pay_basis })),
    total: finish(total),
  };
}

reports.get('/pnl', async (c) => {
  const { from, to } = c.req.query();
  if (!from || !to || !DATE.test(from) || !DATE.test(to) || to < from) badRequest('from and to are required dates (YYYY-MM-DD)');
  return c.json(await pnl(c.env.DB, c.get('auth').tenantId, from, to));
});

/** Accounts receivable by customer, bucketed by days past due. */
reports.get('/ar-aging', async (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT i.customer_id, cu.name AS customer_name, i.total_cents - i.paid_cents AS balance_cents,
            CAST(julianday(?2) - julianday(i.due_on) AS INTEGER) AS days_past_due
       FROM invoices i JOIN customers cu ON cu.tenant_id = i.tenant_id AND cu.id = i.customer_id
      WHERE i.tenant_id = ?1 AND i.status = 'open' AND i.total_cents > i.paid_cents`,
  )
    .bind(c.get('auth').tenantId, today)
    .all<{ customer_id: string; customer_name: string; balance_cents: number; days_past_due: number }>();
  const buckets = ['current', '1_30', '31_60', '61_90', 'over_90'] as const;
  const bucketOf = (d: number) => (d <= 0 ? 'current' : d <= 30 ? '1_30' : d <= 60 ? '31_60' : d <= 90 ? '61_90' : 'over_90');
  const rows = new Map<string, Record<string, any>>();
  const total: Record<string, number> = Object.fromEntries([...buckets, 'total'].map((b) => [b, 0]));
  for (const r of results) {
    const row = rows.get(r.customer_id) ?? { customer_id: r.customer_id, customer_name: r.customer_name, ...Object.fromEntries([...buckets, 'total'].map((b) => [b, 0])) };
    row[bucketOf(r.days_past_due)] += r.balance_cents;
    row.total += r.balance_cents;
    total[bucketOf(r.days_past_due)]! += r.balance_cents;
    total.total! += r.balance_cents;
    rows.set(r.customer_id, row);
  }
  return c.json({ as_of: today, customers: [...rows.values()].sort((a, b) => b.total - a.total), total });
});
