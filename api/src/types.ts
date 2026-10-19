export type Role = 'owner' | 'dispatcher' | 'driver';

export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  // Optional integrations. Each feature that needs one fails with 501 when it is unset.
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** 32 random bytes, base64: encrypts per-carrier integration credentials. */
  INTEGRATIONS_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_FLEET?: string;
  /** Public URL of the web app, for Stripe redirects. */
  APP_URL?: string;
}

/** The authenticated principal. tenantId comes from the session, never from the request. */
export interface Auth {
  userId: string;
  tenantId: string;
  role: Role;
  driverId: string | null;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { auth: Auth };
};
