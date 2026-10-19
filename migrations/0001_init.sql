-- M1: tenants, auth, drivers, equipment, customers, loads.
--
-- Multi-tenancy: one D1 database, every row carries tenant_id. Child tables
-- reference parents through composite (tenant_id, id) foreign keys, so the
-- database itself refuses a load that points at another tenant's driver,
-- truck, trailer or customer.
--
-- Money is integer cents. Dates are 'YYYY-MM-DD'; timestamps are ISO-8601 UTC.

CREATE TABLE tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE drivers (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  first_name         TEXT NOT NULL,
  last_name          TEXT NOT NULL,
  email              TEXT,
  phone              TEXT,
  -- W-2 company driver vs 1099 contractor / owner-operator. Never blurred.
  pay_track          TEXT NOT NULL CHECK (pay_track IN ('w2', '1099')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  license_number     TEXT,
  license_state      TEXT,
  license_class      TEXT,
  license_expires_on TEXT,
  medical_expires_on TEXT,
  hired_on           TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id)
);
CREATE INDEX drivers_by_tenant ON drivers (tenant_id, last_name, first_name);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner', 'dispatcher', 'driver')),
  -- A driver login is bound to exactly one driver record in the same tenant.
  driver_id     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  CHECK ((role = 'driver') = (driver_id IS NOT NULL))
);
CREATE INDEX users_by_tenant ON users (tenant_id);
CREATE UNIQUE INDEX users_one_login_per_driver ON users (tenant_id, driver_id) WHERE driver_id IS NOT NULL;

CREATE TABLE sessions (
  -- SHA-256 of the bearer token; the token itself is never stored.
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX sessions_by_user ON sessions (tenant_id, user_id);

CREATE TABLE trucks (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  unit_number TEXT NOT NULL,
  vin         TEXT,
  make        TEXT,
  model       TEXT,
  year        INTEGER,
  plate       TEXT,
  plate_state TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'shop', 'inactive')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, unit_number)
);

CREATE TABLE trailers (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  unit_number  TEXT NOT NULL,
  trailer_type TEXT NOT NULL DEFAULT 'dry_van'
               CHECK (trailer_type IN ('dry_van', 'reefer', 'flatbed', 'step_deck', 'tanker', 'other')),
  vin          TEXT,
  plate        TEXT,
  plate_state  TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'shop', 'inactive')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, unit_number)
);

CREATE TABLE customers (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'broker' CHECK (kind IN ('broker', 'shipper')),
  mc_number       TEXT,
  email           TEXT,
  phone           TEXT,
  billing_address TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id)
);
CREATE INDEX customers_by_tenant ON customers (tenant_id, name);

CREATE TABLE loads (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  load_number      TEXT NOT NULL,
  reference_number TEXT,
  customer_id      TEXT,
  driver_id        TEXT,
  truck_id         TEXT,
  trailer_id       TEXT,
  status           TEXT NOT NULL DEFAULT 'planned'
                   CHECK (status IN ('planned', 'dispatched', 'at_pickup', 'in_transit', 'delivered', 'cancelled')),
  -- Linehaul revenue from the rate confirmation, in cents.
  rate_cents       INTEGER NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),
  loaded_miles     INTEGER CHECK (loaded_miles >= 0),
  empty_miles      INTEGER CHECK (empty_miles >= 0),
  commodity        TEXT,
  weight_lbs       INTEGER CHECK (weight_lbs >= 0),
  notes            TEXT,
  dispatched_at    TEXT,
  delivered_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, load_number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id)   REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, truck_id)    REFERENCES trucks (tenant_id, id),
  FOREIGN KEY (tenant_id, trailer_id)  REFERENCES trailers (tenant_id, id)
);
CREATE INDEX loads_by_tenant_status ON loads (tenant_id, status, created_at);
CREATE INDEX loads_by_driver ON loads (tenant_id, driver_id);
CREATE INDEX loads_by_truck ON loads (tenant_id, truck_id);

CREATE TABLE load_stops (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  load_id         TEXT NOT NULL,
  seq             INTEGER NOT NULL CHECK (seq >= 1),
  kind            TEXT NOT NULL CHECK (kind IN ('pickup', 'delivery')),
  facility_name   TEXT,
  address         TEXT,
  city            TEXT NOT NULL,
  state           TEXT NOT NULL,
  postal_code     TEXT,
  scheduled_start TEXT,
  scheduled_end   TEXT,
  arrived_at      TEXT,
  departed_at     TEXT,
  UNIQUE (tenant_id, id),
  UNIQUE (load_id, seq),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX load_stops_by_load ON load_stops (tenant_id, load_id, seq);

-- Status history: who moved a load, when. Settlements trace back to this.
CREATE TABLE load_events (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  load_id     TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  -- Kept as plain history (no FK) so removing a user never rewrites the log.
  user_id     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX load_events_by_load ON load_events (tenant_id, load_id, created_at);
