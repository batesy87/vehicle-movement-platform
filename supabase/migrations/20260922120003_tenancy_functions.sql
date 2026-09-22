-- ============================================================================
-- 0003 tenancy functions
--
-- The whole tenant boundary reduces to these functions. Every policy in the
-- schema is written in terms of them, so there is one place to audit and one
-- place to get wrong.
--
-- Design note, and a deliberate departure from the spec.
--
-- The spec suggests reading a `company_id` claim out of the JWT. That does not
-- survive two facts. First, a self-employed driver works for several transport
-- companies at once, so a session spans a SET of companies rather than one.
-- Second, and more seriously, anything baked into a token goes stale: revoke a
-- driver's link and they keep reading that company's data until their token
-- expires, which could be an hour.
--
-- So membership is derived from the database on every query. The token supplies
-- only `auth.uid()`. Revocation takes effect on the very next statement.
--
-- The cost is a lookup per policy evaluation. It is mitigated two ways: the
-- functions are STABLE, so the planner may evaluate them once per statement
-- rather than once per row, and policies call them wrapped in a scalar
-- subquery -- `(select app.has_company(company_id))` -- which is what actually
-- persuades Postgres to hoist the call out of the row loop. Both membership
-- tables carry a partial index covering exactly this lookup.
--
-- All of these are SECURITY DEFINER with a pinned search_path. They read the
-- membership tables directly, so they must not themselves be subject to the
-- calling user's policies, which would be circular.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Membership
-- ----------------------------------------------------------------------------

create function app.company_ids_for_current_user()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(array_agg(distinct company_id), '{}'::uuid[])
  from (
    select cu.company_id
      from public.company_users cu
     where cu.user_id = auth.uid()
       and cu.is_active

    union

    select dcl.company_id
      from public.driver_company_links dcl
      join public.driver_profiles dp on dp.id = dcl.driver_profile_id
     where dp.auth_user_id = auth.uid()
       and dcl.status = 'active'
  ) memberships
$$;

comment on function app.company_ids_for_current_user() is
  'Every company the current session may read, derived live from staff membership and accepted driver links. Never cached in a token.';

create function app.has_company(target uuid)
returns boolean
language sql
stable
as $$
  select target is not null
     and target = any (app.company_ids_for_current_user())
$$;

comment on function app.has_company(uuid) is
  'Read predicate. Use as (select app.has_company(company_id)) inside a policy so the planner hoists it.';

-- ----------------------------------------------------------------------------
-- The active company
--
-- Reads a request-scoped setting the server applies after validating it against
-- the membership set. A user who works for two operators must say which one
-- they are acting as before they may write anything, otherwise a mistyped
-- dispatcher action lands in the wrong tenant's books.
--
-- Unset means no writes at all. That is intentional: fail closed.
-- ----------------------------------------------------------------------------

create function app.active_company_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.active_company_id', true), '')::uuid
$$;

create function app.can_write_company(target uuid)
returns boolean
language sql
stable
as $$
  select target is not null
     and app.active_company_id() = target
     and app.has_company(target)
$$;

comment on function app.can_write_company(uuid) is
  'Write predicate. Requires BOTH an explicitly chosen active company and real membership of it. With no active company set, nothing is writable.';

-- ----------------------------------------------------------------------------
-- Staff roles
-- ----------------------------------------------------------------------------

create function app.company_role_of_current_user(target uuid)
returns public.company_role
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select cu.role
    from public.company_users cu
   where cu.user_id = auth.uid()
     and cu.company_id = target
     and cu.is_active
   limit 1
$$;

create function app.is_staff(target uuid)
returns boolean
language sql
stable
as $$
  select app.company_role_of_current_user(target) is not null
$$;

create function app.has_company_role(target uuid, minimum public.company_role)
returns boolean
language sql
stable
as $$
  -- coalesce is load-bearing. For a non-member, company_role_of_current_user
  -- returns NULL, role_rank(NULL) is NULL, and the comparison is NULL rather
  -- than false. A policy treats NULL as false and is therefore safe, but
  -- plpgsql does not: `if not <null> then raise` never fires, so a
  -- SECURITY DEFINER function guarding itself with this would skip its own
  -- authorisation check and carry on. Return a real boolean, always.
  select coalesce(
    app.role_rank(app.company_role_of_current_user(target)) >= app.role_rank(minimum),
    false
  )
$$;

comment on function app.has_company_role(uuid, public.company_role) is
  'True when the caller is staff at the company with at least the given role. Drivers always get false: they are not staff. Never returns NULL.';

-- Convenience predicates used throughout the policies. Named for what they
-- authorise rather than for the role, so the policies read as intent.
create function app.can_manage_company(target uuid)
returns boolean
language sql
stable
as $$
  select app.has_company_role(target, 'admin')
$$;

create function app.can_dispatch(target uuid)
returns boolean
language sql
stable
as $$
  select app.has_company_role(target, 'dispatcher')
$$;

-- ----------------------------------------------------------------------------
-- Driver identity
-- ----------------------------------------------------------------------------

-- `auth.users` is not readable by tenant sessions on Supabase, so anything that
-- needs the caller's email address has to go through a definer.
create function app.current_user_email()
returns text
language sql
stable
security definer
set search_path = auth, pg_catalog
as $$
  select lower(u.email) from auth.users u where u.id = auth.uid()
$$;

create function app.current_driver_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select dp.id
    from public.driver_profiles dp
   where dp.auth_user_id = auth.uid()
   limit 1
$$;

create function app.is_driver_of(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
      from public.driver_company_links dcl
     where dcl.company_id = target
       and dcl.driver_profile_id = app.current_driver_profile_id()
       and dcl.status = 'active'
  )
$$;

-- `app.owns_leg(uuid)`, the predicate behind "a driver may only record custody
-- of a vehicle they were actually given", is defined in 0006 alongside the
-- `legs` table it reads. Postgres validates SQL function bodies at creation
-- time, so it cannot be declared here.

-- Execution rights. Tenant sessions call these constantly; nobody may create
-- anything in `app`. Default privileges in 0001 cover functions added by
-- later migrations; this grant covers the ones above.
grant execute on all functions in schema app to authenticated, service_role;
