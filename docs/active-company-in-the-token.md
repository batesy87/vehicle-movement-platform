# Moving the active company into the token

A design note, not a decision that has been taken. It describes what it would
take to drop the direct Postgres connection and reach the database through
supabase-js the way the platform expects, and what that costs.

Read `tenancy.md` first if you have not. This note assumes you know why
membership is derived from tables rather than carried in a claim, because the
distinction between that and what is proposed here is the whole argument.

## Why this is on the table

Today every query runs through a pooled connection in `withTenantSession`,
which opens a transaction and sets three things on it: the role, the JWT
claims, and `app.active_company_id`. The third is the reason for the other two.
Writes are gated on `app.can_write_company()`, which requires an explicitly
chosen company, and that choice is a transaction-scoped Postgres setting.
PostgREST gives each request its own transaction with no hook to set a value
inside it, so supabase-js cannot carry it, so the application does not use
supabase-js for data.

That works, and it is tested. It also means the app needs `DATABASE_URL`, a
connection pool sized for serverless, and a second connection string to keep
correct. None of that is how Supabase is normally used, and every one of those
is a way to break production that would not otherwise exist.

The alternative is to stop treating the active company as connection state and
start treating it as part of the identity the token already carries.

## What has to be true

Three things, and the third is the one that does the work.

The token has to carry the chosen company. The value has to survive between
requests without the application re-asserting it. And choosing a company must
not, by itself, grant access to it.

That last point is what separates this from the design rejected in
`tenancy.md`. Putting *membership* in a claim is unsafe because claims go stale:
remove someone from a company and their token still says they belong until it
expires. Putting the *selection* in a claim is a different thing. The predicate
stays:

```sql
active_company = <claim>  AND  app.has_company(active_company)
```

`app.has_company()` still reads `company_users` and `driver_company_links` on
every statement. A stale claim can name a company. It cannot make the second
half of that conjunction true. Revocation still bites on the next statement,
which is the property the current design exists to preserve.

So the claim is a request, never an authorisation. Nothing in the schema should
ever trust it alone, and nothing proposed here does.

## The simple version, which needs no hook

`app_metadata` is already in the access token. It is a documented optional
claim, and Supabase describes `raw_app_meta_data` as the field for metadata
"the user should not be able to update", updatable only through the admin API
with the service role key. That is exactly the shape we want: server-written,
client-readable, carried in the token for free.

So the active company becomes:

```ts
// Server-side only. Needs the service role key.
await supabaseAdmin.auth.admin.updateUserById(userId, {
  app_metadata: { active_company_id: companyId },
});
```

and the predicate reads it back out of the claim. No auth hook, no new table,
no new grants, no policy exceptions.

One thing to verify before relying on this: whether `updateUserById` merges
into `app_metadata` or replaces it wholesale. The token normally carries
`provider` and `providers` in there, and clobbering those would be a quiet
regression in anything that reads them. If it replaces, read the current value
first and write the merged object. Check it against a real user rather than
assuming, because the failure is silent.

## When you would need the hook instead

The hook earns its place only if the active company has to be *derived* at the
moment a token is issued rather than stored ahead of it. The realistic case is
convenience: a user who belongs to exactly one company should not have to pick
it, so the hook could look up their single membership and fill the claim in.

That convenience is not free. A Custom Access Token Hook runs as
`supabase_auth_admin`, so for it to read membership it needs `select` on
`company_users` and `driver_company_links`, plus a policy letting that role read
them. The documented pattern for that policy is `using (true)`.

That collides with this repository directly. `schema-guard` asserts that no
policy anywhere in `public` uses `USING (true)`, because a blanket-true policy
is precisely how a tenant boundary stops existing. Adding one, even scoped to a
role the user cannot assume, means the guard gains its first exception, and
exceptions to that particular rule are the thing the rule exists to catch. It
also widens what GoTrue can read from tenant tables, which is a real expansion
of the boundary for a convenience feature.

The cheaper way to get the same convenience is to leave the claim empty when
nothing is stored, and have the application select the sole membership and write
it on first sign-in. That is one extra round trip once per user, and it keeps
the hook, the grant and the guard exception out of the design entirely.

Prefer the stored version. Reach for the hook only if something later genuinely
has to be computed at token-issue time.

## Rewriting the predicate

`app.active_company_id()` is the only function that changes:

```sql
create or replace function app.active_company_id()
returns uuid
language sql
stable
set search_path = public, pg_catalog
as $$
  select coalesce(
    -- The pooled path, still authoritative when present. Only a direct
    -- connection can set this, and only our own server holds one.
    nullif(current_setting('app.active_company_id', true), '')::uuid,
    -- The token path. Written by the admin API, signed by GoTrue, and
    -- worth exactly nothing without app.has_company() agreeing.
    nullif(auth.jwt() -> 'app_metadata' ->> 'active_company_id', '')::uuid
  )
$$;
```

`can_write_company()` does not change. No policy changes. No table changes.
That is the entire schema side of this.

Note the `set search_path`, which migration `...140001` added to this function.
Keep it on the replacement or the guard will fail the build.

## The coexistence period, which is what makes this safe

The `coalesce` above is the important part of this whole note. With both
sources read, both data paths work at the same time. A page still using
`withTenantSession` sets the GUC and wins. A page moved to supabase-js sets
nothing and falls through to the claim. They can run side by side, in
production, for as long as you like.

That turns a rewrite into a migration you can stop halfway through. Move one
page, deploy it, watch it. Move the next. If something is wrong, the page goes
back to the pooled path without a schema change and without a rollback.

Both sources are trusted. The GUC can only be set over a direct connection,
which only the server has. The claim can only be set by GoTrue signing a token.
Neither is reachable by a browser, and neither is sufficient on its own,
because membership is still checked against the tables underneath.

## What changes in the application

The data access surface is small: fourteen queries across seven files, inside
nine `withTenantSession` blocks.

`onboarding/actions.ts`, `team/actions.ts`, `drivers/actions.ts` and
`invite/[token]/actions.ts` are already calling `SECURITY DEFINER` functions or
single statements. Those map almost directly onto `supabase.rpc(...)` and
`supabase.from(...)`, because a definer function over PostgREST is the same
function with the same authorisation checks inside it.

`dashboard/page.tsx` is the awkward one, with five queries that exist to build
one view. Those want to become a SQL view or a single function returning the
shape the page renders, which is a better structure than five round trips
regardless of which transport is underneath.

`listMemberships()` and `assertMembership()` in `packages/db` both go through
`my_memberships()`, which is already an RPC. They become supabase-js calls and
stop needing the pool.

`lib/session.ts` changes shape. The active company currently lives in a cookie
that is validated against the database on every request. Under this design it
lives in the token, so the cookie goes away and switching company becomes:
write `app_metadata`, then `supabase.auth.refreshSession()` so the new token is
issued, then redirect. The validation that the cookie needed is no longer
needed, because a company the user does not belong to fails the membership half
of the predicate rather than being silently swapped for a different one.

`withServiceRole` stays as it is for anything genuinely running without a user,
or becomes a supabase-js client built with the service role key. Either way it
keeps its deliberately uncomfortable name.

## What does not change

Every policy. Every table. The derived-membership design and the functions that
implement it. The schema guard, apart from the caveat below. All 147 tests,
apart from how the harness sets the active company.

This is worth saying plainly because it is the reason the switch is cheap now.
The tenant boundary does not depend on how the application connects. It depends
on `app.has_company()` reading tables, and that is untouched.

## What gets worse

Switching company stops being free. It currently costs a cookie write; it would
cost a token refresh, which is a network round trip to GoTrue. For a
self-employed driver moving between two operators several times a day that is
noticeable, though not painful.

Multi-statement transactions go away. Nothing in the current code depends on
one for correctness, since the writes that need atomicity are already inside
definer functions, but that stops being free too. Any future operation that has
to be atomic across tables has to be written as a function rather than as a
sequence of calls. That is arguably the better habit and definitely the less
convenient one.

Ad-hoc SQL goes away with it. PostgREST is a good fit for reading rows and a
poor one for reporting queries, so the analytics work in a later phase will
want views, functions, or its own connection. Worth knowing before the
dashboard grows.

## The tests and the bare-Postgres shim

The harness keeps its direct connection, because tests are not serverless and
have no reason to pretend otherwise. What changes is that the suite should
exercise the claim path rather than only the GUC path, or the thing being
shipped is not the thing being tested.

That means setting `active_company_id` inside `request.jwt.claims` instead of
setting a separate GUC, which is one fewer moving part in the fixture.

It also needs `auth.jwt()` to exist. Migration `...120001` shims `auth.uid()`
and `auth.role()` for bare Postgres but not `auth.jwt()`, so the shim needs a
third function reading `current_setting('request.jwt.claims', true)::jsonb`,
guarded the same way the others are so it never tries to create anything on a
real Supabase project.

Keep at least one test on the GUC path for as long as the `coalesce` is there.
A coexistence mechanism nothing tests is a coexistence mechanism that has
quietly stopped working.

## The schema guard

Two entries need attention, both minor, and neither if you take the stored
version over the hook.

If a preferences table is introduced, it needs an `EXEMPT` entry in
`schema-guard.test.ts`, because it has no `company_id` and is keyed by user
rather than by tenant. That is a legitimate exemption of the same kind as
`driver_profiles`, and it should carry the same one-line justification.

If the hook route is taken, the `USING (true)` assertion has to gain an
exception for policies granted solely to `supabase_auth_admin`. Do not weaken
the assertion generally. Narrow it to that role by name, or the rule stops
meaning anything.

## Order of work

The schema change comes first and on its own, because it is additive and
reversible. Add `auth.jwt()` to the shim and rewrite `app.active_company_id()`
with the `coalesce`. Nothing behaves differently at this point, since no token
carries the claim yet. Ship it, confirm the tests still pass, confirm the app
still works.

Then the writing side. Add the server action that sets `app_metadata` and
refreshes the session, and wire it into onboarding and the company switcher.
Now tokens carry the claim while the GUC still wins wherever it is set, so
still nothing changes behaviourally.

Then move pages one at a time, starting with a read-only one. `team/page.tsx`
is the obvious first, being two straightforward reads. Deploy between each.

`lib/session.ts` and the cookie go last, once nothing reads them.

Remove the `coalesce` fallback and `DATABASE_URL` only when the last
`withTenantSession` call site is gone, and keep `DATABASE_MIGRATION_URL`
regardless, since migrations always want a direct session.

## Recommendation

Do the first step soon and the rest when there is a reason to.

The schema change is small, additive, reversible, and it is the piece that gets
more expensive to make later as application code accumulates around the current
shape. Making `app.active_company_id()` read both sources costs one migration
and commits you to nothing.

The rest is not urgent. The pooled path works and is tested, and rewriting
fourteen queries to remove an environment variable is not a good trade on its
own. It becomes a good trade the moment connection handling causes a production
problem, and at that point the groundwork will already be in place and the
migration can happen one page at a time instead of as an emergency.

Take the stored `app_metadata` version. The hook solves a problem this
application does not currently have, and it costs a grant into tenant tables
and an exception to the one guard rule that should never have exceptions.
