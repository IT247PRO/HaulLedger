-- M2: documents (R2), driver pay rates, settlements and every source a
-- settlement line can cite: advances, charges (deductions), reimbursements,
-- recurring deductions, escrow.
--
-- Units: money is integer cents. Pay-rate units depend on kind:
--   per_mile  -> millicents per mile (1/1000 cent; $0.625/mi = 62500)
--   percent   -> basis points of load gross (25.00% = 2500)
--   per_stop  -> cents per stop
--   hourly    -> cents per hour (load hours are stored in hundredths)
--   per_diem  -> cents per day (W-2 only)

ALTER TABLE loads ADD COLUMN fuel_surcharge_cents INTEGER NOT NULL DEFAULT 0 CHECK (fuel_surcharge_cents >= 0);
ALTER TABLE loads ADD COLUMN accessorial_cents INTEGER NOT NULL DEFAULT 0 CHECK (accessorial_cents >= 0);
-- Hours worked on the load, in hundredths (8.5 h = 850). Used by hourly pay.
ALTER TABLE loads ADD COLUMN pay_hours_x100 INTEGER CHECK (pay_hours_x100 >= 0);
ALTER TABLE loads ADD COLUMN pod_received_at TEXT;

-- Truth-in-Leasing escrow terms for 1099 contractors (49 CFR 376.12(k)).
ALTER TABLE drivers ADD COLUMN escrow_target_cents INTEGER NOT NULL DEFAULT 0 CHECK (escrow_target_cents >= 0);
ALTER TABLE drivers ADD COLUMN escrow_per_settlement_cents INTEGER NOT NULL DEFAULT 0 CHECK (escrow_per_settlement_cents >= 0);

CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  kind         TEXT NOT NULL CHECK (kind IN (
                 'bol', 'pod', 'rate_confirmation', 'receipt', 'lumper', 'scale', 'invoice',
                 'dqf', 'dvir', 'repair', 'other')),
  load_id      TEXT,
  driver_id    TEXT,
  truck_id     TEXT,
  r2_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
  uploaded_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id)   REFERENCES loads (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, truck_id)  REFERENCES trucks (tenant_id, id)
);
CREATE INDEX documents_by_load ON documents (tenant_id, load_id);
CREATE INDEX documents_by_driver ON documents (tenant_id, driver_id);

CREATE TABLE driver_pay_rates (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  driver_id      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('per_mile', 'percent', 'per_stop', 'hourly', 'per_diem')),
  rate           INTEGER NOT NULL CHECK (rate >= 0),
  -- per_mile: 'loaded' or 'all' (loaded + empty). per_stop: 'all' or 'extra' (beyond first pickup and final delivery).
  basis          TEXT CHECK (basis IN ('loaded', 'all', 'extra')),
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  CHECK (kind <> 'percent' OR rate <= 10000),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX pay_rates_by_driver ON driver_pay_rates (tenant_id, driver_id, effective_from);

CREATE TABLE settlements (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  settlement_number   TEXT NOT NULL,
  driver_id           TEXT NOT NULL,
  -- Copied from the driver at creation: a settlement never changes track.
  pay_track           TEXT NOT NULL CHECK (pay_track IN ('w2', '1099')),
  period_start        TEXT NOT NULL,
  period_end          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'paid')),
  load_pay_cents      INTEGER NOT NULL DEFAULT 0,
  per_diem_cents      INTEGER NOT NULL DEFAULT 0,
  reimbursement_cents INTEGER NOT NULL DEFAULT 0,
  advance_cents       INTEGER NOT NULL DEFAULT 0,
  deduction_cents     INTEGER NOT NULL DEFAULT 0,
  escrow_cents        INTEGER NOT NULL DEFAULT 0,
  net_cents           INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT NOT NULL,
  finalized_at        TEXT,
  paid_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, settlement_number),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  CHECK (period_end >= period_start)
);
CREATE INDEX settlements_by_driver ON settlements (tenant_id, driver_id, period_end);

CREATE TABLE driver_advances (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  driver_id   TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  issued_on   TEXT NOT NULL,
  method      TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'comchek', 'efs_check', 'fuel_card', 'ach', 'other')),
  reference   TEXT,
  memo        TEXT,
  load_id     TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id)   REFERENCES loads (tenant_id, id)
);

CREATE TABLE recurring_deductions (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  driver_id    TEXT NOT NULL,
  category     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  description  TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id)
);

-- A charge against a driver's pay. Categories are validated per pay track in code.
CREATE TABLE driver_charges (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(id),
  driver_id              TEXT NOT NULL,
  category               TEXT NOT NULL,
  amount_cents           INTEGER NOT NULL CHECK (amount_cents > 0),
  incurred_on            TEXT NOT NULL,
  description            TEXT NOT NULL,
  load_id                TEXT,
  document_id            TEXT,
  fuel_transaction_id    TEXT,
  recurring_deduction_id TEXT,
  -- Set when a settlement generated this charge (recurring item or deficit carry-forward).
  origin_settlement_id   TEXT,
  created_by             TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id),
  FOREIGN KEY (tenant_id, recurring_deduction_id) REFERENCES recurring_deductions (tenant_id, id)
);
CREATE INDEX driver_charges_by_driver ON driver_charges (tenant_id, driver_id, incurred_on);

CREATE TABLE driver_reimbursements (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  driver_id    TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('lumper', 'scale', 'tolls', 'parking', 'repair', 'fuel', 'other')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  incurred_on  TEXT NOT NULL,
  description  TEXT NOT NULL,
  load_id      TEXT,
  document_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  FOREIGN KEY (tenant_id, load_id) REFERENCES loads (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);

-- Escrow ledger. amount_cents is signed: + raises the balance (hold, interest), - lowers it (release, withdrawal).
-- settlement_id is plain (no FK): holds belong to the settlement that took them;
-- releases are claimed by the settlement that pays them out.
CREATE TABLE escrow_transactions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  driver_id     TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('hold', 'release', 'interest', 'withdrawal')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents <> 0),
  occurred_on   TEXT NOT NULL,
  memo          TEXT,
  settlement_id TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, driver_id) REFERENCES drivers (tenant_id, id),
  CHECK ((kind IN ('hold', 'interest') AND amount_cents > 0) OR (kind IN ('release', 'withdrawal') AND amount_cents < 0))
);
CREATE INDEX escrow_by_driver ON escrow_transactions (tenant_id, driver_id, occurred_on);

-- Every line cites exactly the record that explains it. amount_cents is signed
-- from the driver's view: + pays the driver, - reduces pay.
CREATE TABLE settlement_lines (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  settlement_id    TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'load_pay', 'per_diem', 'reimbursement', 'advance', 'deduction', 'escrow_hold', 'escrow_release')),
  description      TEXT NOT NULL,
  load_id          TEXT,
  pay_rate_id      TEXT,
  pay_kind         TEXT CHECK (pay_kind IN ('per_mile', 'percent', 'per_stop', 'hourly', 'per_diem')),
  quantity         INTEGER,
  quantity_unit    TEXT CHECK (quantity_unit IN ('miles', 'stops', 'hours_x100', 'days', 'cents')),
  unit_rate        INTEGER,
  gross_cents      INTEGER,
  rate_bp          INTEGER,
  amount_cents     INTEGER NOT NULL,
  advance_id       TEXT,
  charge_id        TEXT,
  reimbursement_id TEXT,
  escrow_tx_id     TEXT,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, settlement_id)    REFERENCES settlements (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, load_id)          REFERENCES loads (tenant_id, id),
  FOREIGN KEY (tenant_id, pay_rate_id)      REFERENCES driver_pay_rates (tenant_id, id),
  FOREIGN KEY (tenant_id, advance_id)       REFERENCES driver_advances (tenant_id, id),
  FOREIGN KEY (tenant_id, charge_id)        REFERENCES driver_charges (tenant_id, id),
  FOREIGN KEY (tenant_id, reimbursement_id) REFERENCES driver_reimbursements (tenant_id, id),
  FOREIGN KEY (tenant_id, escrow_tx_id)     REFERENCES escrow_transactions (tenant_id, id),
  -- "A settlement with an unexplained line is a bug": the schema refuses one.
  CHECK (kind NOT IN ('load_pay', 'per_diem') OR (load_id IS NOT NULL AND pay_rate_id IS NOT NULL AND quantity IS NOT NULL)),
  CHECK (pay_kind <> 'percent' OR (gross_cents IS NOT NULL AND rate_bp IS NOT NULL)),
  CHECK (kind <> 'advance' OR advance_id IS NOT NULL),
  CHECK (kind <> 'deduction' OR charge_id IS NOT NULL),
  CHECK (kind <> 'reimbursement' OR reimbursement_id IS NOT NULL),
  CHECK (kind NOT IN ('escrow_hold', 'escrow_release') OR escrow_tx_id IS NOT NULL)
);
CREATE INDEX settlement_lines_by_settlement ON settlement_lines (tenant_id, settlement_id, seq);
-- A load is paid once per pay rate; each source record is settled once.
CREATE UNIQUE INDEX settlement_lines_load_once ON settlement_lines (tenant_id, load_id, pay_rate_id) WHERE load_id IS NOT NULL AND pay_rate_id IS NOT NULL;
CREATE UNIQUE INDEX settlement_lines_advance_once ON settlement_lines (tenant_id, advance_id) WHERE advance_id IS NOT NULL;
CREATE UNIQUE INDEX settlement_lines_charge_once ON settlement_lines (tenant_id, charge_id) WHERE charge_id IS NOT NULL;
CREATE UNIQUE INDEX settlement_lines_reimb_once ON settlement_lines (tenant_id, reimbursement_id) WHERE reimbursement_id IS NOT NULL;
CREATE UNIQUE INDEX settlement_lines_escrow_once ON settlement_lines (tenant_id, escrow_tx_id) WHERE escrow_tx_id IS NOT NULL;
