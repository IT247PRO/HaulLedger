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
