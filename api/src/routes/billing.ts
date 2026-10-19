import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../types';
import { requireRole } from '../lib/auth';
import { badRequest } from '../lib/http';
import { body } from '../lib/validate';

/**
 * Subscription billing via Stripe: one flat price per carrier (Starter $79 or
 * Fleet $129 a month), quantity always 1 — never per user, never per load, and
 * nothing taken from the carrier's freight.
 */
export const billing = new Hono<AppEnv>();
billing.use('*', requireRole('owner'));
export const stripeWebhook = new Hono<AppEnv>();

const PLANS = { starter: { label: 'Starter', monthly_cents: 7_900 }, fleet: { label: 'Fleet', monthly_cents: 12_900 } } as const;

function requireStripe(env: AppEnv['Bindings']) {
  if (!env.STRIPE_SECRET_KEY || !env.APP_URL) throw new HTTPException(501, { message: 'Billing is not configured: set STRIPE_SECRET_KEY, STRIPE_PRICE_STARTER, STRIPE_PRICE_FLEET and APP_URL.' });
  return env.STRIPE_SECRET_KEY;
}

async function stripe<T>(key: string, path: string, form: Record<string, string>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new HTTPException(502, { message: `Stripe: ${data.error?.message ?? res.status}` });
  return data;
}

billing.get('/', async (c) => {
  const t = await c.env.DB.prepare('SELECT plan, subscription_status, current_period_end, stripe_customer_id FROM tenants WHERE id = ?').bind(c.get('auth').tenantId).first<Record<string, unknown>>();
  return c.json({ ...t, has_customer: !!t?.stripe_customer_id, stripe_customer_id: undefined, plans: PLANS, configured: !!(c.env.STRIPE_SECRET_KEY && c.env.APP_URL) });
});

billing.post('/checkout', async (c) => {
  const key = requireStripe(c.env);
  const { plan } = await body(c, z.strictObject({ plan: z.enum(['starter', 'fleet']) }));
  const price = plan === 'starter' ? c.env.STRIPE_PRICE_STARTER : c.env.STRIPE_PRICE_FLEET;
  if (!price) throw new HTTPException(501, { message: `Set STRIPE_PRICE_${plan.toUpperCase()}` });
  const auth = c.get('auth');
  const t = await c.env.DB.prepare('SELECT stripe_customer_id FROM tenants WHERE id = ?').bind(auth.tenantId).first<{ stripe_customer_id: string | null }>();
  const form: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    client_reference_id: auth.tenantId,
    'subscription_data[metadata][tenant_id]': auth.tenantId,
    'metadata[tenant_id]': auth.tenantId,
    success_url: `${c.env.APP_URL}/billing/subscription?status=success`,
    cancel_url: `${c.env.APP_URL}/billing/subscription?status=cancelled`,
  };
  if (t?.stripe_customer_id) form.customer = t.stripe_customer_id;
  const session = await stripe<{ url: string }>(key, '/checkout/sessions', form);
  return c.json({ url: session.url });
});

billing.post('/portal', async (c) => {
  const key = requireStripe(c.env);
  const t = await c.env.DB.prepare('SELECT stripe_customer_id FROM tenants WHERE id = ?').bind(c.get('auth').tenantId).first<{ stripe_customer_id: string | null }>();
  if (!t?.stripe_customer_id) badRequest('No subscription yet');
  const session = await stripe<{ url: string }>(key, '/billing_portal/sessions', { customer: t.stripe_customer_id, return_url: `${c.env.APP_URL}/billing/subscription` });
  return c.json({ url: session.url });
});

// ---------------------------------------------------------------- webhook (public, signed)

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Verifies Stripe's `t=…,v1=…` signature (HMAC-SHA256 of "t.payload") with a 5-minute tolerance. */
export async function verifyStripeSignature(payload: string, header: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(nowSec - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  return sigs.some((s) => s.length === expected.length && [...s].reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

stripeWebhook.post('/', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) throw new HTTPException(501, { message: 'Webhook secret not configured' });
  const payload = await c.req.text();
  if (!(await verifyStripeSignature(payload, c.req.header('Stripe-Signature'), c.env.STRIPE_WEBHOOK_SECRET))) throw new HTTPException(400, { message: 'Bad signature' });
  const event = JSON.parse(payload) as { id: string; type: string; data: { object: Record<string, any> } };
  const obj = event.data.object;
  const tenantId: string | undefined = obj.client_reference_id ?? obj.metadata?.tenant_id;
  if (!tenantId || !(await c.env.DB.prepare('SELECT 1 FROM tenants WHERE id = ?').bind(tenantId).first())) return c.json({ ignored: true });
  // Apply each event once.
  const fresh = await c.env.DB.prepare('INSERT INTO stripe_events (id, tenant_id, type) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(event.id, tenantId, event.type).run();
  if (!fresh.meta.changes) return c.json({ duplicate: true });

  if (event.type === 'checkout.session.completed') {
    await c.env.DB.prepare(`UPDATE tenants SET stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = 'active' WHERE id = ?`).bind(obj.customer ?? null, obj.subscription ?? null, tenantId).run();
  } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created' || event.type === 'customer.subscription.deleted') {
    const price: string | undefined = obj.items?.data?.[0]?.price?.id;
    const plan = price && price === c.env.STRIPE_PRICE_FLEET ? 'fleet' : price && price === c.env.STRIPE_PRICE_STARTER ? 'starter' : null;
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : String(obj.status ?? 'none');
    const periodEnd = typeof obj.current_period_end === 'number' ? new Date(obj.current_period_end * 1000).toISOString() : null;
    await c.env.DB.prepare('UPDATE tenants SET subscription_status = ?, plan = COALESCE(?, plan), current_period_end = COALESCE(?, current_period_end), stripe_subscription_id = ? WHERE id = ?')
      .bind(status, plan, periodEnd, obj.id ?? null, tenantId)
      .run();
  }
  return c.json({ received: true });
});
