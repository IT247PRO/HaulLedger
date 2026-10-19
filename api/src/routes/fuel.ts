import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Auth } from '../types';
import { requireRole } from '../lib/auth';
import { uniqueGuard } from '../lib/crud';
import { sha256Hex } from '../lib/crypto';
import { parseCsv } from '../lib/csv';
import { normalizeRow, resolveColumns, FUEL_FIELDS, type Mapping, type NormalizedFuelRow, type Product } from '../lib/fuel-import';
import { badRequest, conflict, forbidden, insertRow, newId, notFound } from '../lib/http';
import { body, cents, optText, usState } from '../lib/validate';

export const fuel = new Hono<AppEnv>();
fuel.use('*', requireRole('owner', 'dispatcher'));

const TX_COLUMNS = `f.id, f.provider, f.external_id, f.transacted_at, f.card_last4, f.raw_unit, f.raw_driver, f.truck_id, f.driver_id, f.load_id,
  f.merchant, f.city, f.state, f.product, f.gallons_milli, f.amount_cents, f.import_id, f.created_at,
  t.unit_number AS truck_unit, d.first_name || ' ' || d.last_name AS driver_name, l.load_number,
  (SELECT ch.id FROM driver_charges ch WHERE ch.tenant_id = f.tenant_id AND ch.fuel_transaction_id = f.id) AS charge_id,
  (SELECT a.id FROM driver_advances a WHERE a.tenant_id = f.tenant_id AND a.fuel_transaction_id = f.id) AS advance_id`;
const TX_FROM = `FROM fuel_transactions f
  LEFT JOIN trucks t ON t.tenant_id = f.tenant_id AND t.id = f.truck_id
  LEFT JOIN drivers d ON d.tenant_id = f.tenant_id AND d.id = f.driver_id
  LEFT JOIN loads l ON l.tenant_id = f.tenant_id AND l.id = f.load_id`;

fuel.get('/transactions', async (c) => {
  const auth = c.get('auth');
  const q = c.req.query();
  const { results } = await c.env.DB.prepare(
    `SELECT ${TX_COLUMNS} ${TX_FROM}
      WHERE f.tenant_id = ?1 AND (?2 IS NULL OR f.transacted_at >= ?2) AND (?3 IS NULL OR f.transacted_at < ?3)
        AND (?4 IS NULL OR f.truck_id = ?4) AND (?5 = 0 OR f.truck_id IS NULL)
      ORDER BY f.transacted_at DESC LIMIT 1000`,
  )
    .bind(auth.tenantId, q.from ?? null, q.to ? nextDay(q.to) : null, q.truck_id ?? null, q.unmatched ? 1 : 0)
    .all();
  return c.json({ transactions: results });
});

fuel.get('/imports', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM fuel_imports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100').bind(c.get('auth').tenantId).all();
  return c.json({ imports: results });
});

const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const normUnit = (u: string) => u.trim().toUpperCase().replace(/^0+(?=\d)/, '');
const normName = (n: string) => n.trim().toUpperCase().replace(/\s+/g, ' ');

interface Matchers {
  trucks: Map<string, string>;
  cards: Map<string, { driver_id: string | null; truck_id: string | null }>;
  driversByName: Map<string, string | null>;
  drivers: Map<string, { pay_track: string; name: string }>;
  loads: { id: string; truck_id: string | null; driver_id: string | null; from: number; to: number }[];
}

async function loadMatchers(db: D1Database, tenantId: string, provider: string): Promise<Matchers> {
  const [trucks, cards, drivers, loads] = await Promise.all([
    db.prepare('SELECT id, unit_number FROM trucks WHERE tenant_id = ?').bind(tenantId).all<{ id: string; unit_number: string }>(),
    db.prepare('SELECT card_last4, driver_id, truck_id FROM fuel_cards WHERE tenant_id = ? AND provider = ?').bind(tenantId, provider).all<{ card_last4: string; driver_id: string | null; truck_id: string | null }>(),
    db.prepare('SELECT id, first_name, last_name, pay_track FROM drivers WHERE tenant_id = ?').bind(tenantId).all<{ id: string; first_name: string; last_name: string; pay_track: string }>(),
    db.prepare(`SELECT id, truck_id, driver_id, dispatched_at, delivered_at FROM loads WHERE tenant_id = ? AND dispatched_at IS NOT NULL AND status <> 'cancelled'`)
      .bind(tenantId)
      .all<{ id: string; truck_id: string | null; driver_id: string | null; dispatched_at: string; delivered_at: string | null }>(),
  ]);
  const driversByName = new Map<string, string | null>();
  const addName = (key: string, id: string) => driversByName.set(key, driversByName.has(key) && driversByName.get(key) !== id ? null : id); // null = ambiguous
  for (const d of drivers.results) {
    addName(normName(`${d.first_name} ${d.last_name}`), d.id);
    addName(normName(`${d.last_name}, ${d.first_name}`), d.id);
    addName(normName(`${d.last_name},${d.first_name}`), d.id);
  }
  // A fuel stop belongs to a load from dispatch until 12 hours after delivery (the drive home or to the next pickup).
  const GRACE = 12 * 3_600_000;
  return {
    trucks: new Map(trucks.results.map((t) => [normUnit(t.unit_number), t.id])),
    cards: new Map(cards.results.map((c) => [c.card_last4, { driver_id: c.driver_id, truck_id: c.truck_id }])),
    driversByName,
    drivers: new Map(drivers.results.map((d) => [d.id, { pay_track: d.pay_track, name: `${d.first_name} ${d.last_name}` }])),
    loads: loads.results.map((l) => ({
      id: l.id,
      truck_id: l.truck_id,
      driver_id: l.driver_id,
      from: Date.parse(l.dispatched_at),
      to: l.delivered_at ? Date.parse(l.delivered_at) + GRACE : Number.POSITIVE_INFINITY,
    })),
  };
}

export function matchRow(m: Matchers, row: Pick<NormalizedFuelRow, 'card_last4' | 'raw_unit' | 'raw_driver' | 'transacted_at'>) {
  const card = row.card_last4 ? m.cards.get(row.card_last4) : undefined;
  let truck_id = card?.truck_id ?? (row.raw_unit ? (m.trucks.get(normUnit(row.raw_unit)) ?? null) : null);
  let driver_id = card?.driver_id ?? (row.raw_driver ? (m.driversByName.get(normName(row.raw_driver)) ?? null) : null);
  const ts = Date.parse(row.transacted_at);
  const candidates = m.loads
    .filter((l) => ts >= l.from && ts <= l.to && ((truck_id && l.truck_id === truck_id) || (driver_id && l.driver_id === driver_id)))
    .sort((a, b) => b.from - a.from);
  const load = candidates[0];
  if (load) {
    truck_id ??= load.truck_id;
    driver_id ??= load.driver_id;
  }
  return { truck_id, driver_id, load_id: load?.id ?? null };
}

const PRODUCT_LABEL: Record<Product, string> = { diesel: 'diesel', gasoline: 'gasoline', def: 'DEF', reefer: 'reefer fuel', cash_advance: 'cash advance', other: 'other' };
const gal = (milli: number) => `${Math.floor(milli / 1000)}.${String(milli % 1000).padStart(3, '0')} gal`;

/** Charge-back records for one new transaction: fuel to 1099 contractors as a deduction, card cash to any driver as an advance. */
function chargeBackStatements(db: D1Database, auth: Auth, m: Matchers, txId: string, provider: string, row: NormalizedFuelRow & { driver_id: string | null; load_id: string | null }) {
  if (!row.driver_id || row.amount_cents <= 0) return [];
  const where = [row.merchant, row.city, row.state].filter(Boolean).join(', ');
  const day = row.transacted_at.slice(0, 10);
  if (row.product === 'cash_advance') {
    return [insertRow(db, 'driver_advances', {
      id: newId(), tenant_id: auth.tenantId, driver_id: row.driver_id, amount_cents: row.amount_cents, issued_on: day,
      method: 'fuel_card', reference: `${provider.toUpperCase()} ${row.card_last4 ? `card …${row.card_last4}` : ''}`.trim(),
      memo: `Fuel-card cash at ${where}`, load_id: row.load_id, fuel_transaction_id: txId, created_by: auth.userId,
    })];
  }
  if (m.drivers.get(row.driver_id)?.pay_track !== '1099') return []; // company drivers' fuel is a company cost
  return [insertRow(db, 'driver_charges', {
    id: newId(), tenant_id: auth.tenantId, driver_id: row.driver_id, category: 'fuel', amount_cents: row.amount_cents, incurred_on: day,
    description: `${provider.toUpperCase()} ${where} — ${row.gallons_milli ? `${gal(row.gallons_milli)} ` : ''}${PRODUCT_LABEL[row.product]}`,
    load_id: row.load_id, fuel_transaction_id: txId, created_by: auth.userId,
  })];
}

fuel.post('/imports', async (c) => {
  const auth = c.get('auth');
  const form = (await c.req.parseBody().catch(() => badRequest('Expected multipart/form-data'))) as Record<string, string | File>;
  const file = form.file;
  if (!(file instanceof File)) badRequest('file: required');
  if (file.size > 5 * 1024 * 1024) badRequest('file: larger than 5 MB; split the export by week');
  const provider = z.enum(['efs', 'wex', 'comdata', 'other']).safeParse(form.provider);
  if (!provider.success) badRequest('provider: efs, wex, comdata or other');
  const chargeBack = form.charge_back === 'true';
  if (chargeBack && auth.role !== 'owner') forbidden('Only the owner can charge fuel back to drivers');
  const defaultProduct = z.enum(['diesel', 'gasoline', 'def', 'reefer', 'other']).catch('diesel').parse(form.default_product);
  let mapping: Mapping = {};
  if (typeof form.mapping === 'string' && form.mapping.trim()) {
    let json: unknown;
    try {
      json = JSON.parse(form.mapping);
    } catch {
      badRequest('mapping: not valid JSON');
    }
    const parsed = z.partialRecord(z.enum(FUEL_FIELDS), z.string()).safeParse(json);
    if (!parsed.success) badRequest('mapping: expected {"date": "<header>", ...}');
    mapping = parsed.data;
  }

  const rows = parseCsv(await file.text());
  const [header, ...data] = rows;
  if (!header || data.length === 0) badRequest('The file has no data rows');
  const { columns, missing } = resolveColumns(header, mapping);
  if (missing.length) {
    return c.json({ error: `Could not find columns for: ${missing.join(', ')}. Map them to one of these headers.`, missing, headers: header }, 422);
  }

  const m = await loadMatchers(c.env.DB, auth.tenantId, provider.data);
  const errors: { row: number; error: string }[] = [];
  const parsed: (NormalizedFuelRow & { external_id: string; truck_id: string | null; driver_id: string | null; load_id: string | null })[] = [];
  for (const [i, cells] of data.entries()) {
    const r = normalizeRow(cells, columns, defaultProduct);
    if ('error' in r) {
      errors.push({ row: i + 2, error: r.error });
      continue;
    }
    const row = r.row;
    const external_id = row.transaction_id
      ? `${row.transaction_id}|${row.product}|${row.amount_cents}|${row.gallons_milli}`
      : `h:${(await sha256Hex([row.transacted_at, row.card_last4, row.raw_unit, row.state, row.product, row.gallons_milli, row.amount_cents].join('|'))).slice(0, 32)}`;
    parsed.push({ ...row, external_id, ...matchRow(m, row) });
  }

  // Re-importing the same export never double-counts.
  const existing = new Set<string>();
  for (let i = 0; i < parsed.length; i += 80) {
    const chunk = parsed.slice(i, i + 80).map((p) => p.external_id);
    const { results } = await c.env.DB.prepare(
      `SELECT external_id FROM fuel_transactions WHERE tenant_id = ? AND provider = ? AND external_id IN (${chunk.map(() => '?').join(',')})`,
    )
      .bind(auth.tenantId, provider.data, ...chunk)
      .all<{ external_id: string }>();
    for (const r of results) existing.add(r.external_id);
  }
  const seen = new Set<string>();
  const fresh = parsed.filter((p) => !existing.has(p.external_id) && !seen.has(p.external_id) && seen.add(p.external_id));

  const importId = newId();
  const summary = {
    id: importId,
    provider: provider.data,
    filename: file.name.slice(0, 200) || 'fuel.csv',
    row_count: data.length,
    imported_count: fresh.length,
    duplicate_count: parsed.length - fresh.length,
    unmatched_count: fresh.filter((p) => !p.truck_id).length,
    error_count: errors.length,
  };
  const statements: D1PreparedStatement[] = [insertRow(c.env.DB, 'fuel_imports', { ...summary, tenant_id: auth.tenantId, created_by: auth.userId })];
  let chargebacks = 0;
  for (const p of fresh) {
    const txId = newId();
    statements.push(
      insertRow(c.env.DB, 'fuel_transactions', {
        id: txId, tenant_id: auth.tenantId, import_id: importId, provider: provider.data, external_id: p.external_id,
        transacted_at: p.transacted_at, card_last4: p.card_last4, raw_unit: p.raw_unit, raw_driver: p.raw_driver,
        truck_id: p.truck_id, driver_id: p.driver_id, load_id: p.load_id, merchant: p.merchant, city: p.city, state: p.state,
        product: p.product, gallons_milli: p.gallons_milli, amount_cents: p.amount_cents,
      }),
    );
    if (chargeBack) {
      const cb = chargeBackStatements(c.env.DB, auth, m, txId, provider.data, p);
      chargebacks += cb.length;
      statements.push(...cb);
    }
  }
  // D1 runs a batch as one transaction; very large files are split by the 5 MB cap above.
  await c.env.DB.batch(statements);
  return c.json({ import: summary, chargebacks, errors: errors.slice(0, 100) }, 201);
});

const manualSchema = z.strictObject({
  transacted_at: z.iso.datetime({ offset: true }),
  state: usState,
  city: optText,
  merchant: optText,
  product: z.enum(['diesel', 'gasoline', 'def', 'reefer', 'other']),
  gallons_milli: z.int().min(0).max(10_000_000),
  amount_cents: cents.min(1),
  truck_id: z.string().max(64).nullable().optional(),
  driver_id: z.string().max(64).nullable().optional(),
  load_id: z.string().max(64).nullable().optional(),
});

async function assertRefs(db: D1Database, tenantId: string, refs: { truck_id?: string | null; driver_id?: string | null; load_id?: string | null }) {
  for (const [field, table] of [['truck_id', 'trucks'], ['driver_id', 'drivers'], ['load_id', 'loads']] as const) {
    const v = refs[field];
    if (v && !(await db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ? AND id = ?`).bind(tenantId, v).first())) badRequest(`${field}: not found`);
  }
}

/** Cash or receipt fuel bought off-card. Needed for IFTA: every gallon has a state. */
fuel.post('/transactions', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, manualSchema);
  await assertRefs(c.env.DB, auth.tenantId, input);
  const id = newId();
  await insertRow(c.env.DB, 'fuel_transactions', { ...input, id, tenant_id: auth.tenantId, provider: 'manual', external_id: id, transacted_at: new Date(input.transacted_at).toISOString() }).run();
  return c.json({ transaction: await c.env.DB.prepare(`SELECT ${TX_COLUMNS} ${TX_FROM} WHERE f.tenant_id = ? AND f.id = ?`).bind(auth.tenantId, id).first() }, 201);
});

/** Fix a match. A charge-back follows the transaction unless it is already settled. */
fuel.patch('/transactions/:id', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, z.strictObject({ truck_id: z.string().max(64).nullable().optional(), driver_id: z.string().max(64).nullable().optional(), load_id: z.string().max(64).nullable().optional(), state: usState.optional() }));
  await assertRefs(c.env.DB, auth.tenantId, input);
  const db = c.env.DB;
  const tx = await db.prepare('SELECT id, driver_id FROM fuel_transactions WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, c.req.param('id')).first<{ id: string; driver_id: string | null }>();
  if (!tx) notFound('Fuel transaction not found');
  const linked = await db
    .prepare(
      `SELECT 'charge' AS kind, ch.id, EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl.tenant_id = ch.tenant_id AND sl.charge_id = ch.id) AS settled
         FROM driver_charges ch WHERE ch.tenant_id = ?1 AND ch.fuel_transaction_id = ?2
       UNION ALL
       SELECT 'advance', a.id, EXISTS (SELECT 1 FROM settlement_lines sl WHERE sl.tenant_id = a.tenant_id AND sl.advance_id = a.id)
         FROM driver_advances a WHERE a.tenant_id = ?1 AND a.fuel_transaction_id = ?2`,
    )
    .bind(auth.tenantId, tx.id)
    .all<{ kind: 'charge' | 'advance'; id: string; settled: number }>();
  const driverChanges = input.driver_id !== undefined && input.driver_id !== tx.driver_id;
  if (driverChanges && linked.results.some((l) => l.settled)) conflict('This purchase was already charged on a settlement; correct it with a new charge instead');
  if (driverChanges && linked.results.length && auth.role !== 'owner') forbidden('Only the owner can move a fuel charge-back to another driver');

  const statements: D1PreparedStatement[] = [];
  const entries = Object.entries(input).filter(([, v]) => v !== undefined);
  if (entries.length) {
    statements.push(db.prepare(`UPDATE fuel_transactions SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`).bind(...entries.map(([, v]) => v), auth.tenantId, tx.id));
  }
  if (driverChanges) {
    const newDriver = input.driver_id ? await db.prepare('SELECT pay_track FROM drivers WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, input.driver_id).first<{ pay_track: string }>() : null;
    for (const l of linked.results) {
      const table = l.kind === 'charge' ? 'driver_charges' : 'driver_advances';
      const keep = input.driver_id && (l.kind === 'advance' || newDriver?.pay_track === '1099');
      statements.push(
        keep
          ? db.prepare(`UPDATE ${table} SET driver_id = ? WHERE tenant_id = ? AND id = ?`).bind(input.driver_id, auth.tenantId, l.id)
          : db.prepare(`DELETE FROM ${table} WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, l.id),
      );
    }
  }
  if (statements.length) await db.batch(statements);
  return c.json({ transaction: await db.prepare(`SELECT ${TX_COLUMNS} ${TX_FROM} WHERE f.tenant_id = ? AND f.id = ?`).bind(auth.tenantId, tx.id).first() });
});

// ---------------------------------------------------------------- fuel cards

const cardSchema = z.strictObject({
  provider: z.enum(['efs', 'wex', 'comdata', 'other']),
  card_last4: z.string().regex(/^\d{4,6}$/, 'last 4–6 digits'),
  driver_id: z.string().max(64).nullable().optional(),
  truck_id: z.string().max(64).nullable().optional(),
});

fuel.get('/cards', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT fc.*, d.first_name || ' ' || d.last_name AS driver_name, t.unit_number AS truck_unit FROM fuel_cards fc
       LEFT JOIN drivers d ON d.tenant_id = fc.tenant_id AND d.id = fc.driver_id
       LEFT JOIN trucks t ON t.tenant_id = fc.tenant_id AND t.id = fc.truck_id
      WHERE fc.tenant_id = ? ORDER BY fc.provider, fc.card_last4`,
  )
    .bind(c.get('auth').tenantId)
    .all();
  return c.json({ cards: results });
});

fuel.post('/cards', async (c) => {
  const auth = c.get('auth');
  const input = await body(c, cardSchema);
  await assertRefs(c.env.DB, auth.tenantId, input);
  const id = newId();
  await uniqueGuard('That card', () => insertRow(c.env.DB, 'fuel_cards', { id, tenant_id: auth.tenantId, ...input, card_last4: input.card_last4.slice(-4) }).run());
  return c.json({ card: await c.env.DB.prepare('SELECT * FROM fuel_cards WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, id).first() }, 201);
});

fuel.delete('/cards/:id', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM fuel_cards WHERE tenant_id = ? AND id = ?').bind(c.get('auth').tenantId, c.req.param('id')).run();
  if (!res.meta.changes) notFound('Card not found');
  return c.body(null, 204);
});

