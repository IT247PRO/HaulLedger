export type Role = 'owner' | 'dispatcher' | 'driver';

export interface Env {
  DB: D1Database;
  DOCS: R2Bucket;
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
