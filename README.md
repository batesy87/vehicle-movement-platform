# Vehicle Movement Platform

Multi-tenant SaaS for companies that move vehicles under contract: lease
returns, fleet relocation, dealership stock movement. Transport companies sign
up, manage their own drivers, clients and jobs, and pay by subscription.

This is a rebuild of a single-tenant system that ran roughly 150 vehicle
movements a day across 50 drivers. The two things it does that competitors
appear not to:

- **Leg-based handover.** A vehicle's journey can be split across several
  drivers, with custody and proof of collection or delivery captured at every
  handover, not only at the start and the end.
- **Multi-vehicle, multi-stop consignments.** One client job can cover several
  vehicles moved together, either sharing one pickup and dropoff or each routed
  independently.

The product does not have a name yet. Nothing in the code or the schema
hardcodes one.

## Status

Foundation phase. What exists:

- The full multi-tenant Postgres schema, with row level security enabled and
  forced on every table
- Authentication, self-serve company signup, and a 14-day trial
- Staff and driver invitation flows, including the cross-company consent path
- A test suite that proves cross-tenant access fails closed

What does not exist yet: the consignment and dispatch interface, the driver
app, offline capture, Stripe, and invoicing. The schema for all of it is in
place.

## Getting started

Requires Node 22+, pnpm 10+, and a Postgres 15 or later to talk to.

```bash
pnpm install
cp .env.example .env.local        # and fill it in
```

**Database.** Either run `supabase start` (which gives you Auth and Storage
too), or point `DATABASE_URL` at any Postgres 15+. The migrations create a
minimal `auth` schema shim when one is not already there, so they run unchanged
against both.

Setting up hosted Supabase and Vercel projects is covered step by step in
[docs/setup.md](docs/setup.md).

```bash
pnpm db:migrate                   # apply migrations
pnpm db:seed                      # two tenants and a driver who works for both
pnpm db:test                      # 143 tests, against a real database
pnpm --filter @platform/web dev
```

`pnpm db:reset` drops and rebuilds `public` and `app` from scratch. It leaves
`auth` alone, because on a real project that schema holds the user accounts.

The seed creates two companies and one driver linked to both, because that
overlap is where tenancy bugs actually live. A single-tenant seed lets a broken
policy look fine.

## Layout

```
apps/web/                Next.js App Router: auth, onboarding, team, drivers
supabase/                config.toml and migrations (the schema itself)
packages/db/             migration runner, Drizzle schema, seed, RLS tests
packages/shared/         enums, plan features, validation, damage taxonomy
packages/config/         shared tsconfig
docs/                    setup, tenancy model, data model
```

## The part that matters

Row level security is the tenant boundary, not a second line of defence behind
application filters. Every tenant-scoped table has a non-nullable `company_id`,
`ENABLE` **and** `FORCE ROW LEVEL SECURITY`, one policy per operation, and a
`WITH CHECK` on every insert and update. There is no `USING (true)` anywhere,
and a test fails the build if one appears.

That strictness is on purpose. A lot of the query code on this project will be
generated, and generated code adds tables. A new table with RLS left off is not
a subtle bug: it is every tenant reading every other tenant's rows, and it
produces no error and no failing test anywhere else. So `test/schema-guard.test.ts`
walks the live catalogue and fails if any table lacks RLS, lacks FORCE, has no
policy, carries a blanket-true policy, is missing `company_id`, or has a
foreign key that could point across the tenant boundary.

`test/rls-isolation.test.ts` does the same trick for behaviour. It enumerates
tables from `pg_tables` rather than a hand-written list, so a table added next
year gets its isolation tests automatically. For each one it seeds a row in
company B and asserts company A cannot read it, claim it, update it or delete
it, with and without the `company_id` filter that application code might
forget.

The suite has already earned it. Writing these tests surfaced two real bugs: a
role check that returned NULL for a non-member, which `plpgsql` quietly treated
as "carry on" and which disabled an authorisation guard inside a
`SECURITY DEFINER` function, and a driver-visibility policy that did not
re-check membership, so revoking a driver's access had no effect.

See [docs/tenancy.md](docs/tenancy.md) for how the model works and why it
departs from a JWT claim, and [docs/schema.md](docs/schema.md) for the data
model.

[docs/active-company-in-the-token.md](docs/active-company-in-the-token.md) is a
design note rather than a description of what exists. It covers what it would
take to drop the direct Postgres connection and reach the database through
supabase-js, and is worth reading before anyone assumes the current transport
is load-bearing.

## Deployment

Built for Supabase (Postgres, Auth, Storage) and Vercel. Step-by-step setup is
in [docs/setup.md](docs/setup.md). The one setting people miss: Vercel's **Root
Directory** must be `apps/web`, because this is a monorepo and the repository
root holds no app.

Two notes on cost, since the intention is to stay near zero until there is
revenue:

- Vercel's Hobby tier forbids commercial use, so budget for Pro once you charge
  anyone.
- Media egress is what scales badly for a photo-heavy product. `media_objects`
  stores a bucket and an object key rather than a URL precisely so object
  storage can be swapped for a zero-egress provider later without touching the
  schema.

## Conventions

- **The SQL is the source of truth.** `supabase/migrations/*.sql` holds the
  schema, the policies, the triggers and the constraints. It lives under
  `supabase/` so the CLI and `pnpm db:migrate` share one set of files and one
  ledger. The Drizzle definitions exist so queries are typed, and a parity test
  compares the two in both directions.
- **Migrations are append-only.** The runner checksums what it applied and
  refuses to continue if a file changed underneath it. Add a new migration
  rather than editing an old one; `--reset` is for development.
- **Never commit a secret.** The system this replaces had live service-account
  keys and API keys committed to the repository. `.gitignore` here blocks the
  usual shapes, and `.env.example` is the only tracked env file.
