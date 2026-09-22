# Creating the Supabase and Vercel projects

Do these in order. Supabase first, because Vercel needs its keys.

Everything here assumes you are pointing both services at `main` in this
repository.

## 1. Supabase

Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
Pick the London region if your drivers and clients are UK-based; it is the
difference between a fast dashboard and a sluggish one. Save the database
password somewhere safe, because it appears in the connection strings and is
shown only once.

From **Project Settings → API**, collect:

| Value | Goes into |
|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon` `public` key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` |

The service role key bypasses row level security completely. It is server-only,
never prefixed `NEXT_PUBLIC_`, and never pasted anywhere a browser can read.

From **Project Settings → Database → Connection string**, collect two:

| Connection | Goes into | Why |
|---|---|---|
| Transaction pooler (port `6543`) | `DATABASE_URL` | What the app uses. Serverless functions open and close connections constantly, and the pooler is what stops that exhausting Postgres. |
| Direct connection (port `5432`) | `DATABASE_MIGRATION_URL` | What migrations use. They create schemas, roles and functions, which wants a real session rather than a pooled one. |

### Apply the schema

Either the Supabase CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

or this repo's runner, which reads the same files and writes to the same
ledger:

```bash
DATABASE_MIGRATION_URL='<direct connection string>' pnpm db:migrate
```

Both work, and neither will re-apply what the other already did. Migrations
live in `supabase/migrations/` precisely so there is one set of files rather
than two.

Do **not** run `pnpm db:reset` against a hosted project. It refuses unless the
host is localhost, but do not go looking for the override.

### Storage

Create a private bucket named `custody-media` (Storage → New bucket, public
off). This is where proof-of-collection and proof-of-delivery photos and
signatures go. `supabase/config.toml` already declares it for local runs.

Object keys are namespaced by tenant:

```
{company_id}/consignments/{id}/vehicles/{id}/legs/{id}/{slug}.jpg
```

That prefix is deliberate. When the capture flow lands in a later phase, a
storage policy can be written against the leading path segment, so the tenant
boundary covers the files as well as the rows.

### Auth redirect URLs

Under **Authentication → URL Configuration**, once you know your Vercel domain:

- **Site URL**: `https://your-app.vercel.app`
- **Redirect URLs**: `https://your-app.vercel.app/auth/callback`, plus
  `https://*-your-team.vercel.app/auth/callback` if you want sign-in to work on
  preview deployments

Without the callback URL registered, confirmation and invitation links bounce
to an error rather than signing anyone in.

## 2. Vercel

Import the repository at [vercel.com/new](https://vercel.com/new). Two settings
matter, and the build fails in confusing ways if either is wrong.

**Root Directory**: `apps/web`. This is a monorepo, so the repository root has
no Next.js app in it.

**Include source files outside of the Root Directory**: on. The web app depends
on `@platform/db` and `@platform/shared`, which live in `packages/`. Without
this, the install succeeds and the build fails on unresolved workspace imports.

If you import the repository without setting Root Directory, the build fails
with something like "No Next.js version detected", because Vercel is looking at
the repository root where there is no app. That is the most common way this
goes wrong, and changing the setting is the whole fix: Settings → General →
Root Directory → `apps/web`, then redeploy.

Install and build commands are left to Vercel, which handles pnpm workspaces
natively: it runs the install at the workspace root and builds in the root
directory. `next.config.mjs` sets `outputFileTracingRoot` so the workspace
packages under `packages/` are traced into the deployed bundle rather than
going missing at runtime.

### Environment variables

Set these for Production, Preview and Development:

```
NEXT_PUBLIC_SUPABASE_URL        https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY   <anon key>
SUPABASE_SERVICE_ROLE_KEY       <service role key>      # not NEXT_PUBLIC_
DATABASE_URL                    <transaction pooler, port 6543>
NEXT_PUBLIC_APP_URL             https://your-app.vercel.app
TRIAL_PERIOD_DAYS               14
DATABASE_POOL_MAX               1
```

`DATABASE_POOL_MAX=1` is not a typo. Each serverless invocation gets its own
process, so a pool of ten per invocation multiplies out fast. One connection
per invocation, behind the transaction pooler, is the right shape.

`DATABASE_MIGRATION_URL` is deliberately absent. Vercel does not run
migrations; you do, from your machine or CI, before deploying a schema change.

### The Supabase integration

The Vercel marketplace has a Supabase integration that syncs the URL and keys
automatically. It is convenient and it does not set `DATABASE_URL` or
`DATABASE_POOL_MAX`, so add those by hand either way.

## 3. Check it worked

Deploy, then:

1. Visit `/signup` and create an account.
2. You land on `/onboarding`. Create a company and pick a plan.
3. You land on `/dashboard`, showing your trial end date and a plan allowance.
4. Go to **Team**, invite an address you control, and open the link that comes
   back. Email delivery is not wired up yet, so the link is shown in the UI.
5. Go to **Drivers** and invite someone. If that email already has a driver
   profile on the platform, you should see a message about asking for their
   consent rather than the driver simply appearing. That is the cross-tenant
   consent gate working.

To confirm the tenant boundary on the real project, open the Supabase SQL
editor, which runs as a privileged role, and compare:

```sql
-- As the privileged editor: you see everything.
select count(*) from public.companies;

-- As a tenant session: you see only your own.
set local role authenticated;
set local request.jwt.claims = '{"sub":"<your auth user id>","role":"authenticated"}';
select count(*) from public.companies;
```

The second count should be the number of companies you belong to, not the
number that exist.

## Ongoing

Schema changes are a new file in `supabase/migrations/`, named
`<14-digit timestamp>_<name>.sql`. `supabase migration new <name>` creates one
with the right name. Never edit an applied migration: the runner checksums what
it applied and will stop rather than let the database and the repository
disagree about what the schema is.

Before pushing a schema change to production, run it locally and run the suite:

```bash
pnpm db:reset && pnpm db:seed && pnpm db:test
```

143 tests, and the ones that matter check that a new table cannot arrive
without row level security.
