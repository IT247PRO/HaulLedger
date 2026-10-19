# HaulLedger

Trucking back office for small carriers (1–50 trucks) and owner-operators. The wedge is
**driver-verifiable settlements tied to per-truck P&L**. See [`Claude instruction.md`](./Claude%20instruction.md)
for the full product brief and build plan.

## Status

| Milestone | Scope | State |
| --- | --- | --- |
| **M1** | Auth, multi-tenancy, drivers / equipment / customers / loads, tenant-isolation + RBAC tests | **Done** |
| M2 | Settlements (per-load math), driver portal, R2 document upload | Next |
| M3 | Invoicing, expenses, per-truck P&L, fuel-card CSV import | — |
| M4 | IFTA, DQF | — |
| M5 | Load boards, Traccar, ELD vendor API, factoring, CRM, rate calculator | — |

## Stack

- **API:** Hono on Cloudflare Workers (`api/`)
- **DB:** Cloudflare D1, a single database. Every table has a `tenant_id` (`migrations/`)
- **Web:** React + Vite + TypeScript + Tailwind (`web/`)
- **Files:** Cloudflare R2 (binding `DOCS`, used from M2)
- **Tests:** Vitest running inside workerd against real D1 (`@cloudflare/vitest-plugin`)
- **Package manager:** pnpm workspaces

## Getting started

```sh
pnpm install
pnpm db:migrate:local      # apply migrations/ to the local D1
pnpm db:seed:local         # demo carrier: 3 trucks, 5 drivers, ~1 month of loads
pnpm dev:api               # Worker on :8787
pnpm dev:web               # Vite on :5173, proxies /api to the Worker
```

Demo logins (password `demo-password-123`):

| Login | Role |
| --- | --- |
| `owner@demo.haulledger.test` | Owner |
| `dispatch@demo.haulledger.test` | Dispatcher |
| `marcus@demo.haulledger.test` (also `angela@`, `dwayne@`, `priya@`, `cody@`) | Driver |

Checks: `pnpm typecheck`, `pnpm test`.

### Deploying

```sh
wrangler d1 create haulledger          # put the id into api/wrangler.jsonc
wrangler r2 bucket create haulledger-docs
pnpm --filter @haulledger/api db:migrate:remote
pnpm --filter @haulledger/api deploy
```

## How tenancy is enforced

1. **The session decides the tenant.** `requireAuth` resolves the session token to `(user, tenant, role)`.
   No route reads a tenant from the request, and request bodies are strict, so a stray `tenant_id` is rejected.
2. **Every query binds `tenant_id`.** Records outside your tenant look the same as records that don't exist (404).
3. **The database backs it up.** Child tables reference parents through composite `(tenant_id, id)` foreign
   keys, so D1 refuses a load that points at another carrier's driver, truck, trailer or customer, even
   if a route has a bug.
4. **Tests prove it.** `api/test/tenant-isolation.test.ts` checks every resource and role for cross-tenant
   reads, writes and references. It also checks that every table has a `NOT NULL tenant_id`. If a route's
   tenant scoping is removed, these tests fail. This was checked by breaking the scoping on purpose.

## Roles (enforced server-side)

| | Owner | Dispatcher | Driver |
| --- | --- | --- | --- |
| Loads | all | all | own only, **no rate** |
| Advance load status | any valid move | any valid move | own load: pickup → in transit → delivered |
| Driver profiles, licence/medical dates | ✓ | ✓ | own profile, read-only |
| Hire a driver / set W-2 vs 1099 pay track | ✓ | ✗ | ✗ |
| Trucks, trailers, customers | ✓ | ✓ | ✗ |
| Team logins | ✓ | ✗ | ✗ |

## Domain notes

- **Money is integer cents** in storage, API and validation. The web app parses dollar input as digits,
  never with floating-point math.
- **Load status machine:** `planned → dispatched → at_pickup → in_transit → delivered`, plus `cancelled`.
  A load can't be dispatched without a driver and a truck. Each move is written to `load_events`
  with who made it and when. This is the trail M2 settlements will cite.
- **Expiration alerts:** `GET /api/alerts/expirations` lists active drivers whose CDL or DOT medical card
  is expired or expires within 30 days. These alerts sit at the top of the dashboard.
