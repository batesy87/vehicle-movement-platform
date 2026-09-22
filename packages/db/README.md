# @platform/db

The schema, its row level security policies, and the tests that prove they
work.

## What is authoritative

`../../supabase/migrations/*.sql`. Applied in filename order, each in its own
transaction. They hold the tables, the policies, the triggers, the check
constraints and the composite foreign keys, none of which have a faithful
representation in an ORM.

They live under `supabase/` and are named `<14-digit timestamp>_<name>.sql` so
the Supabase CLI and this runner operate on exactly the same files. The runner
records what it applied in `supabase_migrations.schema_migrations`, the ledger
the CLI reads, so `supabase db push` and `pnpm migrate` agree about what is
already applied and neither re-runs the other's work.

`src/schema/` mirrors that in Drizzle so application queries are typed.
`test/schema-parity.test.ts` compares the two in both directions and fails on
drift, including a column added in SQL and forgotten in Drizzle, which would
otherwise be invisible to every query the application writes.

## Commands

```bash
pnpm migrate          # apply anything outstanding
pnpm status           # list applied and pending, change nothing
pnpm reset            # drop and rebuild public and app, then apply everything
pnpm seed             # two tenants, a shared driver, a two-leg consignment
pnpm test             # 143 tests against a real Postgres
```

`status` is read-only in the strict sense: it checks for the ledger with
`to_regclass` rather than creating it, so asking the question cannot change the
answer. It also warns when the database records a migration that is not in your
checkout, which means the branch is behind what has been deployed.

Against a hosted project, prefer the **Migrate hosted database** workflow over
running either of these by hand. It reads the connection string from a
repository secret, so the password stays in GitHub.

`DATABASE_MIGRATION_URL` is used when set, falling back to `DATABASE_URL`.
Migrating needs rights the application's own connection should not have.

The runner records a checksum of every file it applies and refuses to continue
if one changed afterwards. That is not pedantry: a silently edited migration
means the database and the repository disagree about what the schema is. Add a
new file instead; `--reset` exists for development.

`reset` drops `public` and `app` but never `auth`. On a real Supabase project
that schema holds the user accounts.

## Migration order

| File | Contents |
|---|---|
| `...120001_foundation` | roles, extensions, `auth` shim, the `app` schema, every enum |
| `...120002_tenancy_tables` | plans, companies, membership, driver profiles, invitations |
| `...120003_tenancy_functions` | the membership and role predicates every policy is built from |
| `...120004_tenancy_policies` | policies for the tables in the previous step |
| `...120005_operations` | clients, locations, vehicles, rate cards |
| `...120006_movement` | consignments, vehicles, trips, legs, trip stops |
| `...120007_custody_and_media` | custody events, media, condition findings, breadcrumbs |
| `...120008_billing_and_audit` | invoices, usage metering, audit log |
| `...120009_rpc` | signup, driver invitation, invitation acceptance |
| `...120010_reference_data` | plan tiers |

Policies normally sit directly beneath the table they guard. Two places break
that, both because Postgres validates SQL function bodies at creation time and
a predicate cannot reference a table that does not exist yet: the tenancy
tables and their policies are split around the helpers between them, and the
driver-visibility predicates in `movement` are gathered at the end of that
file, after `legs`.

Add a migration with `supabase migration new <name>`, which generates the
correct filename. Never edit one that has been applied.

## Running the tests locally

Anything Postgres 15+ will do. With Docker:

```bash
docker run -d --name vmp-pg -e POSTGRES_PASSWORD=postgres \
  -p 54322:5432 postgres:16-alpine

export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
pnpm reset && pnpm test
```

Without Docker, any local cluster works; the migrations create the `anon`,
`authenticated` and `service_role` roles and a minimal `auth` schema if they
are not already present, so the same policies and the same harness run
unchanged against a bare Postgres and against Supabase.

The suites share one database and run sequentially. They truncate between
files, so do not point `DATABASE_URL` at anything you care about.

## What the tests cover

- **`rls-isolation`** enumerates every tenant-scoped table from `pg_tables`,
  seeds a row in company B, and asserts company A cannot read, claim, update or
  delete it. A coverage check fails if any table has no fixture row, so
  isolation is never silently untested. Because the list comes from the
  catalogue, a table added later is covered without anyone remembering to add
  it.
- **`schema-guard`** asserts the structural rules: RLS enabled and forced
  everywhere, at least one policy per table, no `USING (true)`, no
  `WITH CHECK (true)`, no `FOR ALL`, no policy granted to `PUBLIC`, a
  `WITH CHECK` on every insert and update, a non-nullable `company_id` outside
  four documented exceptions, `company_id` carried through every foreign key
  between tenant tables, a pinned `search_path` on every `SECURITY DEFINER`
  function, and no delete policy on the evidence tables.
- **`tenancy`** covers behaviour: a driver spanning two companies, revocation
  taking effect on the next statement, a driver recording custody only for
  their own legs, staff role boundaries, both driver-invitation paths, and
  per-tenant reference numbering.
- **`schema-parity`** compares enums, Drizzle tables and plan features against
  the database.

Two real bugs came out of writing these, both described in `docs/tenancy.md`:
a role predicate returning NULL where `plpgsql` needed a boolean, and a
driver-visibility policy that did not re-check membership.
