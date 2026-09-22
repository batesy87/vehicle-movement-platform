-- ============================================================================
-- 0009 operations that row level security cannot express
--
-- Three situations need a SECURITY DEFINER function rather than a policy.
--
-- 1. Company signup. A brand new user has no membership of anything, so RLS
--    correctly refuses to let them insert a company. The only policy that
--    would permit it is USING (true), which is exactly what this schema
--    refuses to contain.
-- 2. Accepting an invitation. The invitee usually cannot see the invitation
--    row, because they are not a member yet.
-- 3. Inviting a driver. The choice between creating a new profile and asking
--    an existing driver for consent has to be atomic, or two dispatchers
--    inviting the same person at once produce a duplicate profile.
--
-- Every one of these re-checks authorisation by hand, because SECURITY DEFINER
-- turns policies off. That check is the whole security of the function, so it
-- comes first in each body and is never conditional.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A company must keep at least one active owner, or nobody can administer it
-- and support has to intervene.
-- ----------------------------------------------------------------------------
create function app.protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  target_company uuid;
  remaining integer;
begin
  target_company := coalesce(old.company_id, new.company_id);

  -- Only relevant when an owner stops being an active owner.
  if tg_op = 'UPDATE'
     and old.role = 'owner' and old.is_active
     and new.role = 'owner' and new.is_active then
    return new;
  end if;

  if tg_op = 'UPDATE' and not (old.role = 'owner' and old.is_active) then
    return new;
  end if;

  if tg_op = 'DELETE' and not (old.role = 'owner' and old.is_active) then
    return old;
  end if;

  select count(*) into remaining
    from public.company_users cu
   where cu.company_id = target_company
     and cu.role = 'owner'
     and cu.is_active
     and cu.id <> old.id;

  if remaining = 0 then
    raise exception 'a company must always have at least one active owner'
      using errcode = 'check_violation';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end
$$;

create trigger protect_last_owner
  before update or delete on public.company_users
  for each row execute function app.protect_last_owner();

-- ----------------------------------------------------------------------------
-- Company signup
--
-- Creates the company and its first owner in one transaction, and starts the
-- trial. Public schema so PostgREST exposes it as an RPC.
-- ----------------------------------------------------------------------------
create function public.create_company(
  p_name                text,
  p_plan_key            text,
  p_trading_name        text default null,
  p_registration_number text default null,
  p_billing_model       public.billing_model default 'subscription',
  p_trial_days          integer default 14
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  caller       uuid := auth.uid();
  target_plan  uuid;
  new_company  uuid;
  owned_count  integer;
begin
  if caller is null then
    raise exception 'you must be signed in to create a company'
      using errcode = 'insufficient_privilege';
  end if;

  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'a company name is required' using errcode = 'check_violation';
  end if;

  if p_trial_days < 0 or p_trial_days > 90 then
    raise exception 'trial length must be between 0 and 90 days' using errcode = 'check_violation';
  end if;

  -- Without this, the RPC is a tenant sprayer: anyone with an account could
  -- create unbounded companies and the usage counters would be meaningless.
  select count(*) into owned_count
    from public.company_users cu
   where cu.user_id = caller and cu.role = 'owner' and cu.is_active;

  if owned_count >= 5 then
    raise exception 'this account already owns the maximum number of companies'
      using errcode = 'check_violation';
  end if;

  select id into target_plan from public.plans where key = p_plan_key and is_public;
  if target_plan is null then
    raise exception 'unknown plan %', p_plan_key using errcode = 'foreign_key_violation';
  end if;

  insert into public.companies (
    name, trading_name, registration_number, billing_model, plan_id, status, trial_ends_at
  )
  values (
    btrim(p_name),
    nullif(btrim(coalesce(p_trading_name, '')), ''),
    nullif(btrim(coalesce(p_registration_number, '')), ''),
    p_billing_model,
    target_plan,
    'trial',
    now() + make_interval(days => p_trial_days)
  )
  returning id into new_company;

  insert into public.company_users (company_id, user_id, role, is_active)
  values (new_company, caller, 'owner', true);

  insert into public.company_counters (company_id) values (new_company);

  return new_company;
end
$$;

revoke all on function public.create_company(text, text, text, text, public.billing_model, integer) from public;
grant execute on function public.create_company(text, text, text, text, public.billing_model, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- Driver invitation (spec section 4.0)
--
-- Two paths, chosen by whether a profile with that email already exists.
--
--   No match   -> create an unconfirmed profile plus an 'invited' link, and
--                 send an invite to create an account.
--   Match      -> do NOT auto-link. Create an 'invited' link only, and ask the
--                 existing driver to consent. That consent is the whole point:
--                 a driver's licence details and contact information become
--                 visible to a new company only because they agreed.
-- ----------------------------------------------------------------------------
create function public.invite_driver(
  p_company_id         uuid,
  p_email              text,
  p_token              text,
  p_name               text default null,
  p_phone              text default null,
  p_driver_type        public.driver_type default 'self_employed',
  p_vehicle_capability public.vehicle_capability default 'car',
  p_notes              text default null,
  p_expires_in_days    integer default 14
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  normalised_email text := lower(btrim(p_email));
  profile_id   uuid;
  profile_is_new boolean := false;
  link_id      uuid;
  invitation_id uuid;
begin
  -- SECURITY DEFINER disables policies, so authorisation is checked by hand.
  if not app.can_dispatch(p_company_id) then
    raise exception 'you do not have permission to invite drivers for this company'
      using errcode = 'insufficient_privilege';
  end if;

  if normalised_email is null or normalised_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'a valid email address is required' using errcode = 'check_violation';
  end if;

  if p_token is null or length(p_token) < 32 then
    raise exception 'invitation token is too short to be safe' using errcode = 'check_violation';
  end if;

  -- Serialise concurrent invitations of the same person, so two dispatchers
  -- clicking at once cannot create two profiles for one driver.
  perform pg_advisory_xact_lock(hashtextextended(normalised_email, 0));

  select id into profile_id from public.driver_profiles where lower(email) = normalised_email;

  if profile_id is null then
    insert into public.driver_profiles (name, email, phone, vehicle_capability, is_confirmed)
    values (
      coalesce(nullif(btrim(coalesce(p_name, '')), ''), split_part(normalised_email, '@', 1)),
      normalised_email,
      nullif(btrim(coalesce(p_phone, '')), ''),
      p_vehicle_capability,
      false
    )
    returning id into profile_id;
    profile_is_new := true;
  end if;

  insert into public.driver_company_links (
    driver_profile_id, company_id, driver_type, status, notes
  )
  values (profile_id, p_company_id, p_driver_type, 'invited', nullif(btrim(coalesce(p_notes, '')), ''))
  on conflict (driver_profile_id, company_id) do update
    set status = case
          -- Re-inviting someone who already accepted is a no-op, not a
          -- downgrade back to 'invited'.
          when public.driver_company_links.status = 'active' then 'active'::public.driver_link_status
          else 'invited'::public.driver_link_status
        end,
        driver_type = excluded.driver_type,
        invited_at = now(),
        updated_at = now()
  returning id into link_id;

  insert into public.invitations (
    company_id, kind, email, driver_profile_id, token_hash, status, expires_at, invited_by
  )
  values (
    p_company_id,
    -- Cast explicitly: a CASE over bare literals resolves to text, which will
    -- not implicitly coerce into an enum column.
    case
      when profile_is_new then 'driver_new'::public.invitation_kind
      else 'driver_link'::public.invitation_kind
    end,
    normalised_email,
    profile_id,
    encode(digest(p_token, 'sha256'), 'hex'),
    'pending',
    now() + make_interval(days => greatest(p_expires_in_days, 1)),
    auth.uid()
  )
  on conflict (company_id, kind, lower(email)) where status = 'pending'
  do update set token_hash = excluded.token_hash,
                expires_at = excluded.expires_at,
                updated_at = now()
  returning id into invitation_id;

  return jsonb_build_object(
    'path', case when profile_is_new then 'new_profile' else 'consent_requested' end,
    'driver_profile_id', profile_id,
    'link_id', link_id,
    'invitation_id', invitation_id
  );
end
$$;

revoke all on function public.invite_driver(uuid, text, text, text, text, public.driver_type, public.vehicle_capability, text, integer) from public;
grant execute on function public.invite_driver(uuid, text, text, text, text, public.driver_type, public.vehicle_capability, text, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- Claiming a driver profile
--
-- When an invited driver finally creates an account, their auth user has to be
-- attached to the stub profile the inviting company created. Matching is on the
-- email in their auth record, which Supabase has verified; a caller-supplied
-- email would let anyone claim anyone's profile.
-- ----------------------------------------------------------------------------
create function public.claim_driver_profile()
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  caller       uuid := auth.uid();
  caller_email text := app.current_user_email();
  profile_id   uuid;
begin
  if caller is null or caller_email is null then
    raise exception 'you must be signed in' using errcode = 'insufficient_privilege';
  end if;

  select id into profile_id from public.driver_profiles where auth_user_id = caller;
  if profile_id is not null then
    return profile_id;
  end if;

  select id into profile_id
    from public.driver_profiles
   where lower(email) = caller_email
     and auth_user_id is null
   for update;

  if profile_id is null then
    return null;
  end if;

  update public.driver_profiles
     set auth_user_id = caller, is_confirmed = true, updated_at = now()
   where id = profile_id;

  return profile_id;
end
$$;

revoke all on function public.claim_driver_profile() from public;
grant execute on function public.claim_driver_profile() to authenticated;

-- ----------------------------------------------------------------------------
-- Accepting an invitation
--
-- Takes the plaintext token from the emailed link and hashes it here, so the
-- hashing rule lives in exactly one place. Handles all three invitation kinds.
-- ----------------------------------------------------------------------------
create function public.accept_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  caller       uuid := auth.uid();
  caller_email text := app.current_user_email();
  inv          public.invitations%rowtype;
begin
  if caller is null or caller_email is null then
    raise exception 'you must be signed in to accept an invitation'
      using errcode = 'insufficient_privilege';
  end if;

  select * into inv
    from public.invitations
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
   for update;

  if not found then
    raise exception 'this invitation link is not valid' using errcode = 'no_data_found';
  end if;

  if inv.status <> 'pending' then
    raise exception 'this invitation has already been %', inv.status using errcode = 'check_violation';
  end if;

  if inv.expires_at <= now() then
    update public.invitations set status = 'expired', updated_at = now() where id = inv.id;
    raise exception 'this invitation has expired' using errcode = 'check_violation';
  end if;

  -- The token alone is not enough. It must have been sent to the address the
  -- accepting account actually owns, so a forwarded link cannot be redeemed by
  -- somebody else.
  if lower(inv.email) <> caller_email then
    raise exception 'this invitation was sent to a different email address'
      using errcode = 'insufficient_privilege';
  end if;

  if inv.kind = 'company_user' then
    insert into public.company_users (company_id, user_id, role, is_active)
    values (inv.company_id, caller, inv.role, true)
    on conflict (company_id, user_id)
      do update set is_active = true, role = excluded.role, updated_at = now();
  else
    -- Both driver paths converge here: attach the auth user to the profile if
    -- it is still a stub, then flip the link to active. This is the moment the
    -- company gains sight of the driver's details.
    update public.driver_profiles
       set auth_user_id = coalesce(auth_user_id, caller),
           is_confirmed = true,
           updated_at = now()
     where id = inv.driver_profile_id
       and (auth_user_id is null or auth_user_id = caller);

    if not found then
      raise exception 'this driver profile belongs to a different account'
        using errcode = 'insufficient_privilege';
    end if;

    update public.driver_company_links
       set status = 'active', accepted_at = now(), updated_at = now()
     where driver_profile_id = inv.driver_profile_id
       and company_id = inv.company_id;
  end if;

  update public.invitations
     set status = 'accepted', accepted_at = now(), updated_at = now()
   where id = inv.id;

  return jsonb_build_object('company_id', inv.company_id, 'kind', inv.kind);
end
$$;

revoke all on function public.accept_invitation(text) from public;
grant execute on function public.accept_invitation(text) to authenticated;

-- ----------------------------------------------------------------------------
-- Declining a driver link
--
-- The other half of consent. A driver who does not want to work for a company
-- must be able to say so, and the company must not keep an 'invited' link
-- hanging around implying otherwise.
-- ----------------------------------------------------------------------------
create function public.decline_invitation(p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  caller_email text := app.current_user_email();
  inv          public.invitations%rowtype;
begin
  if caller_email is null then
    raise exception 'you must be signed in' using errcode = 'insufficient_privilege';
  end if;

  select * into inv
    from public.invitations
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and status = 'pending'
   for update;

  if not found then
    raise exception 'this invitation link is not valid' using errcode = 'no_data_found';
  end if;

  if lower(inv.email) <> caller_email then
    raise exception 'this invitation was sent to a different email address'
      using errcode = 'insufficient_privilege';
  end if;

  update public.invitations set status = 'declined', updated_at = now() where id = inv.id;

  if inv.driver_profile_id is not null then
    update public.driver_company_links
       set status = 'declined', updated_at = now()
     where driver_profile_id = inv.driver_profile_id
       and company_id = inv.company_id
       and status = 'invited';
  end if;
end
$$;

revoke all on function public.decline_invitation(text) from public;
grant execute on function public.decline_invitation(text) to authenticated;

-- ----------------------------------------------------------------------------
-- Session introspection
--
-- What the app calls on load to find out which companies this session may act
-- for, so it can render a switcher and pick an active company.
-- ----------------------------------------------------------------------------
create function public.my_memberships()
returns table (
  company_id   uuid,
  company_name text,
  plan_key     text,
  status       public.company_status,
  staff_role   public.company_role,
  is_driver    boolean
)
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $$
  select c.id,
         c.name,
         p.key,
         c.status,
         app.company_role_of_current_user(c.id),
         app.is_driver_of(c.id)
    from public.companies c
    join public.plans p on p.id = c.plan_id
   where c.id = any (app.company_ids_for_current_user())
   order by c.name
$$;

revoke all on function public.my_memberships() from public;
grant execute on function public.my_memberships() to authenticated;
