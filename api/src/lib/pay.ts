import { roundDiv } from './money';

export type PayKind = 'per_mile' | 'percent' | 'per_stop' | 'hourly' | 'per_diem';

export interface PayRate {
  id: string;
  kind: PayKind;
  /** per_mile: millicents/mile; percent: basis points; per_stop: cents/stop; hourly: cents/hour; per_diem: cents/day. */
  rate: number;
  basis: 'loaded' | 'all' | 'extra' | null;
}

export interface PayLoad {
  id: string;
  load_number: string;
  rate_cents: number;
  fuel_surcharge_cents: number;
  accessorial_cents: number;
  loaded_miles: number | null;
  empty_miles: number | null;
  stop_count: number;
  pay_hours_x100: number | null;
  dispatched_at: string | null;
  delivered_at: string | null;
}

export interface PayLine {
  pay_rate_id: string;
  pay_kind: PayKind;
  quantity: number;
  quantity_unit: 'miles' | 'stops' | 'hours_x100' | 'days' | 'cents';
  unit_rate: number;
  gross_cents: number | null;
  rate_bp: number | null;
  amount_cents: number;
  description: string;
}

export type PayResult = { line: PayLine } | { skip: string };

/** The load gross a percentage driver is paid on: linehaul + fuel surcharge + accessorials. */
export const loadGross = (l: PayLoad) => l.rate_cents + l.fuel_surcharge_cents + l.accessorial_cents;

const money = (cents: number) => `$${Math.floor(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
/** 62500 millicents -> "$0.625/mi" (integer formatting, at least two decimals). */
const perMile = (millicents: number) => {
  const frac = String(millicents % 100_000).padStart(5, '0').replace(/0+$/, '').padEnd(2, '0');
  return `$${Math.floor(millicents / 100_000)}.${frac}/mi`;
};

/** Calendar days from dispatch to delivery, inclusive (minimum 1). */
export function perDiemDays(dispatchedAt: string | null, deliveredAt: string | null): number {
  if (!dispatchedAt || !deliveredAt) return 1;
  const start = Date.UTC(...ymd(dispatchedAt));
  const end = Date.UTC(...ymd(deliveredAt));
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}
const ymd = (iso: string): [number, number, number] => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return [y!, m! - 1, d!];
};

/** One pay line for one load under one pay rate. Pure integer math. */
export function computeLoadPay(load: PayLoad, rate: PayRate): PayResult {
  switch (rate.kind) {
    case 'per_mile': {
      if (load.loaded_miles === null) return { skip: `${load.load_number}: no loaded miles recorded` };
      const miles = rate.basis === 'all' ? load.loaded_miles + (load.empty_miles ?? 0) : load.loaded_miles;
      return {
        line: {
          pay_rate_id: rate.id,
          pay_kind: 'per_mile',
          quantity: miles,
          quantity_unit: 'miles',
          unit_rate: rate.rate,
          gross_cents: null,
          rate_bp: null,
          amount_cents: roundDiv(miles * rate.rate, 1000),
          description: `${miles.toLocaleString('en-US')} ${rate.basis === 'all' ? 'total' : 'loaded'} mi × ${perMile(rate.rate)}`,
        },
      };
    }
    case 'percent': {
      const gross = loadGross(load);
      return {
        line: {
          pay_rate_id: rate.id,
          pay_kind: 'percent',
          quantity: gross,
          quantity_unit: 'cents',
          unit_rate: rate.rate,
          gross_cents: gross,
          rate_bp: rate.rate,
          amount_cents: roundDiv(gross * rate.rate, 10_000),
          description: `${(rate.rate / 100).toFixed(2)}% of load gross ${money(gross)}`,
        },
      };
    }
    case 'per_stop': {
      const stops = rate.basis === 'extra' ? Math.max(0, load.stop_count - 2) : load.stop_count;
      if (stops === 0) return { skip: `${load.load_number}: no extra stops` };
      return {
        line: {
          pay_rate_id: rate.id,
          pay_kind: 'per_stop',
          quantity: stops,
          quantity_unit: 'stops',
          unit_rate: rate.rate,
          gross_cents: null,
          rate_bp: null,
          amount_cents: stops * rate.rate,
          description: `${stops} ${rate.basis === 'extra' ? 'extra ' : ''}stop${stops === 1 ? '' : 's'} × ${money(rate.rate)}`,
        },
      };
    }
    case 'hourly': {
      if (load.pay_hours_x100 === null) return { skip: `${load.load_number}: no hours recorded for hourly pay` };
      return {
        line: {
          pay_rate_id: rate.id,
          pay_kind: 'hourly',
          quantity: load.pay_hours_x100,
          quantity_unit: 'hours_x100',
          unit_rate: rate.rate,
          gross_cents: null,
          rate_bp: null,
          amount_cents: roundDiv(load.pay_hours_x100 * rate.rate, 100),
          description: `${(load.pay_hours_x100 / 100).toFixed(2)} h × ${money(rate.rate)}/h`,
        },
      };
    }
    case 'per_diem': {
      const days = perDiemDays(load.dispatched_at, load.delivered_at);
      return {
        line: {
          pay_rate_id: rate.id,
          pay_kind: 'per_diem',
          quantity: days,
          quantity_unit: 'days',
          unit_rate: rate.rate,
          gross_cents: null,
          rate_bp: null,
          amount_cents: days * rate.rate,
          description: `Per diem: ${days} day${days === 1 ? '' : 's'} × ${money(rate.rate)}`,
        },
      };
    }
  }
}

/**
 * Escrow to hold this settlement: the configured per-settlement amount, capped
 * by what is still needed to reach the target and by the pay available (escrow
 * never drives a settlement negative).
 */
export function escrowHold(opts: { perSettlement: number; target: number; balance: number; availableNet: number }): number {
  const needed = Math.max(0, opts.target - opts.balance);
  return Math.max(0, Math.min(opts.perSettlement, needed, opts.availableNet));
}
