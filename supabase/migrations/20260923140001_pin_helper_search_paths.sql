-- ============================================================================
-- 0012 pin search_path on the remaining app helpers
--
-- 0003 pins search_path on every SECURITY DEFINER function, and the schema
-- guard asserts it. These ten are SECURITY INVOKER, so they fell outside both,
-- and Supabase's database linter flags them as `function_search_path_mutable`.
--
-- For an ordinary invoker function that warning is mild: the function runs as
-- the caller, so a hijacked name resolves to something the caller could have
-- reached anyway and no privilege is crossed. These are not ordinary. They are
-- the predicates every row level security policy in this schema is built from,
-- so the question is not whether a caller gains privileges they lacked, it is
-- whether a caller can change the answer `app.has_company()` gives about them.
-- Making that predicate return true for a company someone does not belong to
-- is the tenant boundary failing, whatever the privilege system thinks.
--
-- The bodies already schema-qualify every table and function they touch, so
-- the exposure is narrow: operator and cast resolution, where a user-defined
-- operator with an exact type match can be preferred over the built-in. Making
-- that reachable needs a schema the caller can create objects in, and on this
-- project neither anon nor authenticated can create in public, app, extensions
-- or auth, nor hold createdb, createrole or superuser. So this is hardening
-- against a path that is currently closed by something else, which is the
-- reason to close it here too rather than the reason to skip it. The tenant
-- boundary should not rest on a grant somewhere else staying correct.
--
-- Done with ALTER FUNCTION rather than CREATE OR REPLACE deliberately: the
-- bodies are load-bearing and there is no reason to retype them to add a
-- clause that attaches from outside.
--
-- One real cost, stated rather than buried. A SQL function carrying a SET
-- clause cannot be inlined by the planner, so `app.has_company(company_id)`
-- becomes a per-row function call inside policies that previously could be
-- folded into the surrounding query. At current scale that is not measurable,
-- and `app.company_ids_for_current_user()` is already uninlinable for the same
-- reason, being SECURITY DEFINER with a pinned path. If policy evaluation ever
-- shows up in a query plan, the fix is to cache the membership set per
-- transaction rather than to unpin these.
-- ============================================================================

alter function app.active_company_id() set search_path = public, pg_catalog;
alter function app.add_touch_trigger(target regclass) set search_path = public, pg_catalog;
alter function app.can_dispatch(target uuid) set search_path = public, pg_catalog;
alter function app.can_manage_company(target uuid) set search_path = public, pg_catalog;
alter function app.can_write_company(target uuid) set search_path = public, pg_catalog;
alter function app.has_company(target uuid) set search_path = public, pg_catalog;
alter function app.has_company_role(target uuid, minimum public.company_role) set search_path = public, pg_catalog;
alter function app.is_staff(target uuid) set search_path = public, pg_catalog;
alter function app.role_rank(r public.company_role) set search_path = public, pg_catalog;
alter function app.touch_updated_at() set search_path = public, pg_catalog;
