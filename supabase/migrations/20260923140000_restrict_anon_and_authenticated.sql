-- ============================================================================
-- 0011 restrict anon and authenticated to the privileges we actually meant
--
-- Every earlier migration says, per table, `revoke all ... from public` and
-- then grants what that table needs. On a bare Postgres that is the whole
-- story and the result is exactly the intended matrix. On Supabase it is not,
-- and the difference is not visible in any of those files.
--
-- Supabase ships default privileges, attached to both `postgres` and
-- `supabase_admin`, of the form
--
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated, service_role;
--
-- so every table these migrations create is born with `arwdDxtm` granted to
-- anon and to authenticated: insert, select, update, delete, truncate,
-- references, trigger, maintain. `revoke all ... from public` does not touch
-- that, because PUBLIC and anon are different grantees. The per-table grants
-- that follow are therefore purely additive and narrow nothing. The schema
-- guard did not catch it either, because it asserted against SECURITY DEFINER
-- functions rather than tables, and because a bare Postgres has no such
-- defaults, so CI was always looking at a database where the problem could not
-- occur.
--
-- Most of the excess is contained by row level security: anon matches no
-- policy at all, since every policy in this schema is `to authenticated`, and
-- authenticated is held to the same policies whatever the table grant says.
--
-- TRUNCATE is the exception, and it is why this migration is not cosmetic.
-- TRUNCATE is not subject to row level security. A role holding it can empty
-- a table regardless of any policy on it, which quietly undoes the
-- append-only guarantee that audit_log, custody_events, media_objects and
-- leg_location_points are supposed to carry. Those tables have no delete
-- policy precisely so that evidence survives a dispute; a truncate grant
-- makes that promise unenforceable. It is not reachable through PostgREST,
-- which exposes no TRUNCATE verb, but `withTenantSession` runs application
-- SQL as `authenticated` in a real Postgres session, where it very much is.
--
-- So: revoke the lot and restate the grants explicitly. The list below is the
-- same one the earlier migrations declare, gathered in one place. anon keeps
-- read access to `plans` alone, which is the pre-signup pricing page and has
-- a policy `to anon, authenticated` to match.
-- ============================================================================

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon;

-- Reference data, readable before anyone has an account.
grant select on public.plans to anon, authenticated;

-- Read-only to the application: maintained by triggers, not by callers.
grant select on public.company_counters to authenticated;
grant select on public.usage_counters to authenticated;

-- Append-only. No delete, no update: these are what a dispute turns on.
grant select, insert on public.audit_log to authenticated;
grant select, insert on public.leg_location_points to authenticated;

-- Correctable but not removable.
grant select, insert, update on public.custody_events to authenticated;
grant select, insert, update on public.driver_profiles to authenticated;
grant select, insert, update on public.invitations to authenticated;
grant select, insert, update on public.invoices to authenticated;

-- Two corrections, not transcriptions. The earlier migrations grant a
-- privilege here that no policy has ever permitted, so restating them as they
-- were would have carried the mistake forward.
--
-- `companies` was granted INSERT with no insert policy to match. A company row
-- is only ever created inside public.create_company(), which is SECURITY
-- DEFINER and runs as the owner, so the grant was unreachable: a direct insert
-- by a caller was refused by row level security regardless. Dropping it makes
-- the grant say what was always true, which is that signup is the only way in.
--
-- `media_objects` was granted UPDATE with no update policy. It holds
-- proof-of-collection and proof-of-delivery photos and signatures, and it sits
-- with the other evidence tables that deliberately have no delete policy. A
-- write privilege that contradicts that intent is worth removing even while
-- row level security is already refusing it.
grant select, update on public.companies to authenticated;
grant select, insert on public.media_objects to authenticated;

-- Ordinary operational data.
grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.company_users to authenticated;
grant select, insert, update, delete on public.condition_findings to authenticated;
grant select, insert, update, delete on public.consignment_vehicles to authenticated;
grant select, insert, update, delete on public.consignments to authenticated;
grant select, insert, update, delete on public.driver_company_links to authenticated;
grant select, insert, update, delete on public.invoice_lines to authenticated;
grant select, insert, update, delete on public.legs to authenticated;
grant select, insert, update, delete on public.locations to authenticated;
grant select, insert, update, delete on public.rate_card_bands to authenticated;
grant select, insert, update, delete on public.rate_cards to authenticated;
grant select, insert, update, delete on public.trip_stops to authenticated;
grant select, insert, update, delete on public.trips to authenticated;
grant select, insert, update, delete on public.vehicles to authenticated;

-- ----------------------------------------------------------------------------
-- Functions
--
-- The six RPCs in 0009 each revoke from PUBLIC and grant execute to
-- authenticated, which on Supabase left the default-privilege grant to anon in
-- place. They are SECURITY DEFINER, so an anon caller reaching one runs it as
-- the owner; they do check auth.uid() and fail closed on a null, but a
-- definer function callable by an unauthenticated role is the wrong shape
-- regardless of how carefully its body is written.
-- ----------------------------------------------------------------------------
revoke all on all routines in schema public from anon;

-- ----------------------------------------------------------------------------
-- Stop it coming back
--
-- Without this, the next table any migration creates is granted to anon and
-- authenticated all over again and we are back where we started. Only the
-- defaults attached to `postgres` are changed, because that is the role these
-- migrations run as and therefore the one whose defaults apply to objects they
-- create. The `supabase_admin` set is left alone: it belongs to the platform,
-- it is not ours to rewrite, and nothing here is created by that role.
--
-- The cost is that a table added later has no grants until its migration says
-- so, and will read as "permission denied" rather than as an empty result.
-- That is the intended direction. Every other table in this schema states its
-- grants in the migration that creates it, and now that statement is the whole
-- truth rather than an addition to whatever the platform decided.
--
-- This also means the Supabase dashboard's table editor will produce tables
-- the PostgREST API cannot read. That is correct for this project: the
-- application reaches Postgres through a pooled connection and
-- `set local role authenticated`, never through PostgREST, because a REST call
-- cannot hold `app.active_company_id` across statements.
-- ----------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon;
