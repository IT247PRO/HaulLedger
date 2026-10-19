import { describe, expect, it } from 'vitest';
import { roundDiv, sum } from '../src/lib/money';
import { computeLoadPay, escrowHold, loadGross, perDiemDays, type PayLoad, type PayRate } from '../src/lib/pay';
import { totals } from '../src/routes/settlements';

const load = (over: Partial<PayLoad> = {}): PayLoad => ({
  id: 'l1',
  load_number: 'L-1',
  rate_cents: 250_000,
  fuel_surcharge_cents: 31_250,
  accessorial_cents: 7_500,
  loaded_miles: 781,
  empty_miles: 64,
  stop_count: 2,
  pay_hours_x100: null,
  dispatched_at: '2026-10-01T15:00:00.000Z',
  delivered_at: '2026-10-03T14:00:00.000Z',
  ...over,
});
const rate = (over: Partial<PayRate>): PayRate => ({ id: 'r1', kind: 'per_mile', rate: 0, basis: null, ...over });
const amount = (r: ReturnType<typeof computeLoadPay>) => {
  if ('skip' in r) throw new Error(r.skip);
  return r.line;
};

describe('roundDiv', () => {
  it('rounds half up and stays integral', () => {
    expect(roundDiv(5, 10)).toBe(1);
    expect(roundDiv(4, 10)).toBe(0);
    expect(roundDiv(15, 10)).toBe(2);
    expect(roundDiv(0, 7)).toBe(0);
    expect(roundDiv(1_000_000_000 * 10_000, 10_000)).toBe(1_000_000_000);
  });
  it('rejects floats and negatives', () => {
    expect(() => roundDiv(1.5, 2)).toThrow();
    expect(() => roundDiv(-1, 2)).toThrow();
    expect(() => roundDiv(1, 0)).toThrow();
  });
  it('sum refuses fractional cents', () => {
    expect(sum([1, 2, 3])).toBe(6);
    expect(() => sum([1, 0.1])).toThrow();
  });
});

describe('per-mile pay', () => {
  it('pays loaded miles at millicents per mile', () => {
    // 781 mi × $0.625 = $488.125 → $488.13
    const line = amount(computeLoadPay(load(), rate({ kind: 'per_mile', rate: 62_500, basis: 'loaded' })));
    expect(line).toMatchObject({ quantity: 781, quantity_unit: 'miles', unit_rate: 62_500, amount_cents: 48_813 });
    expect(line.description).toBe('781 loaded mi × $0.625/mi');
  });
  it('pays all miles (loaded + empty) when the basis is "all"', () => {
    // 845 mi × $0.55 = $464.75
    const line = amount(computeLoadPay(load(), rate({ kind: 'per_mile', rate: 55_000, basis: 'all' })));
    expect(line).toMatchObject({ quantity: 845, amount_cents: 46_475 });
  });
  it('skips (never guesses) when miles are missing', () => {
    expect(computeLoadPay(load({ loaded_miles: null }), rate({ kind: 'per_mile', rate: 55_000, basis: 'loaded' }))).toHaveProperty('skip');
  });
  it('has no float drift across many loads', () => {
    // 0.1-style rates are where float math drifts; integers do not.
    const r = rate({ kind: 'per_mile', rate: 10_000, basis: 'loaded' }); // $0.10/mi
    const lines = Array.from({ length: 1000 }, () => amount(computeLoadPay(load({ loaded_miles: 3 }), r)).amount_cents);
    expect(sum(lines)).toBe(30_000);
  });
});

describe('percentage pay', () => {
  it('stores gross, percentage and amount on the line', () => {
    const gross = loadGross(load());
    expect(gross).toBe(288_750);
    // 28% of $2,887.50 = $808.50
    const line = amount(computeLoadPay(load(), rate({ kind: 'percent', rate: 2_800 })));
    expect(line).toMatchObject({ gross_cents: 288_750, rate_bp: 2_800, amount_cents: 80_850 });
    expect(line.description).toBe('28.00% of load gross $2,887.50');
  });
  it('rounds half a cent up', () => {
    // 25% of $0.10 + ... : 1 cent gross × 50% = 0.5 → 1
    const line = amount(computeLoadPay(load({ rate_cents: 1, fuel_surcharge_cents: 0, accessorial_cents: 0 }), rate({ kind: 'percent', rate: 5_000 })));
    expect(line.amount_cents).toBe(1);
  });
});

describe('per-stop pay', () => {
  it('pays every stop on basis "all"', () => {
    expect(amount(computeLoadPay(load({ stop_count: 3 }), rate({ kind: 'per_stop', rate: 2_500, basis: 'all' }))).amount_cents).toBe(7_500);
  });
  it('pays only stops beyond the first pickup and final delivery on basis "extra"', () => {
    expect(amount(computeLoadPay(load({ stop_count: 4 }), rate({ kind: 'per_stop', rate: 5_000, basis: 'extra' }))).amount_cents).toBe(10_000);
    expect(computeLoadPay(load({ stop_count: 2 }), rate({ kind: 'per_stop', rate: 5_000, basis: 'extra' }))).toHaveProperty('skip');
  });
});

describe('hourly pay', () => {
  it('pays hundredths of hours', () => {
    // 8.25 h × $27.50 = $226.875 → $226.88
    expect(amount(computeLoadPay(load({ pay_hours_x100: 825 }), rate({ kind: 'hourly', rate: 2_750 }))).amount_cents).toBe(22_688);
  });
  it('skips when hours are missing', () => {
    expect(computeLoadPay(load(), rate({ kind: 'hourly', rate: 2_750 }))).toHaveProperty('skip');
  });
});

describe('per diem', () => {
  it('counts calendar days dispatch to delivery, inclusive', () => {
    expect(perDiemDays('2026-10-01T15:00:00Z', '2026-10-03T14:00:00Z')).toBe(3);
    expect(perDiemDays('2026-10-01T01:00:00Z', '2026-10-01T23:00:00Z')).toBe(1);
    expect(perDiemDays(null, '2026-10-01T23:00:00Z')).toBe(1);
    expect(amount(computeLoadPay(load(), rate({ kind: 'per_diem', rate: 6_900 }))).amount_cents).toBe(20_700);
  });
});

describe('escrow hold', () => {
  it('holds the per-settlement amount until the target is reached', () => {
    expect(escrowHold({ perSettlement: 10_000, target: 250_000, balance: 0, availableNet: 100_000 })).toBe(10_000);
    expect(escrowHold({ perSettlement: 10_000, target: 250_000, balance: 245_000, availableNet: 100_000 })).toBe(5_000);
    expect(escrowHold({ perSettlement: 10_000, target: 250_000, balance: 250_000, availableNet: 100_000 })).toBe(0);
  });
  it('never drives a settlement negative', () => {
    expect(escrowHold({ perSettlement: 10_000, target: 250_000, balance: 0, availableNet: 4_000 })).toBe(4_000);
    expect(escrowHold({ perSettlement: 10_000, target: 250_000, balance: 0, availableNet: 0 })).toBe(0);
  });
});

describe('settlement totals', () => {
  it('buckets lines and nets them exactly', () => {
    const t = totals([
      { kind: 'load_pay', amount_cents: 48_813 },
      { kind: 'load_pay', amount_cents: 80_850 },
      { kind: 'per_diem', amount_cents: 20_700 },
      { kind: 'reimbursement', amount_cents: 7_500 },
      { kind: 'advance', amount_cents: -20_000 },
      { kind: 'deduction', amount_cents: -12_345 },
      { kind: 'escrow_hold', amount_cents: -10_000 },
      { kind: 'escrow_release', amount_cents: 2_500 },
    ]);
    expect(t).toEqual({
      load_pay_cents: 129_663,
      per_diem_cents: 20_700,
      reimbursement_cents: 7_500,
      advance_cents: -20_000,
      deduction_cents: -12_345,
      escrow_cents: -7_500,
      net_cents: 118_018,
    });
  });
});
