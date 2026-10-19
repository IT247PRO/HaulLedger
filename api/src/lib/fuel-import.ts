// Normalizes fuel-card exports (EFS, WEX, Comdata) into one transaction shape.
// Column names differ by provider and by report, so each canonical field has a
// list of header aliases; an explicit mapping from the user always wins.

export const FUEL_FIELDS = ['date', 'time', 'card', 'unit', 'driver', 'merchant', 'city', 'state', 'product', 'gallons', 'amount', 'transaction_id'] as const;
export type FuelField = (typeof FUEL_FIELDS)[number];
export type Mapping = Partial<Record<FuelField, string>>;

const ALIASES: Record<FuelField, string[]> = {
  date: ['tran date', 'transaction date', 'trans date', 'date', 'purchase date', 'posted date'],
  time: ['tran time', 'transaction time', 'trans time', 'time'],
  card: ['card #', 'card number', 'card no', 'card', 'card num', 'card last 4'],
  unit: ['unit', 'unit number', 'unit #', 'truck', 'truck number', 'tractor', 'vehicle', 'vehicle number', 'vehicle id'],
  driver: ['driver name', 'driver', 'driver id', 'employee name'],
  merchant: ['location name', 'truck stop name', 'merchant name', 'merchant', 'site name', 'location'],
  city: ['city', 'truck stop city', 'merchant city', 'location city'],
  state: ['state/ prov', 'state/prov', 'state', 'truck stop state', 'merchant state', 'st', 'location state', 'jurisdiction'],
  product: ['item', 'product', 'product description', 'fuel type', 'product code', 'item description'],
  gallons: ['qty', 'quantity', 'gallons', 'units', 'number of tractor gallons', 'tractor gallons', 'fuel quantity', 'volume'],
  amount: ['amt', 'amount', 'total amount', 'total amount due', 'net amount', 'net cost', 'total fuel cost', 'total', 'line amount'],
  transaction_id: ['invoice', 'invoice #', 'transaction number', 'transaction id', 'trans id', 'transaction #', 'auth code', 'reference'],
};

const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');

/** Finds each canonical field's column index. */
export function resolveColumns(header: string[], mapping: Mapping = {}): { columns: Partial<Record<FuelField, number>>; missing: FuelField[] } {
  const headers = header.map(norm);
  const columns: Partial<Record<FuelField, number>> = {};
  for (const field of FUEL_FIELDS) {
    const explicit = mapping[field];
    const idx = explicit !== undefined ? headers.indexOf(norm(explicit)) : ALIASES[field].map((a) => headers.indexOf(a)).find((i) => i >= 0);
    if (idx !== undefined && idx >= 0) columns[field] = idx;
  }
  const required: FuelField[] = ['date', 'state', 'amount'];
  return { columns, missing: required.filter((f) => columns[f] === undefined) };
}

/** "$1,234.56" -> 123456; "(12.00)" or "-12.00" -> -1200. Digit parsing, no floats. */
export function parseMoney(raw: string): number | null {
  let s = raw.trim().replace(/[$,\s]/g, '');
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    sign = -sign;
    s = s.slice(1);
  }
  const m = /^(\d*)(?:\.(\d{0,4}))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return null;
  // Round sub-cent precision half-up on the integer digits.
  const frac = (m[2] ?? '').padEnd(4, '0');
  const tenThousandths = Number(m[1] || '0') * 10_000 + Number(frac);
  return sign * Math.floor((tenThousandths + 50) / 100);
}

/** "120.456" -> 120456 (thousandths of a gallon). */
export function parseGallons(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '');
  if (s === '') return 0;
  const m = /^(\d*)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return null;
  const frac = (m[2] ?? '').padEnd(6, '0');
  const micro = Number(m[1] || '0') * 1_000_000 + Number(frac);
  return Math.floor((micro + 500) / 1000);
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY, MM/DD/YY, with an optional time (own column or same cell). */
export function parseDateTime(dateRaw: string, timeRaw = ''): string | null {
  const [d, ...rest] = dateRaw.trim().split(/[ T]+/);
  if (!d) return null;
  let y: number, mo: number, day: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(d);
  if (m) [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(d))) {
    [mo, day, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += 2000;
  } else return null;
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
  const t = (timeRaw.trim() || rest.join(' ')).toUpperCase();
  let hh = 0, mm = 0;
  const tm = /^(\d{1,2}):?(\d{2})(?::\d{2})?\s*(AM|PM)?$/.exec(t);
  if (tm) {
    hh = Number(tm[1]);
    mm = Number(tm[2]);
    if (tm[3] === 'PM' && hh < 12) hh += 12;
    if (tm[3] === 'AM' && hh === 12) hh = 0;
  }
  const date = new Date(Date.UTC(y, mo - 1, day, hh, mm));
  if (date.getUTCDate() !== day) return null;
  return date.toISOString();
}

export type Product = 'diesel' | 'gasoline' | 'def' | 'reefer' | 'cash_advance' | 'other';

/** Maps a product description to a fuel class. A blank product uses the import's stated default. */
export function classifyProduct(raw: string, fallback: Product = 'diesel'): Product {
  const s = raw.trim().toUpperCase();
  if (!s) return fallback;
  if (/\bDEF\b|EXHAUST FLUID|DEFD/.test(s)) return 'def';
  if (/REEF|RFR/.test(s)) return 'reefer';
  if (/CADV|CASH|ADVANCE|CHECK/.test(s)) return 'cash_advance';
  if (/ULSD|DSL|DIESEL|\bD2\b|#2|TRKD|BIO|B\d{1,2}\b/.test(s)) return 'diesel';
  if (/GAS|UNL|UNLEADED|REG/.test(s)) return 'gasoline';
  return 'other';
}

export interface NormalizedFuelRow {
  transacted_at: string;
  card_last4: string | null;
  raw_unit: string | null;
  raw_driver: string | null;
  merchant: string | null;
  city: string | null;
  state: string;
  product: Product;
  gallons_milli: number;
  amount_cents: number;
  transaction_id: string | null;
}

export type RowResult = { row: NormalizedFuelRow } | { error: string };

export function normalizeRow(cells: string[], columns: Partial<Record<FuelField, number>>, defaultProduct: Product = 'diesel'): RowResult {
  const get = (f: FuelField) => (columns[f] === undefined ? '' : (cells[columns[f]!] ?? '').trim());
  const transacted_at = parseDateTime(get('date'), get('time'));
  if (!transacted_at) return { error: `unreadable date "${get('date')}"` };
  const state = get('state').toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return { error: `unreadable state "${get('state')}"` };
  const amount = parseMoney(get('amount'));
  if (amount === null) return { error: `unreadable amount "${get('amount')}"` };
  const gallons = parseGallons(get('gallons'));
  if (gallons === null) return { error: `unreadable gallons "${get('gallons')}"` };
  const card = get('card').replace(/\D/g, '');
  return {
    row: {
      transacted_at,
      card_last4: card ? card.slice(-4) : null,
      raw_unit: get('unit') || null,
      raw_driver: get('driver') || null,
      merchant: get('merchant') || null,
      city: get('city') || null,
      state,
      product: classifyProduct(get('product'), defaultProduct),
      gallons_milli: gallons,
      amount_cents: amount,
      transaction_id: get('transaction_id') || null,
    },
  };
}
