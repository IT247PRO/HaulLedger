import { describe, expect, it } from 'vitest';
import { mapMotive, mapSamsara } from '../src/integrations/eld';
import { normalizePosition } from '../src/integrations/traccar';
import { rateCalc } from '../src/lib/rate-calc';
import { decryptSecret, encryptSecret } from '../src/lib/secrets';
import { verifyStripeSignature } from '../src/routes/billing';

const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

describe('rate calculator', () => {
  const base = {
    rate_cents: 250_000, loaded_miles: 781, deadhead_miles: 69, fuel_price_x1000: 3_899, mpg_x100: 650,
    driver_pay_millicents_per_mile: 60_000, driver_pay_basis: 'all' as const, driver_pay_percent_bp: 0,
    maintenance_millicents_per_mile: 15_000, tolls_cents: 2_500, fixed_monthly_cents: 600_000, miles_per_month: 10_000,
  };
  it('prices the all-in cost per mile', () => {
    const r = rateCalc(base);
    // 850 mi: fuel 850/6.5×3.899 = 509.87; pay 850×0.60 = 510.00; maint 127.50; fixed 6000×850/10000 = 510.00; tolls 25.00
    expect(r.costs).toEqual({ fuel_cents: 50_987, driver_pay_cents: 51_000, maintenance_cents: 12_750, fixed_cents: 51_000, tolls_cents: 2_500 });
    expect(r.total_cost_cents).toBe(168_237);
    expect(r.profit_cents).toBe(81_763);
    expect(r.margin_bp).toBe(3_271);
    expect(r.cost_per_mile_cents).toBe(198);
    expect(r.rate_per_total_mile_cents).toBe(294);
    expect(r.break_even_rate_cents).toBe(168_237);
  });
  it('accounts for percentage pay scaling with the rate', () => {
    const r = rateCalc({ ...base, driver_pay_millicents_per_mile: 0, driver_pay_percent_bp: 2_500, target_margin_bp: 1_000 });
    expect(r.costs.driver_pay_cents).toBe(62_500);
    // flat costs 117,237 ÷ 0.75 = 156,316; with a 10% margin ÷ 0.65 = 180,365
    expect(r.break_even_rate_cents).toBe(156_316);
    expect(r.suggested_rate_cents).toBe(180_365);
  });
  it('rejects a trip with no miles', () => {
    expect(() => rateCalc({ ...base, loaded_miles: 0, deadhead_miles: 0 })).toThrow();
  });
});

describe('vendor mapping', () => {
  it('maps Samsara HOS clocks', () => {
    expect(mapSamsara({
      data: [{ driver: { id: '52', name: 'Marcus Reed' }, currentDutyStatus: { hosStatusType: 'driving' }, clocks: { drive: { driveRemainingDurationMs: 18_000_000 }, shift: { shiftRemainingDurationMs: 25_200_000 }, cycle: { cycleRemainingDurationMs: 108_000_000 }, break: { timeUntilBreakDurationMs: 3_600_000 } } }, { clocks: {} }],
    })).toEqual([{ eld_driver_id: '52', name: 'Marcus Reed', duty_status: 'driving', drive_remaining_min: 300, shift_remaining_min: 420, cycle_remaining_min: 1800, break_due_in_min: 60 }]);
  });
  it('maps Motive available time (seconds) and tolerates missing fields', () => {
    expect(mapMotive({ users: [{ user: { id: 9, first_name: 'Ana', last_name: 'T', duty_status: 'on_duty', available_time: { drive: 3600, shift: 7200 } } }, {}] })).toEqual([
      { eld_driver_id: '9', name: 'Ana T', duty_status: 'on_duty', drive_remaining_min: 60, shift_remaining_min: 120, cycle_remaining_min: null, break_due_in_min: null },
    ]);
  });
  it('converts Traccar knots to mph', () => {
    expect(normalizePosition({ id: 1, deviceId: 7, latitude: 32.7, longitude: -96.8, speed: 52.1, course: 90, fixTime: '2026-10-19T10:00:00Z', attributes: { ignition: true } }))
      .toMatchObject({ device_id: '7', speed_mph: 60, ignition: true });
  });
});

describe('secrets', () => {
  it('round-trips and is bound to its tenant and provider', async () => {
    const { iv, ct } = await encryptSecret(KEY, '{"token":"abc"}', 't1:traccar');
    expect(ct).not.toContain('abc');
    expect(await decryptSecret(KEY, iv, ct, 't1:traccar')).toBe('{"token":"abc"}');
    await expect(decryptSecret(KEY, iv, ct, 't2:traccar')).rejects.toThrow();
  });
  it('fails cleanly without a key', async () => {
    await expect(encryptSecret(undefined, 'x', 'a')).rejects.toMatchObject({ status: 501 });
  });
});

describe('Stripe signatures', () => {
  async function sign(payload: string, t: number, secret = 'whsec_test_secret') {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
    return `t=${t},v1=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  it('accepts a valid signature and rejects tampering, wrong secrets and stale timestamps', async () => {
    const now = 1_760_000_000;
    const header = await sign('{"a":1}', now);
    expect(await verifyStripeSignature('{"a":1}', header, 'whsec_test_secret', now)).toBe(true);
    expect(await verifyStripeSignature('{"a":2}', header, 'whsec_test_secret', now)).toBe(false);
    expect(await verifyStripeSignature('{"a":1}', header, 'other', now)).toBe(false);
    expect(await verifyStripeSignature('{"a":1}', header, 'whsec_test_secret', now + 301)).toBe(false);
    expect(await verifyStripeSignature('{"a":1}', undefined, 'whsec_test_secret', now)).toBe(false);
  });
});

