export type Role = 'owner' | 'dispatcher' | 'driver';

export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
  // Optional integrations. Each feature that needs one fails with 501 when it is unset.
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
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
