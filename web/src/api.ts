export type Role = 'owner' | 'dispatcher' | 'driver';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  driver_id: string | null;
  tenant_id: string;
  tenant_name: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** JSON fetch against the Worker. The session rides in an HttpOnly cookie. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

/** Display only. Money stays integer cents everywhere else. */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** "2,450.5" -> 245050. Parses digits, never floats, so no rounding drift. */
export function parseDollars(input: string): number | null {
  const s = input.replace(/[$,\s]/g, '');
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export const STATUS_LABEL: Record<string, string> = {
  planned: 'Planned',
  dispatched: 'Dispatched',
  at_pickup: 'At pickup',
  in_transit: 'In transit',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/** Multipart upload (documents). */
export async function uploadDocument(fields: Record<string, string>, file: File): Promise<{ document: any }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v) form.set(k, v);
  form.set('file', file);
  const res = await fetch('/api/documents', { method: 'POST', credentials: 'same-origin', body: form });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data;
}

/** "0.625" with places=5 -> 62500. Digit parsing only; null when malformed or too precise. */
export function parseScaled(input: string, places: number): number | null {
  const s = input.replace(/[$,%\s]/g, '');
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{0,${places}}))?$`).exec(s);
  if (!m) return null;
  return Number(m[1]) * 10 ** places + Number((m[2] ?? '').padEnd(places, '0'));
}

/** Integer scaled value -> decimal string, e.g. (62500, 5) -> "0.625" (keeps at least 2 decimals). */
export function formatScaled(value: number, places: number, minDecimals = 2): string {
  const whole = Math.floor(value / 10 ** places);
  let frac = String(value % 10 ** places).padStart(places, '0').replace(/0+$/, '');
  if (frac.length < minDecimals) frac = frac.padEnd(minDecimals, '0');
  return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US');
}

export const PAY_KIND_LABEL: Record<string, string> = {
  per_mile: 'Per mile',
  percent: 'Percent of gross',
  per_stop: 'Per stop',
  hourly: 'Hourly',
  per_diem: 'Per diem',
};

export function formatPayRate(r: { kind: string; rate: number; basis: string | null }): string {
  switch (r.kind) {
    case 'per_mile':
      return `$${formatScaled(r.rate, 5)}/mi (${r.basis === 'all' ? 'all miles' : 'loaded miles'})`;
    case 'percent':
      return `${formatScaled(r.rate, 2)}% of load gross`;
    case 'per_stop':
      return `${formatCents(r.rate)}/stop (${r.basis === 'extra' ? 'extra stops' : 'every stop'})`;
    case 'hourly':
      return `${formatCents(r.rate)}/hour`;
    case 'per_diem':
      return `${formatCents(r.rate)}/day`;
    default:
      return String(r.rate);
  }
}

export const DOC_KIND_LABEL: Record<string, string> = {
  bol: 'BOL',
  pod: 'POD',
  rate_confirmation: 'Rate confirmation',
  receipt: 'Receipt',
  lumper: 'Lumper receipt',
  scale: 'Scale ticket',
  invoice: 'Invoice',
  dqf: 'DQ file',
  dvir: 'DVIR',
  repair: 'Repair',
  other: 'Other',
};

export const label = (s: string) => (s === 'eld' ? 'ELD' : s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()));
