# Shop Manager

Inventory, point-of-sale and bookkeeping for a skincare shop.

Built for a single shop: track stock by batch and expiry, sell from the till,
keep a financial ledger that reconciles with the till, and remember what each
customer buys so you can recommend the right product next time.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands](#commands)
- [How the data model works](#how-the-data-model-works)
- [API](#api)
- [Authentication](#authentication)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Deployment notes](#deployment-notes)

---

## What it does

**Dashboard** — today's sales, profit and order count, low-stock and
expiring-soon counts, best sellers, and recent activity.

**Inventory** — products carrying cost price, selling price and a minimum stock
alert. Stock lives in *batches* with their own lot number, expiry date, cost and
supplier, so margin is calculated from the batches actually sold rather than a
single average cost. Receipts, manual stock-outs and corrections are recorded as
an append-only audit trail, and low-stock / expiring queues drive reordering.

**POS** — a cart with percent or fixed discounts, walk-in or attributed
customers, several payment methods, and a printable receipt. Checkout is a single
database transaction: stock, the stock audit trail, the sale and the ledger entry
either all commit or all roll back.

**Ledger** — every movement of money, with income from sales and manual entries
for rent, utilities, packaging and other costs, filterable by type, category,
payment method and date range, plus income/outcome/net summaries.

**Customers** — profiles with skin type, purchase history, lifetime spend and
manually tagged product recommendations.

---

## Requirements

- Node.js **20.19+** (24 recommended; `package.json` pins the engine)
- A MongoDB deployment **running as a replica set** — see below. No local MongoDB
  install is needed for development.

> **Why a replica set is mandatory**
> POS checkout writes to four collections (products, stock movements, sales,
> transactions) that must agree with each other. MongoDB only offers
> multi-document transactions on a replica set, so a standalone `mongod` cannot
> support correct checkout. A single-node set is enough for a one-shop business;
> `replicaSet=rs0` in the connection string is the whole requirement.

---

## Quick start

### Option A — Docker Compose (everything, including MongoDB)

```bash
docker compose up --build
```

Then:

- App: <http://localhost:3000>
- MongoDB: `localhost:27017` (user `admin`, password `admin`)

The first run creates an empty database. Populate it with demo data:

```bash
docker compose run --rm seed
```

Stop and discard everything, including the database volume:

```bash
docker compose down -v
```

The stack has three moving parts. `mongo` starts `mongod` with `--replSet rs0`;
the one-shot `mongo-init` container performs the `rs.initiate()` that turns it
into a real (single-node) replica set and waits for a primary; `app` waits for
that to finish before starting. `mongo-init` is idempotent, so it is safe on
every `up`.

### Option B — Local Node, in-memory MongoDB

The fastest way to look around. With no `MONGODB_URI` configured, the app starts
an in-process `mongodb-memory-server` replica set, so transactions work and
nothing needs to be installed:

```bash
npm install
```

Create the owner account (skipped entirely if `ADMIN_USERNAME`/`ADMIN_PASSWORD`
are unset), then start the server:

```bash
$env:ADMIN_USERNAME="owner"
$env:ADMIN_PASSWORD="<something long and random>"
npm run seed
npm run dev
```

Open <http://localhost:3000> — you will be redirected to `/login`.

Data lives in memory and is discarded when the server stops, including the owner
account. Any option below persists it.

### Option C — Local Node, your own MongoDB

```bash
cp .env.example .env.local     # set MONGODB_URI
npm run dev
```

---

## Configuration

All variables are optional in development; see `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | *(empty)* | Connection string. Must point at a replica set. Empty triggers the in-memory fallback. |
| `MONGODB_DB_NAME` | `shopmanager` | Database name, for URIs that name none. |
| `MONGODB_MEMORY_FALLBACK` | `true` | Set `false` in any deployed environment to fail loudly instead of starting the in-memory server. |
| `ADMIN_USERNAME` | *(empty)* | Owner account username, read by `npm run seed`. Required for the seed. |
| `ADMIN_PASSWORD` | *(empty)* | Owner account password, read by `npm run seed`. Required for the seed, minimum 8 characters. |
| `ADMIN_DISPLAY_NAME` | *(username)* | Name shown in the nav bar. |
| `EXPIRY_ALERT_DAYS` | `30` | Default window for the "expiring soon" queue. |
| `CURRENCY_SYMBOL` | `$` | Currency label shown throughout the UI. |

`MONGODB_MEMORY_FALLBACK=false` is the production guard, and it deliberately does
**not** key off `NODE_ENV`: declaring `NODE_ENV` in Netlify applies it to the
install step, where npm skips every devDependency and the build fails. Next.js
sets `NODE_ENV=production` itself during `next build`, so the variable achieves
nothing except the breakage.

`.env`, `.env*.local` are git-ignored. Never commit a real connection string —
it contains a password.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on <http://localhost:3000>. |
| `npm run build` | Production build (standalone output). |
| `npm start` | Serve the production build. |
| `npm run lint` | ESLint across the project. |
| `npm run typecheck` | Regenerate typed routes, then `tsc --noEmit`. |
| `npm test` | Run the test suite once. |
| `npm run test:watch` | Tests in watch mode. |
| `npm run seed` | **Destructive.** Wipe and rebuild the database with demo data. |
| `npm run seed -- --owner-only` | Create the sign-in account only; touch no data. |

`npm run seed` wipes the collections it manages, so point it at a throwaway
database. It requires a replica set, exactly like the app, and `ADMIN_USERNAME`
plus `ADMIN_PASSWORD` — it validates them and **aborts before deleting anything**
if either is missing, so there is no path that creates an account with a blank
password. With `--owner-only` it skips the wipe entirely and only ensures the
account exists — the non-destructive way to restore a login on a fresh or wiped
database.

The owner account is never wiped. Re-running the seed leaves an existing account
and its password untouched; it only creates one that does not exist yet.

> On a memory-constrained machine, raise the heap for typechecking and builds:
> `$env:NODE_OPTIONS="--max-old-space-size=3300"` (PowerShell) or
> `NODE_OPTIONS=--max-old-space-size=3300` (bash).

---

## How the data model works

**Stock is batches, not a number.** Each product embeds a list of batches, and
`stockQuantity` is a cached sum of their quantities. That single invariant drives
most of the code:

```
product.stockQuantity === sum(product.batches[].quantity)
```

Stock-in appends a batch. Stock-out removes from a batch. Because a batch carries
its own `costPrice`, the profit on a sale is the difference between what the
customer paid and what *those specific lots* cost.

**FEFO.** Sales allocate from the batch with the earliest expiry first, so
near-expiry stock sells before fresh stock and nothing quietly expires on the
shelf. A single sale line can therefore span several batches; the sale records
exactly which ones, and each is logged as its own stock movement.

**Checkout is one transaction.** A sale reads the product, plans FEFO allocation,
decrements the batches, writes one movement per batch consumed, inserts the sale
and inserts the ledger entry — all inside a single transaction. If any step fails
(most often `INSUFFICIENT_STOCK`), everything rolls back, so stock and books can
never disagree. This is why a replica set is required.

**Corrections cannot corrupt cost data.** A negative adjustment (damage, a
stocktake) simply reduces a batch. A positive one has to create a real batch, so
it demands an expiry date and cost price — otherwise added stock would have no
cost and would quietly inflate reported profit.

**Money is integer cents.** Amounts are stored and calculated in cents and
formatted at the edge, because floating-point arithmetic otherwise produces
totals that are a cent out and impossible to explain to a customer.

**Dates are local calendar days.** "Today", "this month" and an expiry window all
mean the same thing to the shopkeeper that they mean on the receipt, so dates are
parsed as local days and arithmetic adds calendar days rather than 24-hour
periods. Both details are easy to get wrong in ways that only show up in one
timezone or across a daylight-saving change, and when they do the report still
renders — it is just quietly missing a day.

**The ledger is the source of truth for cash.** Sales write their own income
entry as part of checkout, so the till and the ledger cannot drift. The
`FinancialTransaction` schema enforces that `Sales` can only be income and that
operating costs can only be outcomes; a fully discounted sale may legitimately be
zero, but a manual entry may not.

**Removing a product has two distinct operations.** Deactivating sets
`active: false`, which hides it from the catalogue, the POS and the alert queues
while keeping the document — necessary for anything with sales history, since a
sale must keep pointing at a real product. A hard delete is available for a row
that was only ever created, and is refused with 409 if any sale references it. It
also removes the stock movements it created and unlinks it from customer
recommendations, all in one transaction. The reason the second operation exists at
all: `sku` carries a unique index, so a deactivated product keeps its SKU reserved
and cannot be recreated under the same one.

### How much space does this take?

Measured with `BSON.calculateObjectSize` against representative documents:

| Document | Size |
| --- | --- |
| Manual ledger entry (no breakdown) | 194 B |
| POS ledger entry (5-item breakdown) | 771 B |
| Sale (5 items, with FEFO batch detail) | 1,535 B |
| Stock movement (one consumed lot) | 288 B |

One five-item checkout therefore costs about 3.7 KB across the three collections.
Projected over a year: **8 MB at 30 sales/day, 16 MB at 60/day, 54 MB at
200/day.** MongoDB Atlas free tier allows 0.5 GB, so even the busiest of those
uses roughly a tenth of the allowance; filling it would take on the order of
10,000 sales a day.

Capacity is not the risk on the free tier — **backups are.** M0 does not include
them, so schedule your own `mongodump` if the books matter.

---

## API

Every response uses one envelope, so the client can branch on a single field:

```jsonc
{ "ok": true,  "data": { /* ... */ } }
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "issues": [{ "path": "sku", "message": "..." }] } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Malformed request. |
| `UNAUTHORIZED` | 401 | No valid session. Sent by every route except `/api/health`. |
| `FORBIDDEN` | 403 | Authenticated, but not permitted. |
| `VALIDATION_ERROR` | 422 | Input failed validation; `issues` lists each field. |
| `NOT_FOUND` | 404 | No such record. |
| `CONFLICT` | 409 | Duplicate SKU, or a permanent delete refused because the product has sales. |
| `INSUFFICIENT_STOCK` | 409 | Cart cannot be fulfilled; `issues` names the offending lines. |
| `DATABASE_ERROR` | 503 | MongoDB unreachable. |
| `INTERNAL_ERROR` | 500 | Unexpected bug. Details are logged, never returned. |

### Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness plus whether the connection supports transactions. **Unauthenticated** — the Docker healthcheck has no credentials. |
| `POST` | `/api/auth` | Sign in. Sets the session cookie. |
| `DELETE` | `/api/auth` | Sign out. Revokes the session server-side and clears the cookie. |
| `GET` | `/api/auth/me` | Current user. 401 when signed out. |
| `GET` | `/api/dashboard` | Everything the dashboard shows. |
| `GET` `POST` | `/api/products` | List (search, category, low-stock, `expiringWithinDays`, `includeInactive`, paging) / create. |
| `GET` `PATCH` `DELETE` | `/api/products/[id]` | Read, update, deactivate. `?restore=true` reactivates; `?purge=true` deletes permanently (see below). |
| `POST` | `/api/products/[id]/batches` | Stock-in; can merge into an existing lot. |
| `POST` | `/api/products/[id]/stock-out` | Manual stock-out, FEFO unless a `batchId` is given. |
| `PATCH` | `/api/products/[id]/stock-out` | Signed correction (stocktake, damage). |
| `GET` | `/api/products/low-stock` | Reorder queue. |
| `GET` | `/api/products/expiring` | Expiry queue for a `days` window. |
| `POST` | `/api/sales` | POS checkout. |
| `GET` | `/api/stock-movements` | The stock audit trail. |
| `GET` `POST` | `/api/transactions` | Ledger entries / record a manual income or expense. |
| `GET` | `/api/transactions/summary` | Income, outcome and net for a `from`/`to` period. |
| `GET` `POST` | `/api/customers` | List (search, skin type, paging) / create. |
| `GET` `PATCH` | `/api/customers/[id]` | Read (with stats) / update. |
| `GET` | `/api/customers/[id]/history` | That customer's sales. |
| `POST` | `/api/customers/[id]/recommendations` | Replace the tagged list with `{ productIds: [...] }`. |

Stock movements and product updates return the updated product, so the UI can
refresh from a single response. All list endpoints page with `?page=&limit=` and
report `total` and `totalPages`; every filter is optional.

Every endpoint above except `/api/health` requires a session. See
[Authentication](#authentication).

---

## Authentication

One shop, one user. Create the account with `npm run seed` (see
[Commands](#commands)), then sign in at `/login`.

**Sessions are server-side and revocable.** A random 32-byte token goes into an
`HttpOnly` cookie; only its scrypt hash is stored, on `user.sessionTokens`.
Signing out deletes the stored hash, so the cookie is dead immediately rather
than remaining valid until it expires. This is why the design is not a JWT — a
signed self-contained token cannot be withdrawn.

**Passwords are scrypt-hashed**, using `node:crypto` rather than a dependency, so
nothing native has to build on Netlify. The cost parameters are embedded in the
hash, so the work factor can be raised later without a migration.

Enforcement is in three independent layers:

- `middleware.ts` returns a 307 to `/login` for any page request that carries no
  session cookie, so a signed-out visitor never even downloads the page shell.
- `protectedRoute` in `lib/api.ts` rejects an unauthenticated request with 401
  before the handler body runs. Fifteen routes use it; `/api/health` and the
  three `/api/auth` routes deliberately do not.
- The `(app)` layout calls `requireSession` and redirects to `/login`; it is the
  layer that actually validates the cookie, so a forged or expired one is still
  turned away even though the middleware let it through.

Neither layer trusts the other, and the client-side 401 handler in
`api-client.ts` is only a convenience.

`MONGODB_URI` and `ADMIN_PASSWORD` are secrets. Do not commit either, and do not
paste either into chat or an issue.

---

## Testing

```bash
npm test
```

The suite covers the parts where a subtle mistake is expensive:

- **`fefo`** — allocation order, splitting a request across batches, expiry
  boundaries, and fractional-request accounting.
- **`money`** — cent conversion, discount rounding, and decimal values such as
  `1.005` that naive rounding gets wrong.
- **`dates`** — local-day handling for day boundaries, "today" and period
  filters, including daylight-saving transitions.
- **`validators`** — request schemas, including that every list endpoint accepts
  an *empty* query (a required filter once broke `/api/transactions` and
  `/api/customers`).
- **`inventory`** — integration tests against a real in-memory replica set:
  stock-in/out, adjustments, low-stock and expiry queries, and transactional
  checkout including the oversell rollback path.
- **`ledger`** — integration tests for period filtering and ledger integrity,
  including that an entry recorded late on the final day of a range is not
  dropped.
- **`auth`** — password hashing (salting, cost rejection, malformed input) and
  session issuance against a real replica set, including that an unknown username
  and a wrong password produce identical errors and that `ensureUser` never
  overwrites an existing password.
- **`product-removal`** — the soft/hard delete split: that deactivation keeps the
  document while purge removes it, that purge clears the stock movements and
  recommendation links it would otherwise orphan, that a sold product is refused
  with 409, and that purge frees the unique SKU where deactivate cannot.

Tests spin up their own MongoDB replica set; no external database is needed.

**Run the suite in more than one timezone.** Every date in this app is a *local*
calendar day, because that is how a shopkeeper thinks about "today" and "this
month", and getting that wrong is silent — the report still renders, it is just
missing a day. The suite is written to pass under any `TZ`, and several tests
only fail in a negative-offset zone, so this is worth doing before changing any
date handling:

```bash
TZ=America/New_York npm test    # negative offset
TZ=Australia/Sydney npm test    # southern-hemisphere DST
TZ=UTC npm test
```

---

## Project layout

```
middleware.ts          Edge middleware returning a 307 to /login for cookie-less page requests
app/
  (app)/              session-guarded pages (dashboard, inventory, pos, ledger, customers)
  login/              the only page reachable without a session
  api/                route handlers, one folder per resource
  error.tsx           route-level error boundary
  loading.tsx         route-level loading UI
  not-found.tsx       404
components/           UI primitives, app shell, API client hooks
lib/
  api.ts              envelope helpers, handleRoute and protectedRoute
  auth.ts             sessions: login, logout, requireSession, cookie policy
  session.ts          the session cookie name, shared by auth and middleware
  password.ts         scrypt hashing (no next/headers dependency, so scripts can use it)
  db.ts               mongoose connection, transaction helper, memory fallback
  errors.ts           typed errors -> HTTP status codes
  fefo.ts             batch allocation
  money.ts            cent-based arithmetic and formatting
  dates.ts            date helpers
  validators.ts       zod schemas for every request body and query
  serializers.ts      mongoose documents -> plain DTOs
  services/           all business logic, transport-agnostic
models/               mongoose schemas
scripts/seed.ts       deterministic demo data + owner account
tests/                vitest suites
types/                shared enums and DTO types
```

The layering is deliberate: routes only parse input and shape output, services
hold the rules and never touch `Request`/`Response`, and models are plain
Mongoose. That is what lets the integration tests drive the real business logic
without going through HTTP.

---

## Deployment notes

`npm run build` emits a standalone server (`output: 'standalone'`), which the
`Dockerfile` uses to keep the runtime image small.

**Before putting this on a network other than your own:**

1. **Back up MongoDB.** The database holds the only copy of the stock and the
   books, and Atlas free tier does not back it up. `mongodump` on a schedule.
2. **Check transactions on the real deployment.** The app reports
   `transactional: false` from `/api/health` if it cannot find a replica set;
   checkout still works but falls back to sequential writes, which is no longer
   atomic. Treat a `false` there as an error in production.
3. **Rotate the credentials** in `docker-compose.yml` before using it anywhere
   shared.
4. **Serve over HTTPS**, and keep `.env` files out of the image.

Authentication is already built in (see [Authentication](#authentication)), so
item 1 in the old list no longer applies. Two Netlify-specific notes:

- `ADMIN_USERNAME`/`ADMIN_PASSWORD` are needed only to run the seed once. Set
  them, seed, then **delete them** from the environment. Nothing re-reads them on
  redeploy.
- Do not use Netlify's site-wide password protection. It would also cover
  `/login`, so there would be no way in.

`npm audit` reports high-severity advisories in the transitive dependency tree.
The available automated fix downgrades `eslint-config-next` (a dev dependency),
which would break the lint setup; resolve them deliberately as the advisories
age rather than by force.
