import { HTTPException } from 'hono/http-exception';

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

export function notFound(what = 'Not found'): never {
  throw new HTTPException(404, { message: what });
}

export function forbidden(what = 'Forbidden'): never {
  throw new HTTPException(403, { message: what });
}

export function badRequest(what: string): never {
  throw new HTTPException(400, { message: what });
}

export function conflict(what: string): never {
  throw new HTTPException(409, { message: what });
}

/**
 * Builds "col = ?, col2 = ?" from a validated patch. Keys must come from a
 * strict zod schema so they are known column names, never user-chosen strings.
 */
export function setClause(patch: Record<string, unknown>): { sql: string; params: unknown[] } {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  return {
    sql: entries.map(([k]) => `${k} = ?`).join(', '),
    params: entries.map(([, v]) => v),
  };
}

/** Prepares an INSERT for a validated row. `table` is always a constant at the call site. */
export function insertRow(db: D1Database, table: string, row: Record<string, unknown>): D1PreparedStatement {
  const entries = Object.entries(row).filter(([, v]) => v !== undefined);
  const cols = entries.map(([k]) => k).join(', ');
  const marks = entries.map(() => '?').join(', ');
  return db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${marks})`).bind(...entries.map(([, v]) => v));
}
