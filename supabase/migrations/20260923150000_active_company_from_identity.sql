-- ============================================================================
-- 0013 let the active company come from identity as well as from the session
--
-- The tenant rule has two halves and, until now, they have been expressed in
-- different currencies.
--
-- Membership is a property of identity: app.has_company() resolves auth.uid()
-- against company_users and driver_company_links, so any caller presenting a
-- token gets the same answer, and revoking a link takes effect on the next
-- statement whoever is asking.
--
-- The active company has been a property of the connection: a GUC set by
-- withTenantSession inside a transaction it owns. That works, and it fails
-- closed, but it means half the tenant rule can only be satisfied by a caller
-- holding a server-side Postgres session. Any other caller, a mobile client
-- doing offline capture, an edge function, a background worker, a second
-- service, either reimplements that transport or silently cannot write.
--
-- Welding a security rule to a transport is the part that ages badly. This
-- migration makes the active company a property of identity too, so the whole
-- rule can be evaluated for any caller, and leaves the GUC in place as a
-- deliberate server-side override.
--
-- This is the intended end state rather than a step towards removing one of
-- the two sources. Both are meant:
--
--   the GUC   is an override, available only over a direct connection, which
--             only our own server holds. It is how a job, a support tool or an
--             impersonating process pins the company it is acting for.
--   the claim is the default, carried in the access token, written only by the
--             admin API, and read by whatever client presents it.
--
-- Neither is trusted on its own. can_write_company() is unchanged and still
-- reads `active = target AND app.has_company(target)`, so a claim can name a
-- company and can never make anyone a member of one. That is the distinction
-- docs/tenancy.md draws between carrying membership in a token, which goes
-- stale and breaks revocation, and carrying a selection, which cannot.
--
-- Note what this does NOT change: no policy, no table, no grant. The boundary
-- is the same boundary. It is now expressible to more than one kind of caller.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- auth.jwt() for the bare-Postgres shim
--
-- Supabase provides this. A plain Postgres running the test suite does not, and
-- app.active_company_id() is about to depend on it. Same guarded shape as the
-- auth.uid() and auth.role() shims in 0001, and for the same reason: on a real
-- project the auth schema belongs to supabase_admin and creating anything in it
-- is refused, so the existence check has to come first.
--
-- Returns an empty object rather than NULL when nothing is set, so callers can
-- use -> and ->> without guarding every one of them.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'jwt'
  ) then
    execute $fn$
      create function auth.jwt() returns jsonb
      language sql
      stable
      as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claims', true), '')::jsonb,
          '{}'::jsonb
        )
      $body$;
    $fn$;
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- app.active_company_id()
--
-- The GUC first, because an override that loses to the thing it is overriding
-- is not an override.
--
-- `app_metadata` is the right half of the token for this. Supabase describes it
-- as the field the user cannot write, it is already carried in the access
-- token, and it is set through the admin API with the service role key. A
-- custom access token hook would also work and is not needed, since nothing
-- here has to be computed at the moment a token is issued.
--
-- The two sources do not currently meet. withTenantSession builds
-- `request.jwt.claims` itself, as {sub, role}, so there is no app_metadata in
-- the pooled path to fall through to. Worth knowing before changing that
-- function to pass a real token through: at that point a call that means
-- "no override" would start inheriting the user's own selection, which is
-- defensible but would no longer be what the call site said.
--
-- The search_path clause is not optional. 0012 pinned it on this function and
-- schema-guard asserts it; CREATE OR REPLACE discards settings that are not
-- restated, so leaving it off here would silently unpin it and fail the build.
-- ----------------------------------------------------------------------------
create or replace function app.active_company_id()
returns uuid
language sql
stable
set search_path = public, pg_catalog
as $$
  select coalesce(
    nullif(current_setting('app.active_company_id', true), '')::uuid,
    nullif(auth.jwt() -> 'app_metadata' ->> 'active_company_id', '')::uuid
  )
$$;

comment on function app.active_company_id() is
  'The company this request is acting for. A server-side override (the app.active_company_id setting) if one is present, otherwise the selection carried in the access token. Names a company; grants nothing. app.has_company() still has to agree.';
