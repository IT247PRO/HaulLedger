-- M3: customer invoicing, expenses, fuel-card import, P&L inputs.
-- Fuel volumes are integer thousandths of a gallon (gallons_milli).

CREATE TABLE invoices (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  invoice_number TEXT NOT NULL,
  customer_id    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'void')),
  issued_on      TEXT NOT NULL,
  terms_days     INTEGER NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 180),
  due_on         TEXT NOT NULL,
  total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
  paid_cents     INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  paid_on        TEXT,
  sent_at        TEXT,
  notes          TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, invoice_number),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
CREATE INDEX invoices_by_customer ON invoices (tenant_id, customer_id, status);

CREATE TABLE invoice_lines (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  invoice_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  load_id      TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('linehaul', 'fuel_surcharge', 'accessorial', 'other')),
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id)
);
CREATE INDEX invoice_lines_by_load ON invoice_lines (tenant_id, load_id);

CREATE TABLE invoice_payments (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  invoice_id   TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on  TEXT NOT NULL,
  method       TEXT NOT NULL DEFAULT 'ach' CHECK (method IN ('ach', 'check', 'wire', 'card', 'factor', 'other')),
  reference    TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

CREATE TABLE fuel_cards (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  provider   TEXT NOT NULL CHECK (provider IN ('efs', 'wex', 'comdata', 'other')),
  -- Last digits as printed on the statement; enough to match without storing the full PAN.
  card_last4 TEXT NOT NULL,
  driver_id  TEXT,
  truck_id   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, card_last4),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, truck_id) REFERENCES trucks (tenant_id, id)
);

CREATE TABLE fuel_imports (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  provider        TEXT NOT NULL,
  filename        TEXT NOT NULL,
  row_count       INTEGER NOT NULL,
  imported_count  INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  unmatched_count INTEGER NOT NULL,
  error_count     INTEGER NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id)
);

CREATE TABLE fuel_transactions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  import_id     TEXT,
  provider      TEXT NOT NULL CHECK (provider IN ('efs', 'wex', 'comdata', 'other', 'manual')),
  -- Provider transaction id, or a hash of the row when the file has none. Re-importing a file never duplicates.
  external_id   TEXT NOT NULL,
  transacted_at TEXT NOT NULL,
  card_last4    TEXT,
  raw_unit      TEXT,
  raw_driver    TEXT,
  truck_id      TEXT,
  driver_id     TEXT,
  load_id       TEXT,
  merchant      TEXT,
  city          TEXT,
  state         TEXT,
  product       TEXT NOT NULL CHECK (product IN ('diesel', 'gasoline', 'def', 'reefer', 'cash_advance', 'other')),
  gallons_milli INTEGER NOT NULL DEFAULT 0 CHECK (gallons_milli >= 0),
  amount_cents  INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider, external_id),
  FOREIGN KEY (tenant_id, import_id) REFERENCES fuel_imports (tenant_id, id),
  FOREIGN KEY (tenant_id, truck_id) REFERENCES trucks (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id)
);
CREATE INDEX fuel_by_truck ON fuel_transactions (tenant_id, truck_id, transacted_at);
CREATE INDEX fuel_by_load ON fuel_transactions (tenant_id, load_id);
CREATE INDEX fuel_by_state ON fuel_transactions (tenant_id, state, transacted_at);

CREATE TABLE expenses (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  category     TEXT NOT NULL CHECK (category IN (
                 'maintenance', 'tires', 'tolls', 'insurance', 'truck_payment', 'trailer_payment', 'permits_licenses',
                 'parking', 'lumper', 'factoring_fees', 'office', 'software', 'other')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  incurred_on  TEXT NOT NULL,
  vendor       TEXT,
  description  TEXT NOT NULL,
  truck_id     TEXT,
  trailer_id   TEXT,
  load_id      TEXT,
  document_id  TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, truck_id) REFERENCES trucks (tenant_id, id),
  FOREIGN KEY (tenant_id, trailer_id) REFERENCES trailers (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);
CREATE INDEX expenses_by_truck ON expenses (tenant_id, truck_id, incurred_on);
CREATE INDEX expenses_by_load ON expenses (tenant_id, load_id);

-- Fuel-card cash advances recovered on settlements cite the card transaction.
ALTER TABLE driver_advances ADD COLUMN fuel_transaction_id TEXT;
