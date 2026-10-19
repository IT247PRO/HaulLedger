# Claude Instruction — HaulLedger (Trucking Business Management System)

You are building **HaulLedger**, a multi-tenant SaaS for small trucking carriers (1–50 trucks) and owner-operators. The buyer is a non-tech small business owner — the carrier owner who today settles drivers in spreadsheets.

## The wedge (build this first)

**Driver-verifiable settlements tied to per-truck P&L.** Pay disputes from opaque settlements are the #1 driver complaint industry-wide, and replacing one driver costs ~$5,000–8,000. Every small-carrier competitor does settlements weakly. Your settlement sheet must let a driver verify every line: each pay line links to the load, the rate confirmation, and the miles behind it. Advances, deductions, reimbursements, and escrow balances are itemized — never lumped into "miscellaneous."

## Stack (non-negotiable)

- **API:** Node.js, Hono framework, running on **Cloudflare Workers**
- **Database:** Cloudflare D1 (SQLite). Multi-tenancy = single D1 database with `tenant_id` scoping on every table. Never a database per tenant.
- **Frontend:** React (Vite + TypeScript + Tailwind). **No PHP anywhere** — not in the app, not in tooling you add.
- **File storage:** Cloudflare R2 (documents, BOL/POD photos).
- **Migrations:** one Wrangler D1 migration chain. Secrets via `wrangler secret`.

## Architecture

- Monorepo: `api/` (Hono + Workers), `web/` (React), `migrations/` (D1 SQL).
- Every API route enforces `tenant_id` from the authenticated session. Write a test that proves cross-tenant reads are impossible.
- Roles: **Owner** (everything, incl. pay rates and settings), **Dispatcher** (dispatch, documents, no pay-rate changes, no settings), **Driver** (own loads, own settlements, own documents only — never sees other drivers' pay or company P&L). Enforce server-side.

## Domain rules (enforce in code, not just UI)

1. **Two strictly separate pay tracks.** W-2 company drivers (payroll-style: benefits, per-diem, garnishments) and 1099 contractors/owner-operators (settlements, no withholding, maintenance escrow with running balance, year-end 1099-NEC/MISC). Never blur them; misclassification is heavily litigated.
2. **Settlement math is per-load.** Support per-mile, percentage-of-revenue, per-stop, and hourly pay — mixed freely per driver. For percentage pay, store the load gross, the percentage, and the computed amount on every line.
3. **Truth-in-Leasing (49 CFR 376.12):** percentage-paid drivers must be shown the rated freight bill (or equivalent) at settlement. Build this into the settlement view — it is a compliance feature.
4. **Money is integers.** Store all currency as integer cents. No float math on money, ever.
5. **Every deduction has a source.** Fuel-card purchase, cash advance, insurance charge, escrow hold — each deduction links to its source record. A settlement with an unexplained line is a bug.

## Build phases

### Phase 1 — the wedge (ship this before anything else)
1. **Driver management** — profiles, license/medical expirations with alerts.
2. **Dispatch / load management** — create loads, assign driver + truck + trailer, status pickup → delivery.
3. **Document capture** — BOL, POD, rate confirmation upload (R2), driver mobile photo upload. Cash flow depends on PODs reaching billing fast.
4. **Driver settlements** — the wedge. Per-load pay lines, advances, deductions, reimbursements, escrow, printable/emailable settlement sheet. Driver portal shows own settlements only.
5. **Bookkeeping core** — customer invoicing, expense capture, P&L per truck and per load.
6. **Fuel-card import** — CSV import for EFS/WEX/Comdata, matched to trips.

**Phase 1 acceptance:** an owner can dispatch a load, the driver uploads the POD from a phone, and the settlement sheet shows every dollar traced to its load — demoable in one screenshot.

### Phase 2 — compliance (the second sale)
7. **IFTA reporting** — quarterly miles-per-jurisdiction + gallons-per-jurisdiction from mileage + fuel data. This is the quarterly scramble every carrier dreads; accuracy is the feature (a competitor churns on this).
8. **DOT driver qualification files** — audit-ready DQF per 49 CFR 391.51: application, MVRs, road test, medical cert, annual reviews.
9. **Maintenance / DVIR** — preventive-maintenance schedules, driver vehicle inspection reports, repair history per unit.

### Phase 3 — network effects
10. **Load boards** — DAT / Truckstop search + one-click rate-con import.
11. **GPS tracking** — integrate **Traccar** (Apache 2.0) via its REST API as a sidecar. Do NOT fork it, do NOT rewrite device protocols.
12. **ELD / HOS** — integrate a certified ELD vendor's API (Samsara, Motive, or EZLOGZ). **Never build an ELD** — FMCSA certification requires registration, hardware, and test procedures; no open-source certified ELD exists.
13. **Factoring integration** — one-click invoice submission to factors (RTS, Triumph).
14. **Broker/shipper CRM** — contacts with lane + rate history.
15. **Rate calculator** — true all-in cost per mile (fuel, pay, insurance, maintenance reserve, fixed) vs. offered rate.

## Reference material (do not ship their code)

- **Warp Tools** (github.com/wearewarp/warp-tools, MIT, TypeScript): the closest domain match — dispatch kanban, settlement math, IFTA calculator, rate-con PDF generator. **Port its schemas and freight workflows into Hono/D1; do not fork-and-ship it** (5 stars, no multi-tenant hardening).
- **Open TMS** (MIT): reference only for shipment/EDI modeling ideas. Wrong segment (shipper/broker).
- **Odoo fleet**: do NOT touch — AGPL-3.0 and wrong domain.

## Billing

- Flat **$79–129/mo per carrier**, unlimited users. Never per-user, never per-load metering.
- Stripe for subscriptions. No revenue-share on the carrier's freight.

## Testing

- Vitest for API logic. Every money calculation gets a unit test (settlement totals, escrow balances, per-load splits).
- Multi-tenant isolation test: tenant A can never read tenant B's loads, settlements, or P&L.
- RBAC test: driver role cannot access pay rates or other drivers' settlements.
- Seed script with a demo carrier (3 trucks, 5 drivers, 1 month of loads) so the wedge is demoable immediately.

## What NOT to build

- An ELD. A GPS device-protocol stack (use Traccar's API). Per-user pricing. Anything in PHP. A fork of Warp Tools. Fake AI features — if a feature needs AI later, it must fail cleanly when unconfigured, never invent data.

## Milestones

1. **M1:** Auth + multi-tenancy + driver/dispatch/load CRUD with tenant isolation tests green.
2. **M2 (the wedge):** Settlements with per-load math + driver portal + document upload. Demo: one load, dispatched → POD uploaded → settlement verified by "the driver."
3. **M3:** Bookkeeping (invoicing, expenses, per-truck P&L) + fuel-card CSV import.
4. **M4:** IFTA + DQF compliance modules.
5. **M5:** Load boards, Traccar GPS, ELD-vendor API, factoring, CRM, rate calculator.

Start with M1. Do not skip the tenant-isolation and money-math tests — they are the foundation everything else stands on.
