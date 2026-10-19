import { roundDiv, roundDivSigned } from './money';

/** "2026-Q3" -> { start: "2026-07-01", end: "2026-09-30" }. */
export function quarterRange(quarter: string): { start: string; end: string } {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
  if (!m) throw new RangeError(`bad quarter ${quarter}`);
  const year = Number(m[1]);
  const q = Number(m[2]);
  const start = new Date(Date.UTC(year, (q - 1) * 3, 1));
  const end = new Date(Date.UTC(year, q * 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function quarterOf(date: string): string {
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

export interface IftaInput {
  /** Total miles traveled in each jurisdiction. */
  milesByState: Record<string, number>;
  /** Tax-paid gallons purchased in each jurisdiction, in thousandths. */
  gallonsMilliByState: Record<string, number>;
  /** Tax rate in dollars × 10,000 per gallon, by jurisdiction. Missing = not entered. */
  ratesX10000: Record<string, number | undefined>;
}

export interface IftaLine {
  state: string;
  miles: number;
  taxable_gallons_milli: number | null;
  tax_paid_gallons_milli: number;
  net_taxable_gallons_milli: number | null;
  rate_x10000: number | null;
  tax_due_cents: number | null;
}

/**
 * Quarterly IFTA computation. Fleet MPG is total miles ÷ total gallons, rounded
 * to two decimals as on the return; taxable gallons per jurisdiction are that
 * jurisdiction's miles ÷ MPG; net = taxable − tax-paid (negative is a credit).
 * Tax is computed only where a rate has been entered — a missing rate leaves the
 * line (and the total) incomplete instead of guessing.
 */
export function computeIfta(input: IftaInput) {
  const states = [...new Set([...Object.keys(input.milesByState), ...Object.keys(input.gallonsMilliByState)])].sort();
  const totalMiles = states.reduce((a, s) => a + (input.milesByState[s] ?? 0), 0);
  const totalGallonsMilli = states.reduce((a, s) => a + (input.gallonsMilliByState[s] ?? 0), 0);
  const mpgX100 = totalGallonsMilli > 0 && totalMiles > 0 ? roundDiv(totalMiles * 100_000, totalGallonsMilli) : null;

  const missingRates: string[] = [];
  const lines: IftaLine[] = states.map((state) => {
    const miles = input.milesByState[state] ?? 0;
    const paid = input.gallonsMilliByState[state] ?? 0;
    const taxable = mpgX100 ? roundDiv(miles * 100_000, mpgX100) : null;
    const net = taxable === null ? null : taxable - paid;
    const rate = input.ratesX10000[state];
    if (rate === undefined) missingRates.push(state);
    return {
      state,
      miles,
      taxable_gallons_milli: taxable,
      tax_paid_gallons_milli: paid,
      net_taxable_gallons_milli: net,
      rate_x10000: rate ?? null,
      tax_due_cents: net === null || rate === undefined ? null : roundDivSigned(net * rate, 100_000),
    };
  });
  const complete = mpgX100 !== null && missingRates.length === 0;
  return {
    total_miles: totalMiles,
    total_gallons_milli: totalGallonsMilli,
    mpg_x100: mpgX100,
    lines,
    missing_rates: missingRates,
    total_tax_due_cents: complete ? lines.reduce((a, l) => a + (l.tax_due_cents ?? 0), 0) : null,
    complete,
  };
}
