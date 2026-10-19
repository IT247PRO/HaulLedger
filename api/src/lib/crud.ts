import { Hono } from 'hono';
import type { z } from 'zod';
import type { AppEnv, Role } from '../types';
import { requireRole } from './auth';
import { badRequest, conflict, insertRow, newId, notFound, nowIso, setClause } from './http';
import { body } from './validate';

interface CrudOptions {
  table: string;
  columns: string;
  orderBy: string;
  listKey: string;
  itemKey: string;
  label: string;
  roles: Role[];
  createSchema: z.ZodType<Record<string, unknown>>;
  updateSchema: z.ZodType<Record<string, unknown>>;
}

/**
 * Tenant-scoped list/get/create/update for simple reference tables. Every
 * statement binds tenant_id from the session; the request never supplies it.
 */
export function crudRoutes(o: CrudOptions) {
  const r = new Hono<AppEnv>();
  r.use('*', requireRole(...o.roles));
  const getOne = (db: D1Database, tenantId: string, id: string) =>
    db.prepare(`SELECT ${o.columns} FROM ${o.table} WHERE tenant_id = ? AND id = ?`).bind(tenantId, id).first();

  r.get('/', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT ${o.columns} FROM ${o.table} WHERE tenant_id = ? ORDER BY ${o.orderBy}`,
    )
      .bind(c.get('auth').tenantId)
      .all();
    return c.json({ [o.listKey]: results });
  });

  r.get('/:id', async (c) => {
    const row = await getOne(c.env.DB, c.get('auth').tenantId, c.req.param('id'));
    if (!row) notFound(`${o.label} not found`);
    return c.json({ [o.itemKey]: row });
  });

  r.post('/', async (c) => {
    const { tenantId } = c.get('auth');
    const input = await body(c, o.createSchema);
    const id = newId();
    await uniqueGuard(o.label, () => insertRow(c.env.DB, o.table, { id, tenant_id: tenantId, ...input }).run());
    return c.json({ [o.itemKey]: await getOne(c.env.DB, tenantId, id) }, 201);
  });

  r.patch('/:id', async (c) => {
    const { tenantId } = c.get('auth');
    const set = setClause(await body(c, o.updateSchema));
    if (!set.sql) badRequest('Nothing to update');
    const res = await uniqueGuard(o.label, () =>
      c.env.DB.prepare(`UPDATE ${o.table} SET ${set.sql}, updated_at = ? WHERE tenant_id = ? AND id = ?`)
        .bind(...set.params, nowIso(), tenantId, c.req.param('id'))
        .run(),
    );
    if (!res.meta.changes) notFound(`${o.label} not found`);
    return c.json({ [o.itemKey]: await getOne(c.env.DB, tenantId, c.req.param('id')) });
  });

  return r;
}

/** Turns a UNIQUE constraint failure into a 409 instead of a 500. */
export async function uniqueGuard<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (String(err).includes('UNIQUE constraint failed')) conflict(`${label} already exists`);
    throw err;
  }
}
