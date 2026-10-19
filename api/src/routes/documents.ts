import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Auth } from '../types';
import { isStaff, requireRole } from '../lib/auth';
import { badRequest, forbidden, newId, notFound, nowIso } from '../lib/http';

export const documents = new Hono<AppEnv>();

export const DOCUMENT_KINDS = ['bol', 'pod', 'rate_confirmation', 'receipt', 'lumper', 'scale', 'invoice', 'dqf', 'dvir', 'repair', 'other'] as const;
/** What a driver may upload from the road. */
const DRIVER_KINDS = new Set(['bol', 'pod', 'receipt', 'lumper', 'scale', 'dvir', 'other']);
const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

export interface DocumentRow {
  id: string;
  kind: string;
  load_id: string | null;
  driver_id: string | null;
  truck_id: string | null;
  r2_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

export const DOC_COLUMNS = 'id, kind, load_id, driver_id, truck_id, r2_key, filename, content_type, size_bytes, created_at';

/**
 * Truth-in-Leasing (49 CFR 376.12(g)): a driver paid a percentage of the load's
 * revenue is entitled to the rated freight bill. They may open the load's rate
 * confirmation when a percentage pay rate covers the load, or it was settled on one.
 */
export async function percentPaidOnLoad(db: D1Database, tenantId: string, driverId: string, loadId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM loads l
        WHERE l.tenant_id = ?1 AND l.id = ?2 AND l.driver_id = ?3 AND (
          EXISTS (SELECT 1 FROM driver_pay_rates r
                   WHERE r.tenant_id = ?1 AND r.driver_id = ?3 AND r.kind = 'percent'
                     AND r.effective_from <= substr(COALESCE(l.delivered_at, l.created_at), 1, 10)
                     AND (r.effective_to IS NULL OR r.effective_to >= substr(COALESCE(l.delivered_at, l.created_at), 1, 10)))
          OR EXISTS (SELECT 1 FROM settlement_lines sl JOIN settlements s ON s.tenant_id = sl.tenant_id AND s.id = sl.settlement_id
                      WHERE sl.tenant_id = ?1 AND sl.load_id = ?2 AND sl.pay_kind = 'percent' AND s.driver_id = ?3))`,
    )
    .bind(tenantId, loadId, driverId)
    .first();
  return !!row;
}

/** Whether this principal may see (list or open) a document. */
export async function canReadDocument(db: D1Database, auth: Auth, doc: DocumentRow): Promise<boolean> {
  if (isStaff(auth)) return true;
  if (!auth.driverId) return false;
  if (doc.load_id) {
    const load = await db.prepare('SELECT driver_id FROM loads WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, doc.load_id).first<{ driver_id: string | null }>();
    if (load?.driver_id !== auth.driverId) return false;
    if (doc.kind === 'invoice') return false;
    if (doc.kind === 'rate_confirmation') return percentPaidOnLoad(db, auth.tenantId, auth.driverId, doc.load_id);
    return true;
  }
  return doc.driver_id === auth.driverId;
}

export async function listDocuments(db: D1Database, auth: Auth, where: { load_id?: string; driver_id?: string; truck_id?: string }) {
  const { results } = await db
    .prepare(
      `SELECT ${DOC_COLUMNS} FROM documents
        WHERE tenant_id = ?1 AND (?2 IS NULL OR load_id = ?2) AND (?3 IS NULL OR driver_id = ?3) AND (?4 IS NULL OR truck_id = ?4)
        ORDER BY created_at DESC LIMIT 500`,
    )
    .bind(auth.tenantId, where.load_id ?? null, where.driver_id ?? null, where.truck_id ?? null)
    .all<DocumentRow>();
  const visible: Omit<DocumentRow, 'r2_key'>[] = [];
  for (const d of results) {
    if (await canReadDocument(db, auth, d)) {
      const { r2_key: _key, ...rest } = d;
      visible.push(rest);
    }
  }
  return visible;
}

const metaSchema = z.strictObject({
  kind: z.enum(DOCUMENT_KINDS),
  load_id: z.string().max(64).optional(),
  driver_id: z.string().max(64).optional(),
  truck_id: z.string().max(64).optional(),
});

documents.get('/', async (c) => {
  const auth = c.get('auth');
  const q = c.req.query();
  if (!isStaff(auth) && !q.load_id) forbidden('Drivers list documents per load');
  return c.json({ documents: await listDocuments(c.env.DB, auth, { load_id: q.load_id, driver_id: q.driver_id, truck_id: q.truck_id }) });
});

documents.post('/', async (c) => {
  const auth = c.get('auth');
  let form: Record<string, string | File>;
  try {
    form = (await c.req.parseBody()) as Record<string, string | File>;
  } catch {
    badRequest('Expected multipart/form-data');
  }
  const file = form.file;
  if (!(file instanceof File)) badRequest('file: required');
  const meta = metaSchema.safeParse({
    kind: form.kind,
    load_id: typeof form.load_id === 'string' && form.load_id ? form.load_id : undefined,
    driver_id: typeof form.driver_id === 'string' && form.driver_id ? form.driver_id : undefined,
    truck_id: typeof form.truck_id === 'string' && form.truck_id ? form.truck_id : undefined,
  });
  if (!meta.success) badRequest(meta.error.issues[0]?.message ?? 'Invalid document fields');
  const input = { ...meta.data };
  if (file.size === 0) badRequest('file: empty');
  if (file.size > MAX_BYTES) badRequest('file: larger than 15 MB');
  const contentType = file.type || 'application/octet-stream';
  if (!ALLOWED_TYPES.has(contentType)) badRequest('file: only PDF and photos (JPEG, PNG, WebP, HEIC) are accepted');

  if (!isStaff(auth)) {
    if (!DRIVER_KINDS.has(input.kind)) forbidden(`Drivers cannot upload ${input.kind} documents`);
    if (input.truck_id) forbidden('Drivers attach documents to a load or to themselves');
    if (input.load_id) {
      const load = await c.env.DB.prepare('SELECT driver_id FROM loads WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, input.load_id).first<{ driver_id: string | null }>();
      if (load?.driver_id !== auth.driverId) notFound('Load not found');
    }
    input.driver_id = auth.driverId!;
  } else {
    for (const [field, table] of [['load_id', 'loads'], ['driver_id', 'drivers'], ['truck_id', 'trucks']] as const) {
      const value = input[field];
      if (!value) continue;
      const found = await c.env.DB.prepare(`SELECT 1 FROM ${table} WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, value).first();
      if (!found) badRequest(`${field}: not found`);
    }
  }
  if (input.kind === 'pod' && !input.load_id) badRequest('A POD must be attached to a load');

  const id = newId();
  // Keys are tenant-prefixed so a bucket listing can never mix carriers.
  const key = `${auth.tenantId}/${id}`;
  await c.env.DOCS.put(key, file.stream(), { httpMetadata: { contentType } });
  const now = nowIso();
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO documents (id, tenant_id, kind, load_id, driver_id, truck_id, r2_key, filename, content_type, size_bytes, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, auth.tenantId, input.kind, input.load_id ?? null, input.driver_id ?? null, input.truck_id ?? null, key,
      file.name.slice(0, 200) || 'upload', contentType, file.size, auth.userId, now),
  ];
  if (input.kind === 'pod') {
    statements.push(
      c.env.DB.prepare('UPDATE loads SET pod_received_at = COALESCE(pod_received_at, ?) WHERE tenant_id = ? AND id = ?').bind(now, auth.tenantId, input.load_id!),
    );
  }
  try {
    await c.env.DB.batch(statements);
  } catch (err) {
    await c.env.DOCS.delete(key);
    throw err;
  }
  const doc = await c.env.DB.prepare(`SELECT ${DOC_COLUMNS} FROM documents WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, id).first<DocumentRow>();
  const { r2_key: _key, ...rest } = doc!;
  return c.json({ document: rest }, 201);
});

documents.get('/:id/file', async (c) => {
  const auth = c.get('auth');
  const doc = await c.env.DB.prepare(`SELECT ${DOC_COLUMNS} FROM documents WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, c.req.param('id')).first<DocumentRow>();
  if (!doc || !(await canReadDocument(c.env.DB, auth, doc))) notFound('Document not found');
  const object = await c.env.DOCS.get(doc.r2_key);
  if (!object) notFound('File missing from storage');
  return new Response(object.body, {
    headers: {
      'Content-Type': doc.content_type,
      'Content-Disposition': `inline; filename="${doc.filename.replace(/["\\\r\n]/g, '_')}"`,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

documents.delete('/:id', requireRole('owner', 'dispatcher'), async (c) => {
  const auth = c.get('auth');
  const doc = await c.env.DB.prepare(`SELECT ${DOC_COLUMNS} FROM documents WHERE tenant_id = ? AND id = ?`).bind(auth.tenantId, c.req.param('id')).first<DocumentRow>();
  if (!doc) notFound('Document not found');
  const statements = [c.env.DB.prepare('DELETE FROM documents WHERE tenant_id = ? AND id = ?').bind(auth.tenantId, doc.id)];
  if (doc.kind === 'pod' && doc.load_id) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE loads SET pod_received_at = (SELECT MIN(created_at) FROM documents WHERE tenant_id = ?1 AND load_id = ?2 AND kind = 'pod')
          WHERE tenant_id = ?1 AND id = ?2`,
      ).bind(auth.tenantId, doc.load_id),
    );
  }
  try {
    await c.env.DB.batch(statements);
  } catch (err) {
    if (String(err).includes('FOREIGN KEY')) badRequest('This document is cited by a settlement or charge and cannot be deleted');
    throw err;
  }
  await c.env.DOCS.delete(doc.r2_key);
  return c.body(null, 204);
});
