-- M5: integrations (Traccar GPS, ELD vendors, load boards), factoring, broker CRM,
-- rate calculator settings, and Stripe subscription state.

-- Per-carrier integration credentials. The secret is AES-GCM encrypted with the
-- platform key (wrangler secret INTEGRATIONS_KEY); only non-secret config is stored in clear.
CREATE TABLE tenant_integrations (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  provider   TEXT NOT NULL CHECK (provider IN ('traccar', 'samsara', 'motive', 'dat', 'truckstop')),
  config     TEXT NOT NULL DEFAULT '{}',
  secret_iv  TEXT,
  secret_ct  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider)
);

ALTER TABLE trucks ADD COLUMN traccar_device_id TEXT;
ALTER TABLE drivers ADD COLUMN eld_driver_id TEXT;

CREATE TABLE factoring_companies (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  name             TEXT NOT NULL,
  submission_email TEXT NOT NULL,
  fee_bp           INTEGER NOT NULL DEFAULT 0 CHECK (fee_bp BETWEEN 0 AND 2000),
  recourse         INTEGER NOT NULL DEFAULT 0 CHECK (recourse IN (0, 1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id)
);

CREATE TABLE factoring_submissions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  invoice_id    TEXT NOT NULL,
  factor_id     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'funded', 'rejected')),
  submitted_at  TEXT NOT NULL,
  funded_on     TEXT,
  fee_cents     INTEGER CHECK (fee_cents >= 0),
  funded_cents  INTEGER CHECK (funded_cents >= 0),
  reference     TEXT,
  notes         TEXT,
  created_by    TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, factor_id) REFERENCES factoring_companies (tenant_id, id)
);
CREATE UNIQUE INDEX factoring_one_live_per_invoice ON factoring_submissions (tenant_id, invoice_id) WHERE status <> 'rejected';

CREATE TABLE customer_contacts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT,
  email       TEXT,
  phone       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE customer_notes (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE CASCADE
);

-- Flat per-carrier subscription. Never per user, never per load.
ALTER TABLE tenants ADD COLUMN plan TEXT CHECK (plan IN ('starter', 'fleet'));
ALTER TABLE tenants ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE tenants ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE tenants ADD COLUMN current_period_end TEXT;

-- Webhook idempotency: each Stripe event is applied once.
CREATE TABLE stripe_events (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  type       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
