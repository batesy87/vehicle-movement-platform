# How multi-tenancy works

The short version: every tenant-scoped table carries a non-nullable
`company_id`, row level security is enabled and forced on all of them, and
membership is worked out from the database on every query rather than read from
a token. If application code forgets a `where company_id = ...` the query
returns nothing instead of returning somebody else's rows.

This document explains the parts that are not obvious from reading the SQL.

## Membership is derived, not claimed

The original spec suggested putting `company_id` in the Supabase JWT and
writing policies against `auth.jwt()`. That does not survive two facts about
this business.

Self-employed drivers work for several transport companies at once. A driver's
session spans a set of companies, not one, so a single-valued claim cannot
describe it.

More seriously, anything baked into a token goes stale. Revoke a driver's link
and, with the claim approach, they keep reading that company's data until their
token expires. For an operator who has just removed a driver after an incident,
an hour is a long time.

So the token supplies only `auth.uid()`. Everything else comes from:

```sql
app.company_ids_for_current_user()
```

which unions the caller's active `company_users` rows with their accepted
`driver_company_links` rows. It is `STABLE SECURITY DEFINER` with a pinned
`search_path`, and both membership tables carry a partial index covering
exactly this lookup.

The cost is a lookup per policy evaluation. Two things keep it cheap. The
function is `STABLE`, so the planner may evaluate it once per statement rather
than once per row, and every policy calls it wrapped in a scalar subquery:

```sql
using ((select app.has_company(company_id)))
```

That wrapping is what actually persuades Postgres to hoist the call out of the
row loop. It is not decoration; without it you get a function call per row.

## Reads and writes have different rules

Reads are permitted for any company the session belongs to. Writes additionally
require an explicitly chosen active company:

```sql
app.can_write_company(target)
  = app.active_company_id() = target
  and app.has_company(target)
```

`app.active_company_id()` reads a request-scoped setting the server applies
after validating it. A dispatcher who works for two operators has to say which
one they are acting as before they may write anything, because otherwise a
mistyped action lands in the wrong tenant's books and nobody notices until the
invoice run.

With no active company set, nothing is writable at all. That is deliberate:
fail closed.

## Why the application does not use supabase-js for data

A PostgREST-style client cannot set a per-request value like
`app.active_company_id`, because each call is its own transaction and a value
set in one request is gone by the next.

So Supabase Auth issues the identity and nothing more. Data access goes through
a Postgres pool where we control the transaction:

```
BEGIN
SET LOCAL ROLE authenticated          -- policies now apply to us
SET LOCAL request.jwt.claims = ...    -- auth.uid() resolves
SET LOCAL app.active_company_id = ... -- writes are scoped
...
COMMIT                                -- all three revert
```

`SET LOCAL` reverts at transaction end, which is what makes this safe on a
pooled connection: a transaction cannot leak its identity to whoever gets that
connection next.

This is `withTenantSession` in `packages/db/src/client.ts`. It is the only
supported way to touch tenant data. Anything that bypasses it runs as the
pool's owning role, which is not subject to policies.

## Composite foreign keys

Child tables reference `(id, company_id)`, not just `(id)`:

```sql
constraint legs_vehicle_fkey
  foreign key (consignment_vehicle_id, company_id)
  references public.consignment_vehicles (id, company_id)
```

Row level security stops you reading across the tenant boundary. This stops you
building a graph across it, even when the application code is wrong and hands a
query an id belonging to another tenant. It is the cheapest insurance in the
schema, and it is why every tenant table also carries a redundant-looking
`unique (id, company_id)`.

## NULL is not false

A predicate that evaluates to NULL is treated as false by a policy, so a policy
returning NULL is safe. `plpgsql` does not behave the same way: `if not <null>
then raise ...` never fires, and execution simply continues.

An early version of `app.has_company_role` returned NULL for a non-member,
which was harmless in policies and meant that the authorisation guard inside
`public.invite_driver` silently did nothing. The test suite caught it. All the
predicate helpers now return a real boolean, and the rule is: anything a
`SECURITY DEFINER` function guards itself with must never return NULL.

## What SECURITY DEFINER is for

Three situations cannot be expressed as a policy:

1. **Company signup.** A user who has just signed up belongs to nothing, so RLS
   correctly refuses to let them insert a company. The only policy that would
   permit it is `USING (true)`, which this schema does not contain.
2. **Accepting an invitation.** The invitee usually cannot see the invitation
   row, because they are not a member yet.
3. **Inviting a driver.** Choosing between creating a profile and requesting
   consent has to be atomic, under an advisory lock, or two dispatchers
   inviting the same person produce two profiles for one driver.

Each of those functions re-checks authorisation by hand as its first act,
because `SECURITY DEFINER` turns policies off. That check is the entire
security of the function.

## The exceptions

Three tables have no `company_id`, each for a stated reason:

- `plans` is global reference data and deliberately world-readable.
- `companies` is the tenant root, scoped by `id` rather than `company_id`.
- `driver_profiles` is global driver identity, shared across tenants by design.
  A driver reads and writes only their own row; a company sees the rows of
  drivers who have accepted a link to it.

These are listed in `EXEMPT` in `test/schema-guard.test.ts`. Adding a fourth
means editing that list and justifying it in review, which is the point.

## Consent

A company cannot see a driver's details, nor assign them work, until that
driver accepts. Acceptance is all-or-nothing: there is no field-level sharing,
so the question actually being put to the driver is "do you want to work for
this company at all", not "which of your details may they see".

This is enforced in `driver_profiles_select_linked_companies`, which matches
only links with `status = 'active'`. An invited-but-not-accepted link shows in
the drivers list with null columns, which is the consent boundary made visible
in the UI rather than hidden behind it.
