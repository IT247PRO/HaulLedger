# HaulLedger

Trucking back office for small carriers (1–50 trucks) and owner-operators. The wedge is
**driver-verifiable settlements tied to per-truck P&L**. See [`Claude instruction.md`](./Claude%20instruction.md)
for the full product brief.

## Status

| Milestone | Scope | State |
| --- | --- | --- |
| M1 | Auth, multi-tenancy, drivers / equipment / customers / loads, tenant-isolation + RBAC tests | Done |
| M2 | Settlements with per-load math, driver portal, R2 document upload | Done |
| M3 | Invoicing, expenses, per-truck and per-load P&L, fuel-card CSV import | Done |
| M4 | IFTA, DOT driver qualification files, maintenance and DVIRs | Done |
| M5 | Load board booking, Traccar GPS, ELD/HOS (Samsara, Motive), factoring, broker CRM, rate calculator, Stripe billing | Done, see [integration status](#integration-status) |

`pnpm test` runs 170 tests inside workerd against real D1.

## Stack

- **API:** Hono on Cloudflare Workers (`api/`)
- **DB:** Cloudflare D1, a single database. Every table has a `NOT NULL tenant_id`. One migration chain in `migrations/`
- **Web:** React + Vite + TypeScript + Tailwind (`web/`)
- **Files:** Cloudflare R2 (`DOCS`), with tenant-prefixed keys
- **Tests:** Vitest with `@cloudflare/vitest-plugin`
- **Package manager:** pnpm workspaces

## Getting started

```sh
pnpm install
cp api/.dev.vars.example api/.dev.vars   # set INTEGRATIONS_KEY (command in the file)
pnpm db:migrate:local
pnpm db:seed:local         # demo carrier: 3 trucks, 5 drivers, ~1 month of loads, fuel, invoices, DQ files
pnpm dev:api               # Worker on :8787
pnpm dev:web               # Vite on :5173 (proxies /api)
```

Demo logins (password `demo-password-123`):

| Login | Role |
| --- | --- |
| `owner@demo.haulledger.test` | Owner |
| `dispatch@demo.haulledger.test` | Dispatcher |
| `marcus@demo.haulledger.test` (also `angela@`, `dwayne@`, `priya@`, `cody@`) | Driver |

The seed creates no paperwork files. To demo the wedge, use the full flow:

1. As the owner, dispatch a load to Marcus.
2. As Marcus, on a phone, advance the load and photograph the POD.
3. As the owner, run his settlement.

Alternatively, untick "Only pay loads with a POD" when you generate a settlement.

Checks: `pnpm typecheck`, `pnpm test`, `pnpm --filter @haulledger/web build`.

### Deploying

```sh
wrangler d1 create haulledger              # put the id into api/wrangler.jsonc
wrangler r2 bucket create haulledger-docs
pnpm --filter @haulledger/api db:migrate:remote
wrangler secret put INTEGRATIONS_KEY       # plus any optional secrets below
pnpm --filter @haulledger/api deploy
```

| Secret | Needed for | When unset |
| --- | --- | --- |
| `INTEGRATIONS_KEY` | Encrypting each carrier's GPS/ELD credentials (AES-GCM, bound to tenant + provider) | Connecting an integration returns 501 |
| `RESEND_API_KEY`, `EMAIL_FROM` | Emailing settlements to drivers, factoring packets | 501 "Email is not configured" |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_FLEET`, `APP_URL` | Subscriptions | 501 "Billing is not configured" |

Every optional feature fails with a clear 501 when unconfigured. Nothing invents data.

## How tenancy is enforced

1. **The session decides the tenant.** No route reads a tenant from the request. Bodies are strict, so a stray `tenant_id` is rejected.
2. **Every query binds `tenant_id`.** Another carrier's record looks exactly like a missing one (404).
3. **The database backs it up.** Child tables reference parents through composite `(tenant_id, id)` foreign
   keys, so D1 refuses cross-tenant references even if a route has a bug.
4. **Files and secrets too.** R2 keys are prefixed with the tenant. Integration secrets are encrypted with the
   tenant and provider as AAD, so a row copied into another tenant will not decrypt.
5. **Tests prove it.** Every module has cross-tenant tests, and a schema test checks that every table has a `NOT NULL tenant_id`.
   I injected leaks on purpose and confirmed the tests fail.

## Roles (server-side)

| | Owner | Dispatcher | Driver |
| --- | --- | --- | --- |
| Loads, dispatch, documents, billing, fuel, expenses, IFTA, DQ files, maintenance | ✓ | ✓ | own loads (no revenue), own documents |
| Pay rates, settlements, advances, deductions, escrow | ✓ | ✗ | own settlements (once finalized), own rates and escrow |
| W-2 vs 1099 pay track, hiring drivers, team logins, integrations, subscription, IFTA tax rates | ✓ | ✗ | ✗ |
| P&L, AR aging, rate calculator | ✓ | ✗ | ✗ |
| DVIRs | certify | certify | file own; review the last report |

## The wedge: settlements a driver can verify

- **Mixed pay per driver:** per mile (loaded or all miles), percentage of gross, per stop (every stop or extra stops only), hourly, and per diem (W-2 only). Rates of different kinds combine. Rates of the same kind can't overlap in time, and rates are ended rather than edited.
- **Every line cites its source.** Each line traces to a load plus pay rate, an advance, a charge, a reimbursement or an escrow transaction. Recurring deductions are saved as charge records first. Schema CHECKs reject a line with no source, and unique indexes stop anything being paid twice.
- **Percentage lines store the load gross, the percentage and the amount.** Percentage-paid drivers see the rated freight bill and can open the rate confirmation (Truth-in-Leasing, 49 CFR 376.12(g)).
- **Two separate pay tracks.** Deduction categories are specific to each track. W-2 has no escrow and no lease charges. 1099 has no garnishments and no per diem. A driver's pay track can't change while a draft settlement is open.
- **Escrow** keeps a running-balance ledger: holds toward a target, interest, and releases paid out on the next settlement.
- **Lifecycle:** draft, then finalize (published to the driver), then paid. A negative net carries forward as a charge that cites the earlier settlement. By default, loads without a POD are held off the settlement.

## Domain notes

- **Money is integer cents.** Pay rates use millicents or basis points, fuel uses thousandths of a gallon, and IFTA rates use dollars ×10,000. The web app parses decimals as digits, never with floats.
- **Fuel import (EFS / WEX / Comdata CSV).** Header names are matched against known aliases. If a column can't be matched, you map it explicitly. Re-importing the same file adds nothing. Rows are matched by card, then unit, then driver name, then to the load on the road at that time. An optional charge-back turns fuel into deductions for 1099 contractors and card cash into advances.
- **P&L per truck and per load.** It reports actual settled pay separately from pay estimated from rates. Fuel is shown net of charge-backs, and repair costs post as expenses automatically.
- **IFTA.** Fleet MPG is rounded to two decimals, as on the return. Taxable gallons come from jurisdiction miles divided by MPG, net of tax-paid gallons (credits included). Tax is computed only where you've entered that quarter's rate from the IFTA, Inc. matrix. A missing rate makes the report incomplete instead of guessing. Before filing, the report flags loads whose state miles don't add up, fuel not tied to a truck, and trucks with miles but no fuel.
- **DQ files (391.51).** Each requirement carries its citation, with Part 382 Clearinghouse queries alongside. Items show as missing, expired, expiring or not yet due. Recording a medical certificate updates the driver's medical card date.
- **DVIR (396.11).** An open defect blocks dispatch of that truck or trailer until the carrier certifies the repair. The next driver reviews the last report.

## Integration status

| Integration | What works | Notes |
| --- | --- | --- |
| **Traccar GPS** | Live truck positions via its REST API (`/api/positions`, `/api/devices`), token or basic auth | Sidecar only: not forked, no device protocols. Map each truck to its Traccar device id. |
| **Samsara ELD** | HOS clocks (`/fleet/hos/clocks`), cursor-paginated | We never build an ELD; we read the vendor's clocks. Map drivers by ELD id. |
| **Motive ELD** | HOS available time (`/v1/available_time`) | The response mapping is isolated in `mapMotive`. Verify it against a live Motive account before relying on it. |
| EZLOGZ | — | Not implemented: no public API reference was available. |
| **DAT / Truckstop** | **Booking** a load you found on the board: the broker is matched by MC (or added), the load is created, then you attach the rate con | **Search is not connected.** Both APIs need partner agreements, so search returns 501 and says so. |
| **Factoring (RTS, Triumph, any factor)** | One-click submission of the invoice plus rate con, BOL and POD to the factor's schedule inbox. Records funding, settles the invoice and books the fee. | Email-based, which is how these factors take schedules. A POD is required. |
| **Stripe** | Flat Starter $79 / Fleet $129 per carrier, quantity 1, Checkout and Billing Portal, signed and idempotent webhooks | Never per user, never per load. The app doesn't restrict access by subscription status yet. |

Vendor calls are unit-tested against mocked responses. They have not been run against live Traccar, Samsara, Motive, Stripe or Resend accounts.

## Not built yet

- **GPS-derived IFTA miles.** Splitting a Traccar route into states needs state boundary data; today state miles are entered per load.
- **Canadian jurisdictions** (litres and kilometres) in IFTA.
- **Payroll tax.** W-2 settlements are gross earnings statements, and withholding belongs to the payroll provider.
- **Login rate limiting and CSRF tokens.** Cookies are `SameSite=Lax` and mutations are JSON-only.
