import { describe, expect, it } from 'vitest';
import { computeIfta, quarterOf, quarterRange } from '../src/lib/ifta';
import { roundDivSigned } from '../src/lib/money';
import { dqfStatus } from '../src/routes/dqf';
import { pmStatus } from '../src/routes/maintenance';

describe('quarters', () => {
  it('maps quarters to date ranges and back', () => {
    expect(quarterRange('2026-Q1')).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(quarterRange('2024-Q1').end).toBe('2024-03-31');
    expect(quarterRange('2026-Q4')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(quarterOf('2026-07-01')).toBe('2026-Q3');
    expect(quarterOf('2026-12-31')).toBe('2026-Q4');
    expect(() => quarterRange('2026-Q5')).toThrow();
  });
});

describe('IFTA computation', () => {
  it('uses fleet MPG to two decimals and nets tax-paid gallons, credits included', () => {
    const r = computeIfta({
      milesByState: { TX: 1000, OK: 500 },
      gallonsMilliByState: { TX: 200_000, OK: 50_000 },
      ratesX10000: { TX: 2000, OK: 1900 },
    });
    expect(r.total_miles).toBe(1500);
    expect(r.total_gallons_milli).toBe(250_000);
    expect(r.mpg_x100).toBe(600);
    const tx = r.lines.find((l) => l.state === 'TX')!;
    const ok = r.lines.find((l) => l.state === 'OK')!;
    expect(tx).toMatchObject({ taxable_gallons_milli: 166_667, net_taxable_gallons_milli: -33_333, tax_due_cents: -667 });
    expect(ok).toMatchObject({ taxable_gallons_milli: 83_333, net_taxable_gallons_milli: 33_333, tax_due_cents: 633 });
    expect(r.total_tax_due_cents).toBe(-34);
    expect(r.complete).toBe(true);
  });

  it('rounds MPG the way the return does', () => {
    // 1000 mi / 153.846 gal = 6.50001 -> 6.50
    expect(computeIfta({ milesByState: { TX: 1000 }, gallonsMilliByState: { TX: 153_846 }, ratesX10000: { TX: 2000 } }).mpg_x100).toBe(650);
  });

  it('includes jurisdictions with fuel but no miles (all credit)', () => {
    const r = computeIfta({ milesByState: { TX: 600 }, gallonsMilliByState: { TX: 50_000, LA: 50_000 }, ratesX10000: { TX: 2000, LA: 2000 } });
    expect(r.lines.find((l) => l.state === 'LA')).toMatchObject({ miles: 0, taxable_gallons_milli: 0, net_taxable_gallons_milli: -50_000, tax_due_cents: -1000 });
  });

  it('never guesses a missing rate', () => {
    const r = computeIfta({ milesByState: { TX: 600, NM: 400 }, gallonsMilliByState: { TX: 160_000 }, ratesX10000: { TX: 2000 } });
    expect(r.missing_rates).toEqual(['NM']);
    expect(r.lines.find((l) => l.state === 'NM')?.tax_due_cents).toBeNull();
    expect(r.total_tax_due_cents).toBeNull();
    expect(r.complete).toBe(false);
  });

  it('cannot compute MPG without fuel', () => {
    const r = computeIfta({ milesByState: { TX: 600 }, gallonsMilliByState: {}, ratesX10000: { TX: 2000 } });
    expect(r.mpg_x100).toBeNull();
    expect(r.complete).toBe(false);
  });

  it('signed rounding is symmetric', () => {
    expect(roundDivSigned(-5, 10)).toBe(-1);
    expect(roundDivSigned(5, 10)).toBe(1);
    expect(roundDivSigned(-4, 10)).toBe(-0);
  });
});

describe('DQF status', () => {
  const item = (item_type: string, completed_on: string, expires_on: string | null = null) => ({ id: item_type + completed_on, item_type, completed_on, expires_on, document_id: null, notes: null, created_at: completed_on });
  const byType = (r: ReturnType<typeof dqfStatus>) => Object.fromEntries(r.map((x) => [x.type, x.status]));

  it('flags missing, expired, expiring and not-yet-due items', () => {
    const r = byType(dqfStatus(
      [
        item('application', '2025-01-02'),
        item('medical_certificate', '2025-01-05', '2026-10-30'),
        item('registry_verification', '2025-01-05'),
        item('annual_mvr', '2025-09-01'),
      ],
      '2025-01-02',
      '2026-10-19',
    ));
    expect(r.application).toBe('complete');
    expect(r.road_test).toBe('missing');
    expect(r.medical_certificate).toBe('expiring');
    expect(r.registry_verification).toBe('complete');
    expect(r.annual_mvr).toBe('expired'); // 2025-09-01 + 365 days < today
    expect(r.annual_review).toBe('missing');
  });

  it('a new hire is not yet due for annual items', () => {
    const r = byType(dqfStatus([], '2026-06-01', '2026-10-19'));
    expect(r.annual_mvr).toBe('not_due');
    expect(r.clearinghouse_annual).toBe('not_due');
    expect(r.application).toBe('missing');
  });

  it('a new medical certificate needs a new registry verification', () => {
    const r = byType(dqfStatus([item('medical_certificate', '2026-09-01', '2028-09-01'), item('registry_verification', '2025-01-05')], '2020-01-01', '2026-10-19'));
    expect(r.medical_certificate).toBe('complete');
    expect(r.registry_verification).toBe('missing');
  });
});

describe('PM status', () => {
  it('tracks miles and days, whichever comes first', () => {
    const base = { interval_miles: 25_000, interval_days: 180, last_done_on: '2026-06-01', last_done_odometer: 400_000 };
    expect(pmStatus(base, 410_000, '2026-07-01')).toMatchObject({ status: 'ok', miles_remaining: 15_000, next_due_on: '2026-11-28' });
    expect(pmStatus(base, 423_000, '2026-07-01').status).toBe('due_soon');
    expect(pmStatus(base, 426_000, '2026-07-01').status).toBe('overdue');
    expect(pmStatus(base, 401_000, '2026-12-01').status).toBe('overdue');
    expect(pmStatus({ ...base, last_done_odometer: null, last_done_on: null }, 401_000, '2026-07-01').status).toBe('no_baseline');
  });
});
