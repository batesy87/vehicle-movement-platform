-- ============================================================================
-- 0002 tenancy tables
--
-- The tenant root and the identity graph around it. Tables only: the policies
-- that guard them live in 0004, because they call helper functions that in
-- turn read these tables.
--
-- Every tenant-scoped table from here on carries a non-nullable `company_id`,
-- and every one of them gets both ENABLE and FORCE row level security. FORCE
-- matters: without it the table owner is exempt from its own policies, and on
-- a managed Postgres the owner is not a hypothetical.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- plans
--
-- Global reference data, not tenant-scoped. Readable by anyone including
-- signed-out visitors, because the pricing page renders from it. Only the
-- service role writes.
-- ----------------------------------------------------------------------------
create table public.plans (
  id                       uuid primary key default gen_random_uuid(),
  key                      text not null unique,
  name                     text not null,
  price_monthly            numeric(12, 2) not null check (price_monthly >= 0),
  -- null means unmetered.
  included_jobs_per_month  integer check (included_jobs_per_month is null or included_jobs_per_month > 0),
  -- null means overage is not permitted on this plan.
  overage_price_per_job    numeric(12, 2) check (overage_price_per_job is null or overage_price_per_job >= 0),
  features                 jsonb not null default '{}'::jsonb,
  is_public                boolean not null default true,
  sort_order               integer not null default 0,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.plans is
  'Subscription tiers. Feature flags live in `features` and are enforced server-side before any gated write.';

alter table public.plans enable row level security;
alter table public.plans force row level security;
revoke all on public.plans from public;
grant select on public.plans to anon, authenticated;
grant all on public.plans to service_role;

-- ----------------------------------------------------------------------------
-- companies (the tenant)
-- ----------------------------------------------------------------------------
create table public.companies (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (length(btrim(name)) > 0),
  trading_name           text,
  registration_number    text,
  billing_model          public.billing_model not null default 'subscription',
  plan_id                uuid not null references public.plans (id) on delete restrict,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  status                 public.company_status not null default 'trial',
  trial_ends_at          timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- A trial has to end at some point, otherwise the billing job has nothing
  -- to act on.
  constraint companies_trial_has_end check (status <> 'trial' or trial_ends_at is not null)
);

comment on table public.companies is
  'Transport companies who sign up and pay. The tenant root: every tenant-scoped table carries company_id referencing this.';

create index companies_plan_id_idx on public.companies (plan_id);
create index companies_status_idx on public.companies (status);

alter table public.companies enable row level security;
alter table public.companies force row level security;
revoke all on public.companies from public;
grant select, insert, update on public.companies to authenticated;
grant all on public.companies to service_role;

select app.add_touch_trigger('public.companies');
select app.add_touch_trigger('public.plans');

-- ----------------------------------------------------------------------------
-- company_users
--
-- Staff membership. A person may be staff at more than one company, which is
-- why this is a join table and not a column on a users table.
--
-- There is no 'invited' state here. An unaccepted invitation lives in
-- `invitations`; a row in this table means the person is in.
-- ----------------------------------------------------------------------------
create table public.company_users (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.company_role not null default 'dispatcher',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint company_users_unique_membership unique (company_id, user_id)
);

comment on table public.company_users is
  'Staff membership of a company. Drivers are NOT here; they link through driver_company_links.';

-- This index carries app.company_ids_for_current_user(), which runs on every
-- policy evaluation, so it earns its keep.
create index company_users_user_active_idx
  on public.company_users (user_id, company_id)
  where is_active;

create index company_users_company_id_idx on public.company_users (company_id);

-- A company must always have at least one owner, or nobody can administer it.
-- Enforced as a partial unique-free index plus a trigger in 0009; the index
-- here just makes the owner lookup cheap.
create index company_users_owner_idx
  on public.company_users (company_id)
  where role = 'owner' and is_active;

alter table public.company_users enable row level security;
alter table public.company_users force row level security;
revoke all on public.company_users from public;
grant select, insert, update, delete on public.company_users to authenticated;
grant all on public.company_users to service_role;

select app.add_touch_trigger('public.company_users');

-- ----------------------------------------------------------------------------
-- driver_profiles
--
-- Deliberately NOT tenant-scoped. Self-employed drivers work for several
-- transport companies, so driver identity sits above the tenant boundary:
-- one profile, one login, however many company links.
-- ----------------------------------------------------------------------------
create table public.driver_profiles (
  id                 uuid primary key default gen_random_uuid(),
  -- Null until the driver has actually created their account. A company can
  -- invite an email that has never signed in.
  auth_user_id       uuid unique references auth.users (id) on delete set null,
  name               text not null check (length(btrim(name)) > 0),
  email              text not null,
  phone              text,
  licence_number     text,
  licence_categories text[] not null default '{}',
  vehicle_capability public.vehicle_capability not null default 'car',
  -- False while the profile is a stub created by an inviting company.
  is_confirmed       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.driver_profiles is
  'Global driver identity, shared across tenants by design. A driver reads and writes only their own row; a company sees the rows of drivers who accepted a link to it.';

create unique index driver_profiles_email_key on public.driver_profiles (lower(email));

alter table public.driver_profiles enable row level security;
alter table public.driver_profiles force row level security;
revoke all on public.driver_profiles from public;
grant select, insert, update on public.driver_profiles to authenticated;
grant all on public.driver_profiles to service_role;

select app.add_touch_trigger('public.driver_profiles');

-- ----------------------------------------------------------------------------
-- driver_company_links
--
-- The consent gate. A company cannot see a driver's details, nor assign them
-- work, until the driver has accepted. Acceptance is all-or-nothing: there is
-- no field-level sharing, so the question put to the driver is really "do you
-- want to work for this company", not "which details may they see".
-- ----------------------------------------------------------------------------
create table public.driver_company_links (
  id                uuid primary key default gen_random_uuid(),
  driver_profile_id uuid not null references public.driver_profiles (id) on delete cascade,
  company_id        uuid not null references public.companies (id) on delete cascade,
  driver_type       public.driver_type not null default 'self_employed',
  status            public.driver_link_status not null default 'invited',
  invited_at        timestamptz not null default now(),
  accepted_at       timestamptz,
  pay_rate          numeric(12, 2) check (pay_rate is null or pay_rate >= 0),
  terms             text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint driver_company_links_unique unique (driver_profile_id, company_id),
  constraint driver_company_links_accepted_has_timestamp
    check (status <> 'active' or accepted_at is not null)
);

comment on table public.driver_company_links is
  'Joins a global driver to a company, with company-specific terms. status=active is the only state that grants the driver access to that company''s data.';

-- Mirror of company_users_user_active_idx: the other half of the membership
-- lookup that every policy performs.
create index driver_company_links_lookup_idx
  on public.driver_company_links (driver_profile_id, company_id)
  where status = 'active';

create index driver_company_links_company_idx on public.driver_company_links (company_id, status);

alter table public.driver_company_links enable row level security;
alter table public.driver_company_links force row level security;
revoke all on public.driver_company_links from public;
grant select, insert, update, delete on public.driver_company_links to authenticated;
grant all on public.driver_company_links to service_role;

select app.add_touch_trigger('public.driver_company_links');

-- ----------------------------------------------------------------------------
-- invitations
--
-- Covers all three invite paths: a staff member joining a company, a brand new
-- driver being asked to create an account, and an existing driver being asked
-- to consent to a link with another company.
--
-- Only a hash of the token is stored. The plaintext exists once, in the email.
-- ----------------------------------------------------------------------------
create table public.invitations (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  kind              public.invitation_kind not null,
  email             text not null,
  -- Set for kind = 'company_user'.
  role              public.company_role,
  -- Set for both driver kinds.
  driver_profile_id uuid references public.driver_profiles (id) on delete cascade,
  token_hash        text not null unique,
  status            public.invitation_status not null default 'pending',
  expires_at        timestamptz not null,
  invited_by        uuid references auth.users (id) on delete set null,
  accepted_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint invitations_role_matches_kind
    check ((kind = 'company_user') = (role is not null)),
  constraint invitations_driver_matches_kind
    check ((kind in ('driver_new', 'driver_link')) = (driver_profile_id is not null)),
  constraint invitations_owner_not_invitable
    check (role is null or role <> 'owner')
);

comment on table public.invitations is
  'Pending invitations for staff and drivers. Stores only a hash of the token; the plaintext lives solely in the email that was sent.';

create unique index invitations_one_pending_per_target
  on public.invitations (company_id, kind, lower(email))
  where status = 'pending';

create index invitations_email_pending_idx
  on public.invitations (lower(email))
  where status = 'pending';

create index invitations_company_idx on public.invitations (company_id, status);

alter table public.invitations enable row level security;
alter table public.invitations force row level security;
revoke all on public.invitations from public;
grant select, insert, update on public.invitations to authenticated;
grant all on public.invitations to service_role;

select app.add_touch_trigger('public.invitations');
