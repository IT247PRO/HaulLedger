-- M4: IFTA, driver qualification files (49 CFR 391.51), maintenance and DVIRs (49 CFR 396).

-- Miles by jurisdiction. Load miles carry the load; bobtail/other truck miles do not.
CREATE TABLE jurisdiction_miles (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  truck_id    TEXT NOT NULL,
  load_id     TEXT,
  traveled_on TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (length(state) = 2),
  miles       INTEGER NOT NULL CHECK (miles > 0),
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'gps')),
  note        TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, truck_id) REFERENCES trucks (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX jurisdiction_miles_by_date ON jurisdiction_miles (tenant_id, traveled_on, state);
CREATE UNIQUE INDEX jurisdiction_miles_load_state ON jurisdiction_miles (tenant_id, load_id, state) WHERE load_id IS NOT NULL;

-- Tax rates are entered (or imported) per quarter from the IFTA, Inc. rate table; never assumed.
-- rate_x10000 is dollars per gallon × 10,000 ($0.3200/gal = 3200).
CREATE TABLE ifta_tax_rates (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  quarter     TEXT NOT NULL CHECK (quarter GLOB '[0-9][0-9][0-9][0-9]-Q[1-4]'),
  state       TEXT NOT NULL CHECK (length(state) = 2),
  fuel_type   TEXT NOT NULL CHECK (fuel_type IN ('diesel', 'gasoline')),
  rate_x10000 INTEGER NOT NULL CHECK (rate_x10000 >= 0),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, quarter, state, fuel_type)
);

CREATE TABLE dqf_items (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  driver_id    TEXT NOT NULL,
  item_type    TEXT NOT NULL,
  completed_on TEXT NOT NULL,
  expires_on   TEXT,
  document_id  TEXT,
  notes        TEXT,
  recorded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);
CREATE INDEX dqf_by_driver ON dqf_items (tenant_id, driver_id, item_type, completed_on);

ALTER TABLE trucks ADD COLUMN odometer INTEGER CHECK (odometer >= 0);

CREATE TABLE pm_schedules (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  truck_id           TEXT,
  trailer_id         TEXT,
  name               TEXT NOT NULL,
  interval_miles     INTEGER CHECK (interval_miles > 0),
  interval_days      INTEGER CHECK (interval_days > 0),
  last_done_on       TEXT,
  last_done_odometer INTEGER,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, truck_id) REFERENCES trucks (tenant_id, id),
  FOREIGN KEY (tenant_id, trailer_id) REFERENCES trailers (tenant_id, id),
  CHECK ((truck_id IS NULL) <> (trailer_id IS NULL)),
  CHECK (interval_miles IS NOT NULL OR interval_days IS NOT NULL),
  CHECK (interval_miles IS NULL OR truck_id IS NOT NULL)
);

CREATE TABLE maintenance_records (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  truck_id       TEXT,
  trailer_id     TEXT,
  performed_on   TEXT NOT NULL,
  odometer       INTEGER CHECK (odometer >= 0),
  vendor         TEXT,
  description    TEXT NOT NULL,
  cost_cents     INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  pm_schedule_id TEXT,
  dvir_id        TEXT,
  document_id    TEXT,
  expense_id     TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, truck_id) REFERENCES trucks (tenant_id, id),
  FOREIGN KEY (tenant_id, trailer_id) REFERENCES trailers (tenant_id, id),
  FOREIGN KEY (tenant_id, pm_schedule_id) REFERENCES pm_schedules (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id),
  FOREIGN KEY (tenant_id, expense_id) REFERENCES expenses (tenant_id, id),
  CHECK ((truck_id IS NULL) <> (trailer_id IS NULL))
);
CREATE INDEX maintenance_by_truck ON maintenance_records (tenant_id, truck_id, performed_on);
CREATE INDEX maintenance_by_trailer ON maintenance_records (tenant_id, trailer_id, performed_on);

-- Driver vehicle inspection reports (396.11). A report with defects keeps the unit
-- out of dispatch until the carrier certifies the repair (or that none is needed).
CREATE TABLE dvirs (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  driver_id           TEXT NOT NULL,
  truck_id            TEXT NOT NULL,
  trailer_id          TEXT,
  kind                TEXT NOT NULL CHECK (kind IN ('pre_trip', 'post_trip')),
  inspected_at        TEXT NOT NULL,
  odometer            INTEGER CHECK (odometer >= 0),
  location            TEXT,
  remarks             TEXT,
  signature_name      TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('satisfactory', 'defects_open', 'repaired', 'no_repair_needed')),
  certified_by        TEXT,
  certified_name      TEXT,
  certified_at        TEXT,
  certification_notes TEXT,
  reviewed_by_driver  TEXT,
  reviewed_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, truck_id) REFERENCES trucks (tenant_id, id),
  FOREIGN KEY (tenant_id, trailer_id) REFERENCES trailers (tenant_id, id)
);
CREATE INDEX dvirs_by_truck ON dvirs (tenant_id, truck_id, inspected_at);
CREATE INDEX dvirs_open ON dvirs (tenant_id, status);

CREATE TABLE dvir_defects (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  dvir_id        TEXT NOT NULL,
  unit           TEXT NOT NULL CHECK (unit IN ('truck', 'trailer')),
  component      TEXT NOT NULL,
  description    TEXT NOT NULL,
  out_of_service INTEGER NOT NULL DEFAULT 0 CHECK (out_of_service IN (0, 1)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, dvir_id) REFERENCES dvirs (tenant_id, id) ON DELETE CASCADE
);
