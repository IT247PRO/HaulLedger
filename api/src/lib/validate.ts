import type { Context } from 'hono';
import { z } from 'zod';
import { badRequest } from './http';

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    badRequest('Expected a JSON body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    badRequest(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body');
  }
  return parsed.data;
}

// Shared field shapes.
export const optText = z.string().trim().max(500).nullable().optional();
export const isoDate = z.iso.date();
export const optDate = isoDate.nullable().optional();
export const cents = z.int().min(0).max(1_000_000_000);
export const usState = z.string().trim().toUpperCase().length(2);
