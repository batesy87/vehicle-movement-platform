-- ============================================================================
-- 0005 operational reference data
--
-- Clients, saved locations, vehicles and rate cards. From here on, each table's
-- policies sit directly beneath it.
--
-- Note the composite unique constraints of the form `unique (id, company_id)`.
-- They look redundant next to a primary key on `id`, and they are not: they are
-- the targets that child tables reference, so a child row cannot point at a
-- parent belonging to a different tenant. Row level security stops you reading
-- across the boundary; these stop you building a graph across it in the first
-- place, even when the application code is wrong. It is the cheapest insurance
-- in the schema.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- clients
--
-- The companies a transport company moves vehicles for. This is who gets
-- invoiced for a consignment.
-- ----------------------------------------------------------------------------
create table public.clients (
  id                   uuid not null default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete cascade,
  name                 text not null check (length(btrim(name)) > 0),
  contact_name         text,
  email                text,
  phone                text,
  billing_address      jsonb,
  default_rate_card_id uuid,
  is_active            boolean not null default true,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint clients_pkey primary key (id),
  constraint clients_id_company_key unique (id, company_id)
);

comment on table public.clients is
  'A transport company''s customers. Billed per consignment.';

create index clients_company_idx on public.clients (company_id) where is_active;
create unique index clients_company_name_key on public.clients (company_id, lower(name));

alter table public.clients enable row level security;
alter table public.clients force row level security;
revoke all on public.clients from public;
grant select, insert, update, delete on public.clients to authenticated;
grant all on public.clients to service_role;
select app.add_touch_trigger('public.clients');

create policy clients_select on public.clients
  for select to authenticated
  using ((select app.has_company(company_id)));

create policy clients_insert on public.clients
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy clients_update on public.clients
  for update to authenticated
  using ((select app.can_dispatch(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy clients_delete on public.clients
  for delete to authenticated
  using ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

-- ----------------------------------------------------------------------------
-- locations
--
-- Reusable addresses. The `kind` discriminator includes 'depot', which settles
-- an open question from the spec: a handover point is just a location whose
-- kind is depot. A leg may reference a saved location or carry a one-off
-- address inline, so a dispatcher is never forced to create a depot record
-- merely to type an address they will use once.
-- ----------------------------------------------------------------------------
create table public.locations (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  name          text not null check (length(btrim(name)) > 0),
  kind          public.location_kind not null default 'other',
  address       jsonb not null,
  latitude      numeric(9, 6) check (latitude is null or latitude between -90 and 90),
  longitude     numeric(9, 6) check (longitude is null or longitude between -180 and 180),
  contact_name  text,
  contact_phone text,
  notes         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint locations_pkey primary key (id),
  constraint locations_id_company_key unique (id, company_id)
);

comment on column public.locations.kind is
  'A depot is a location, not a separate entity. Legs may also carry a one-off address with no location row at all.';

create index locations_company_idx on public.locations (company_id) where is_active;
create index locations_company_kind_idx on public.locations (company_id, kind) where is_active;

alter table public.locations enable row level security;
alter table public.locations force row level security;
revoke all on public.locations from public;
grant select, insert, update, delete on public.locations to authenticated;
grant all on public.locations to service_role;
select app.add_touch_trigger('public.locations');

-- Drivers need to read locations: a depot address is where they are going.
create policy locations_select on public.locations
  for select to authenticated
  using ((select app.has_company(company_id)));

create policy locations_insert on public.locations
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy locations_update on public.locations
  for update to authenticated
  using ((select app.can_dispatch(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy locations_delete on public.locations
  for delete to authenticated
  using ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

-- ----------------------------------------------------------------------------
-- vehicles
--
-- A departure from the spec, flagged as such.
--
-- The spec puts registration and VIN inline on consignment_vehicles, which is
-- what the legacy system did: the same car moved twice produced two unrelated
-- records and there was no way to ask what has happened to a given vehicle.
-- Giving a vehicle its own identity costs one table now and is expensive to
-- retrofit later, and vehicle movement history is a straightforward thing to
-- sell.
--
-- The link is optional. A consignment_vehicle can still carry its own
-- registration for a one-off movement without polluting the fleet list.
-- ----------------------------------------------------------------------------
create table public.vehicles (
  id           uuid not null default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  -- Stored uppercase with spaces removed, so 'AB12 CDE' and 'AB12CDE' are the
  -- same vehicle. The legacy build uppercased but kept spaces, so they were not.
  registration text check (registration is null or registration ~ '^[A-Z0-9]{2,16}$'),
  vin          text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  make         text,
  model        text,
  colour       text,
  body_type    text not null default 'car',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint vehicles_pkey primary key (id),
  constraint vehicles_id_company_key unique (id, company_id),
  constraint vehicles_identifiable check (registration is not null or vin is not null)
);

create unique index vehicles_company_registration_key
  on public.vehicles (company_id, registration) where registration is not null;
create unique index vehicles_company_vin_key
  on public.vehicles (company_id, vin) where vin is not null;

alter table public.vehicles enable row level security;
alter table public.vehicles force row level security;
revoke all on public.vehicles from public;
grant select, insert, update, delete on public.vehicles to authenticated;
grant all on public.vehicles to service_role;
select app.add_touch_trigger('public.vehicles');

create policy vehicles_select on public.vehicles
  for select to authenticated
  using ((select app.has_company(company_id)));

create policy vehicles_insert on public.vehicles
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy vehicles_update on public.vehicles
  for update to authenticated
  using ((select app.can_dispatch(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy vehicles_delete on public.vehicles
  for delete to authenticated
  using ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

-- ----------------------------------------------------------------------------
-- rate_cards and rate_card_bands
--
-- The spec leaves rate card complexity open: flat per job, per mile, per
-- vehicle, or something custom. The legacy system answered it with banded
-- pricing, where each band charges a flat fee plus a per-mile rate for the
-- portion of the distance falling inside it. That expresses flat, per-mile and
-- tapered pricing as special cases of one model, and it ran at volume for
-- years, so it is adopted here rather than reinvented.
-- ----------------------------------------------------------------------------
create table public.rate_cards (
  id                 uuid not null default gen_random_uuid(),
  company_id         uuid not null references public.companies (id) on delete cascade,
  name               text not null check (length(btrim(name)) > 0),
  basis              public.rate_basis not null default 'banded',
  flat_amount        numeric(12, 2) check (flat_amount is null or flat_amount >= 0),
  per_mile_amount    numeric(12, 4) check (per_mile_amount is null or per_mile_amount >= 0),
  per_vehicle_amount numeric(12, 2) check (per_vehicle_amount is null or per_vehicle_amount >= 0),
  is_default         boolean not null default false,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint rate_cards_pkey primary key (id),
  constraint rate_cards_id_company_key unique (id, company_id),
  constraint rate_cards_basis_has_amount check (
    case basis
      when 'flat'        then flat_amount is not null
      when 'per_mile'    then per_mile_amount is not null
      when 'per_vehicle' then per_vehicle_amount is not null
      when 'banded'      then true
    end
  )
);

create unique index rate_cards_company_name_key on public.rate_cards (company_id, lower(name));
create unique index rate_cards_one_default_per_company
  on public.rate_cards (company_id) where is_default and is_active;

create table public.rate_card_bands (
  id           uuid not null default gen_random_uuid(),
  rate_card_id uuid not null,
  company_id   uuid not null references public.companies (id) on delete cascade,
  range_from   integer not null check (range_from >= 0),
  range_to     integer not null check (range_to > 0),
  value_flat   numeric(12, 2) not null default 0 check (value_flat >= 0),
  value_per    numeric(12, 4) not null default 0 check (value_per >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint rate_card_bands_pkey primary key (id),
  constraint rate_card_bands_range_ordered check (range_to > range_from),
  -- The composite reference is the point: a band cannot attach to another
  -- tenant's rate card even if the application hands it a foreign id.
  constraint rate_card_bands_card_fkey
    foreign key (rate_card_id, company_id)
    references public.rate_cards (id, company_id) on delete cascade,
  constraint rate_card_bands_unique_start unique (rate_card_id, range_from)
);

create index rate_card_bands_card_idx on public.rate_card_bands (rate_card_id, range_from);

alter table public.rate_cards enable row level security;
alter table public.rate_cards force row level security;
alter table public.rate_card_bands enable row level security;
alter table public.rate_card_bands force row level security;
revoke all on public.rate_cards from public;
revoke all on public.rate_card_bands from public;
grant select, insert, update, delete on public.rate_cards to authenticated;
grant select, insert, update, delete on public.rate_card_bands to authenticated;
grant all on public.rate_cards to service_role;
grant all on public.rate_card_bands to service_role;
select app.add_touch_trigger('public.rate_cards');
select app.add_touch_trigger('public.rate_card_bands');

-- Pricing is commercially sensitive, so unlike locations this is staff-only:
-- a driver linked to the company must not be able to read what the client is
-- being charged.
create policy rate_cards_select on public.rate_cards
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy rate_cards_insert on public.rate_cards
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

create policy rate_cards_update on public.rate_cards
  for update to authenticated
  using ((select app.can_manage_company(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

create policy rate_cards_delete on public.rate_cards
  for delete to authenticated
  using ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

create policy rate_card_bands_select on public.rate_card_bands
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy rate_card_bands_insert on public.rate_card_bands
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

create policy rate_card_bands_update on public.rate_card_bands
  for update to authenticated
  using ((select app.can_manage_company(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

create policy rate_card_bands_delete on public.rate_card_bands
  for delete to authenticated
  using ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

-- Deferred until rate_cards exists.
--
-- RESTRICT rather than SET NULL: a composite SET NULL would null out company_id
-- too, which is NOT NULL. Refusing to delete a rate card that a client still
-- points at is also the better behaviour, since silently repricing a client is
-- worse than an error message.
alter table public.clients
  add constraint clients_default_rate_card_fkey
  foreign key (default_rate_card_id, company_id)
  references public.rate_cards (id, company_id) on delete restrict;
