-- ============================================================================
-- 0001 foundation
--
-- Extensions, the private `app` schema, a local shim for the pieces of
-- Supabase's `auth` schema the policies depend on, and every enum in the
-- domain.
--
-- Everything here is written so the file is safe to run against both a bare
-- Postgres (local development and CI) and a real Supabase project, where the
-- auth schema, its roles and its functions already exist and must not be
-- clobbered.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Roles
--
-- Supabase provisions these. Locally we create them so the same policies and
-- the same test harness run unchanged. They come first because everything
-- below grants to them.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- bypassrls is what makes this the support/ops escape hatch. It is never
    -- handed to a browser: server-side code only, and only in the narrow
    -- places that genuinely need to cross the tenant boundary.
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- Supabase keeps extensions in their own schema rather than in `public`.
-- Installing pgcrypto there too means `digest()` resolves identically on a
-- managed project and on a bare local Postgres, so the SECURITY DEFINER
-- functions can pin one search_path that works in both. On a project that
-- already has it, IF NOT EXISTS makes this a no-op and leaves it where it is.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- Stated explicitly rather than relied upon. A freshly created `public` schema
-- carries no grants, so a database rebuilt by `migrate --reset` would otherwise
-- deny every tenant session at the schema level before any policy ran. Table
-- rights are still granted one at a time; this is only the right to look.
grant usage on schema public to anon, authenticated, service_role;

-- Private namespace for tenancy helpers. Nothing in here is exposed through
-- PostgREST: the API only ever sees `public`.
create schema if not exists app;

-- ----------------------------------------------------------------------------
-- auth shim
--
-- Created only when absent, so a real Supabase project keeps its own.
-- ----------------------------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute $fn$
      create function auth.uid() returns uuid
      language sql
      stable
      as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        )::uuid
      $body$;
    $fn$;
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'role'
  ) then
    execute $fn$
      create function auth.role() returns text
      language sql
      stable
      as $body$
        select coalesce(
          nullif(current_setting('request.jwt.claim.role', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
        )
      $body$;
    $fn$;
  end if;
end
$$;

grant usage on schema auth to anon, authenticated, service_role;

-- `app` helpers are executable by tenant sessions, but the schema's contents
-- are not creatable by them.
grant usage on schema app to anon, authenticated, service_role;

-- Every helper added by a later migration is executable by tenant sessions
-- without needing its own grant. Policies call them on every row, so a missing
-- grant would surface as a permission error rather than as a quiet leak, but
-- it is still better not to rely on remembering.
alter default privileges in schema app grant execute on functions to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Enums
--
-- Mirrored in packages/shared/src/enums.ts. The enum parity test walks both
-- and fails on drift, so neither side can change alone.
-- ----------------------------------------------------------------------------

create type public.company_status as enum ('trial', 'active', 'past_due', 'cancelled');
create type public.billing_model as enum ('subscription', 'payg', 'hybrid');
create type public.company_role as enum ('owner', 'admin', 'dispatcher', 'viewer');

create type public.driver_link_status as enum ('invited', 'active', 'inactive', 'declined');
create type public.driver_type as enum ('employed', 'self_employed');
create type public.vehicle_capability as enum ('car', 'flatbed', 'hgv_trailer');

create type public.invitation_kind as enum ('company_user', 'driver_new', 'driver_link');
create type public.invitation_status as enum ('pending', 'accepted', 'declined', 'revoked', 'expired');

create type public.consignment_status as enum (
  'draft', 'scheduled', 'in_progress', 'completed', 'invoiced', 'cancelled'
);
create type public.pickup_mode as enum ('single', 'multi');
create type public.billing_status as enum ('pending', 'invoiced', 'paid', 'disputed');

create type public.consignment_vehicle_status as enum (
  'awaiting_collection', 'in_transit', 'at_handover', 'delivered', 'cancelled'
);
create type public.leg_status as enum (
  'unassigned', 'assigned', 'collected', 'in_transit', 'delivered', 'handed_over', 'cancelled'
);
create type public.trip_status as enum ('planned', 'in_progress', 'completed', 'cancelled');
create type public.stop_kind as enum ('collection', 'delivery');
create type public.custody_event_type as enum ('collection', 'delivery');

create type public.location_kind as enum ('pickup', 'dropoff', 'depot', 'other');
create type public.rate_basis as enum ('flat', 'per_mile', 'per_vehicle', 'banded');
create type public.invoice_status as enum ('draft', 'issued', 'paid', 'void', 'disputed');
create type public.media_kind as enum ('photo', 'signature', 'document');
create type public.audit_action as enum ('insert', 'update', 'delete');

-- ----------------------------------------------------------------------------
-- Small shared utilities
-- ----------------------------------------------------------------------------

-- Ordering for "at least this role" checks.
create function app.role_rank(r public.company_role)
returns integer
language sql
immutable
parallel safe
as $$
  select case r
    when 'viewer'     then 10
    when 'dispatcher' then 20
    when 'admin'      then 30
    when 'owner'      then 40
  end
$$;

create function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Applied to every table that has an updated_at column.
create function app.add_touch_trigger(target regclass)
returns void
language plpgsql
as $$
begin
  execute format(
    'create trigger touch_updated_at before update on %s
       for each row execute function app.touch_updated_at()',
    target
  );
end
$$;
