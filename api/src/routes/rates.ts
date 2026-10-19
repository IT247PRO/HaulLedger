import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { badRequest } from '../lib/http';
import { roundDiv } from '../lib/money';
import { rateCalc } from '../lib/rate-calc';
import { body } from '../lib/validate';

// Cost per mile reveals company finances: owner only.
export const rateCalculator = new Hono<AppEnv>();
rateCalculator.use('*', requireRole('owner'));

const DAYS = 90;

/**
 * Starting values from the carrier's own last 90 days. Each figure says what it
 * was computed from; a figure with no data behind it is null, not a guess.
 */
rateCalculator.get('/defaults', async (c) => {
  const tenantId = c.get('auth').tenantId;
  const db = c.env.DB;
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);
  const [fuel, miles, pay, maint, fixed, trucks] = await Promise.all([
    db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents, COALESCE(SUM(gallons_milli), 0) AS gal FROM fuel_transactions WHERE tenant_id = ? AND product = 'diesel' AND substr(transacted_at, 1, 10) >= ?`)
      .bind(tenantId, since).first<{ cents: number; gal: number }>(),
    db.prepare(`SELECT COALESCE(SUM(COALESCE(loaded_miles, 0) + COALESCE(empty_miles, 0)), 0) AS miles, COUNT(*) AS n FROM loads WHERE tenant_id = ? AND status = 'delivered' AND substr(delivered_at, 1, 10) >= ?`)
      .bind(tenantId, since).first<{ miles: number; n: number }>(),
    db.prepare(
      `SELECT COALESCE(SUM(sl.amount_cents), 0) AS cents,
              COALESCE((SELECT SUM(COALESCE(l.loaded_miles, 0) + COALESCE(l.empty_miles, 0)) FROM loads l WHERE l.tenant_id = ?1 AND l.id IN (
                 SELECT sl2.load_id FROM settlement_lines sl2 JOIN settlements s2 ON s2.tenant_id = sl2.tenant_id AND s2.id = sl2.settlement_id
                  WHERE sl2.tenant_id = ?1 AND s2.status <> 'draft' AND sl2.kind = 'load_pay' AND s2.period_end >= ?2)), 0) AS miles
         FROM settlement_lines sl JOIN settlements s ON s.tenant_id = sl.tenant_id AND s.id = sl.settlement_id
        WHERE sl.tenant_id = ?1 AND s.status <> 'draft' AND sl.kind = 'load_pay' AND s.period_end >= ?2`,
    ).bind(tenantId, since).first<{ cents: number; miles: number }>(),
    db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE tenant_id = ? AND category IN ('maintenance', 'tires') AND incurred_on >= ?`).bind(tenantId, since).first<{ cents: number }>(),
    db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE tenant_id = ? AND category IN ('insurance', 'truck_payment', 'trailer_payment', 'permits_licenses', 'office', 'software', 'parking', 'other') AND incurred_on >= ?`)
      .bind(tenantId, since).first<{ cents: number }>(),
    db.prepare(`SELECT COUNT(*) AS n FROM trucks WHERE tenant_id = ? AND status <> 'inactive'`).bind(tenantId).first<{ n: number }>(),
  ]);
  // Before any settlement exists, fall back to the per-mile rates drivers are actually on.
  const today = new Date().toISOString().slice(0, 10);
  const rateAvg = pay && pay.miles > 0 ? null : await db.prepare(
    `SELECT AVG(rate) AS avg, COUNT(*) AS n FROM driver_pay_rates WHERE tenant_id = ? AND kind = 'per_mile' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`,
  ).bind(tenantId, today, today).first<{ avg: number | null; n: number }>();
  const payFromSettlements = pay && pay.miles > 0 ? roundDiv(pay.cents * 1000, pay.miles) : null;
  const payFromRates = rateAvg?.avg ? Math.round(rateAvg.avg) : null;
  const months = DAYS / 30;
  const truckCount = Math.max(1, trucks?.n ?? 1);
  const totalMiles = miles?.miles ?? 0;
  return c.json({
    window_days: DAYS,
    fuel_price_x1000: fuel && fuel.gal > 0 ? roundDiv(fuel.cents * 10_000, fuel.gal) : null,
    mpg_x100: fuel && fuel.gal > 0 && totalMiles > 0 ? roundDiv(totalMiles * 100_000, fuel.gal) : null,
    driver_pay_millicents_per_mile: payFromSettlements ?? payFromRates,
    maintenance_millicents_per_mile: totalMiles > 0 ? roundDiv((maint?.cents ?? 0) * 1000, totalMiles) : null,
    fixed_monthly_cents: roundDiv(roundDiv(fixed?.cents ?? 0, truckCount) * 10, months * 10),
    miles_per_month: totalMiles > 0 ? roundDiv(roundDiv(totalMiles, truckCount) * 10, months * 10) : null,
    basis: {
      fuel: `${fuel?.gal ? (fuel.gal / 1000).toFixed(0) : 0} gal of diesel bought in ${DAYS} days`,
      mpg: `${totalMiles} delivered miles ÷ diesel gallons`,
      driver_pay: payFromSettlements !== null ? 'settled load pay ÷ miles of those loads' : payFromRates !== null ? `average of ${rateAvg!.n} current per-mile pay rates (no settlements yet)` : 'no settlements or per-mile rates yet',
      maintenance: 'maintenance + tire expenses ÷ delivered miles',
      fixed: `insurance, payments, permits and overhead over ${DAYS} days, per truck per month (${truckCount} trucks)`,
      miles_per_month: `delivered miles per truck per month`,
    },
  });
});

const schema = z.strictObject({
  rate_cents: z.int().min(0).max(100_000_000),
  loaded_miles: z.int().min(0).max(20_000),
  deadhead_miles: z.int().min(0).max(20_000),
  fuel_price_x1000: z.int().min(0).max(50_000),
  mpg_x100: z.int().min(100).max(3_000),
  driver_pay_millicents_per_mile: z.int().min(0).max(1_000_000),
  driver_pay_basis: z.enum(['loaded', 'all']),
  driver_pay_percent_bp: z.int().min(0).max(9_000),
  maintenance_millicents_per_mile: z.int().min(0).max(1_000_000),
  tolls_cents: z.int().min(0).max(10_000_000),
  fixed_monthly_cents: z.int().min(0).max(1_000_000_000),
  miles_per_month: z.int().min(1).max(100_000),
  target_margin_bp: z.int().min(0).max(5_000).optional(),
});

rateCalculator.post('/', async (c) => {
  const input = await body(c, schema);
  if (input.loaded_miles + input.deadhead_miles === 0) badRequest('Enter the trip miles');
  return c.json(rateCalc(input));
});
