import { roundDiv, roundDivSigned } from './money';

/** All-in trip cost vs. an offered rate. Integer inputs; see field comments for units. */
export interface RateInput {
  rate_cents: number;
  loaded_miles: number;
  deadhead_miles: number;
  /** Diesel price, dollars × 1000 per gallon ($3.899 = 3899). */
  fuel_price_x1000: number;
  /** Miles per gallon × 100 (6.5 mpg = 650). */
  mpg_x100: number;
  /** Driver pay per mile in millicents ($0.60 = 60000) on `driver_pay_basis` miles. */
  driver_pay_millicents_per_mile: number;
  driver_pay_basis: 'loaded' | 'all';
  /** Driver pay as basis points of the rate (percentage drivers). */
  driver_pay_percent_bp: number;
  /** Maintenance and tire reserve, millicents per mile. */
  maintenance_millicents_per_mile: number;
  tolls_cents: number;
  /** Insurance, truck/trailer payments, permits, overhead: per truck per month. */
  fixed_monthly_cents: number;
  miles_per_month: number;
  /** Optional target margin for the suggested rate, basis points. */
  target_margin_bp?: number;
}

export function rateCalc(i: RateInput) {
  const totalMiles = i.loaded_miles + i.deadhead_miles;
  if (totalMiles <= 0) throw new RangeError('trip needs miles');
  if (i.mpg_x100 <= 0 || i.miles_per_month <= 0) throw new RangeError('mpg and miles per month must be positive');
  const fuel = roundDiv(totalMiles * i.fuel_price_x1000 * 10, i.mpg_x100);
  const payMiles = i.driver_pay_basis === 'all' ? totalMiles : i.loaded_miles;
  const payMileage = roundDiv(payMiles * i.driver_pay_millicents_per_mile, 1000);
  const payPercent = roundDiv(i.rate_cents * i.driver_pay_percent_bp, 10_000);
  const maintenance = roundDiv(totalMiles * i.maintenance_millicents_per_mile, 1000);
  const fixed = roundDiv(i.fixed_monthly_cents * totalMiles, i.miles_per_month);
  // Costs that do not scale with the rate.
  const flat = fuel + payMileage + maintenance + fixed + i.tolls_cents;
  const total = flat + payPercent;
  const profit = i.rate_cents - total;
  const keep = 10_000 - i.driver_pay_percent_bp; // share of each revenue dollar left after percentage pay
  const breakEven = keep > 0 ? roundDiv(flat * 10_000, keep) : null;
  const target = i.target_margin_bp ?? null;
  const suggested = target !== null && keep - target > 0 ? roundDiv(flat * 10_000, keep - target) : null;
  return {
    total_miles: totalMiles,
    costs: { fuel_cents: fuel, driver_pay_cents: payMileage + payPercent, maintenance_cents: maintenance, fixed_cents: fixed, tolls_cents: i.tolls_cents },
    total_cost_cents: total,
    profit_cents: profit,
    margin_bp: i.rate_cents > 0 ? roundDivSigned(profit * 10_000, i.rate_cents) : null,
    rate_per_total_mile_cents: roundDiv(i.rate_cents, totalMiles),
    rate_per_loaded_mile_cents: i.loaded_miles > 0 ? roundDiv(i.rate_cents, i.loaded_miles) : null,
    cost_per_mile_cents: roundDiv(total, totalMiles),
    break_even_rate_cents: breakEven,
    suggested_rate_cents: suggested,
  };
}
