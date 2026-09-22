-- ============================================================================
-- 0006 the movement engine
--
-- The four-level hierarchy the whole product is built around:
--
--   consignment            what the client ordered, and what gets invoiced
--     └── vehicle(s)       one or more cars moved under that order
--           └── leg(s)     one driver, one custody segment, A to B
--   trip                   one driver's physical outing, grouping legs
--
-- A leg is the unit of custody. Splitting a vehicle's journey across two legs
-- is what makes a mid-journey handover expressible, which the legacy system
-- could not do: it bolted a second driver onto the job with sixty ts_-prefixed
-- columns and a parallel status field, and every query had to be written twice.
-- One legs table with a sequence collapses all of that.
--
-- Ordering note. Policies normally sit directly beneath their table. Three
-- driver-visibility predicates read `legs`, and Postgres validates SQL function
-- bodies at creation time, so those functions and the four policies that use
-- them are gathered at the end of the file, after `legs` exists.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- consignments
-- ----------------------------------------------------------------------------
create table public.consignments (
  id               uuid not null default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  client_id        uuid not null,
  -- Per-tenant, human-facing sequence. The legacy build had a single global
  -- counter, which cannot survive multiple tenants.
  reference_no     integer not null,
  -- The client's own PO or reference, when they give one.
  client_reference text,
  status           public.consignment_status not null default 'draft',
  pickup_mode      public.pickup_mode not null default 'single',
  -- Used when pickup_mode = 'single'; every vehicle inherits these.
  pickup_location_id  uuid,
  dropoff_location_id uuid,
  pickup_address      jsonb,
  dropoff_address     jsonb,
  scheduled_for    timestamptz,
  completed_at     timestamptz,
  cancelled_at     timestamptz,
  cancel_reason    text,
  rate_card_id     uuid,
  billing_amount   numeric(12, 2) check (billing_amount is null or billing_amount >= 0),
  billing_status   public.billing_status not null default 'pending',
  notes            text,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint consignments_pkey primary key (id),
  constraint consignments_id_company_key unique (id, company_id),
  constraint consignments_reference_unique unique (company_id, reference_no),
  constraint consignments_client_fkey
    foreign key (client_id, company_id) references public.clients (id, company_id) on delete restrict,
  constraint consignments_pickup_location_fkey
    foreign key (pickup_location_id, company_id) references public.locations (id, company_id) on delete restrict,
  constraint consignments_dropoff_location_fkey
    foreign key (dropoff_location_id, company_id) references public.locations (id, company_id) on delete restrict,
  constraint consignments_rate_card_fkey
    foreign key (rate_card_id, company_id) references public.rate_cards (id, company_id) on delete restrict,
  -- Single-pickup consignments must actually say where. Multi-pickup ones must
  -- not, because the per-vehicle rows are the source of truth there and two
  -- competing answers is how a vehicle ends up at the wrong address.
  constraint consignments_single_mode_has_route check (
    pickup_mode <> 'single'
    or ((pickup_location_id is not null or pickup_address is not null)
        and (dropoff_location_id is not null or dropoff_address is not null))
  ),
  constraint consignments_completed_has_timestamp
    check (status <> 'completed' or completed_at is not null),
  constraint consignments_cancelled_has_timestamp
    check (status <> 'cancelled' or cancelled_at is not null)
);

comment on table public.consignments is
  'One client-facing job. One consignment produces one invoice line or one PAYG charge.';

create index consignments_company_status_idx on public.consignments (company_id, status);
create index consignments_company_scheduled_idx on public.consignments (company_id, scheduled_for desc);
create index consignments_client_idx on public.consignments (client_id);
create index consignments_billing_idx on public.consignments (company_id, billing_status)
  where status in ('completed', 'invoiced');

-- ----------------------------------------------------------------------------
-- company_counters
--
-- Per-tenant reference numbering. A counter table rather than a Postgres
-- sequence, because sequences are global and gappy, and an operator reading
-- "consignment 1043" down the phone wants it to mean the 1043rd job they
-- booked, not the 1043rd booked by anyone on the platform.
-- ----------------------------------------------------------------------------
create table public.company_counters (
  company_id          uuid not null references public.companies (id) on delete cascade,
  consignment_next_no integer not null default 1 check (consignment_next_no > 0),
  invoice_next_no     integer not null default 1 check (invoice_next_no > 0),
  constraint company_counters_pkey primary key (company_id)
);

alter table public.company_counters enable row level security;
alter table public.company_counters force row level security;
revoke all on public.company_counters from public;
grant select on public.company_counters to authenticated;
grant all on public.company_counters to service_role;

create policy company_counters_select on public.company_counters
  for select to authenticated
  using ((select app.is_staff(company_id)));

-- No write policy at all. The counter only moves through the definer trigger
-- below, so no client can renumber a company's job history.
create function app.assign_consignment_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  next_no integer;
begin
  if new.reference_no is not null then
    return new;
  end if;

  insert into public.company_counters (company_id)
  values (new.company_id)
  on conflict (company_id) do nothing;

  -- The UPDATE takes a row lock, which serialises concurrent bookings for this
  -- one company without blocking any other tenant.
  update public.company_counters
     set consignment_next_no = consignment_next_no + 1
   where company_id = new.company_id
  returning consignment_next_no - 1 into next_no;

  new.reference_no := next_no;
  return new;
end
$$;

-- reference_no is NOT NULL, and the trigger supplies it. BEFORE INSERT
-- triggers run before NOT NULL is checked, so callers may omit it.
alter table public.consignments alter column reference_no drop not null;
alter table public.consignments
  add constraint consignments_reference_assigned check (reference_no is not null) not valid;

create trigger assign_reference_no
  before insert on public.consignments
  for each row execute function app.assign_consignment_reference();

alter table public.consignments enable row level security;
alter table public.consignments force row level security;
revoke all on public.consignments from public;
grant select, insert, update, delete on public.consignments to authenticated;
grant all on public.consignments to service_role;
select app.add_touch_trigger('public.consignments');

create policy consignments_select_staff on public.consignments
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy consignments_insert on public.consignments
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy consignments_update on public.consignments
  for update to authenticated
  using ((select app.can_dispatch(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

-- Only a draft can be deleted outright. Anything that has started leaves a
-- record; cancellation is a status, not a DELETE.
create policy consignments_delete_drafts on public.consignments
  for delete to authenticated
  using (
    status = 'draft'
    and (select app.can_write_company(company_id))
    and (select app.can_dispatch(company_id))
  );

-- ----------------------------------------------------------------------------
-- consignment_vehicles
-- ----------------------------------------------------------------------------
create table public.consignment_vehicles (
  id             uuid not null default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  consignment_id uuid not null,
  -- Optional link to the fleet record. Null for a one-off movement.
  vehicle_id     uuid,
  sequence       integer not null default 1 check (sequence > 0),
  registration   text check (registration is null or registration ~ '^[A-Z0-9]{2,16}$'),
  vin            text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  make           text,
  model          text,
  colour         text,
  body_type      text not null default 'car',
  -- Overrides the consignment's route when pickup_mode = 'multi'.
  pickup_location_id  uuid,
  dropoff_location_id uuid,
  pickup_address      jsonb,
  dropoff_address     jsonb,
  current_status      public.consignment_vehicle_status not null default 'awaiting_collection',
  -- Who physically has this vehicle right now. Null between legs, or before
  -- the first collection.
  current_custody_driver_id uuid references public.driver_profiles (id) on delete set null,
  delivered_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint consignment_vehicles_pkey primary key (id),
  constraint consignment_vehicles_id_company_key unique (id, company_id),
  constraint consignment_vehicles_consignment_fkey
    foreign key (consignment_id, company_id)
    references public.consignments (id, company_id) on delete cascade,
  constraint consignment_vehicles_vehicle_fkey
    foreign key (vehicle_id, company_id)
    references public.vehicles (id, company_id) on delete restrict,
  constraint consignment_vehicles_pickup_location_fkey
    foreign key (pickup_location_id, company_id)
    references public.locations (id, company_id) on delete restrict,
  constraint consignment_vehicles_dropoff_location_fkey
    foreign key (dropoff_location_id, company_id)
    references public.locations (id, company_id) on delete restrict,
  constraint consignment_vehicles_sequence_unique unique (consignment_id, sequence),
  constraint consignment_vehicles_identifiable
    check (registration is not null or vin is not null or vehicle_id is not null),
  constraint consignment_vehicles_delivered_has_timestamp
    check (current_status <> 'delivered' or delivered_at is not null)
);

create index consignment_vehicles_consignment_idx
  on public.consignment_vehicles (consignment_id, sequence);
create index consignment_vehicles_company_status_idx
  on public.consignment_vehicles (company_id, current_status);
create index consignment_vehicles_custody_idx
  on public.consignment_vehicles (current_custody_driver_id)
  where current_custody_driver_id is not null;

alter table public.consignment_vehicles enable row level security;
alter table public.consignment_vehicles force row level security;
revoke all on public.consignment_vehicles from public;
grant select, insert, update, delete on public.consignment_vehicles to authenticated;
grant all on public.consignment_vehicles to service_role;
select app.add_touch_trigger('public.consignment_vehicles');

create policy consignment_vehicles_select_staff on public.consignment_vehicles
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy consignment_vehicles_insert on public.consignment_vehicles
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy consignment_vehicles_update_dispatch on public.consignment_vehicles
  for update to authenticated
  using ((select app.can_dispatch(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy consignment_vehicles_delete on public.consignment_vehicles
  for delete to authenticated
  using ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

-- ----------------------------------------------------------------------------
-- trips
--
-- The driver-facing view: one outing, several legs, possibly spanning
-- different vehicles and different consignments. A flatbed collecting three
-- cars from one compound and dropping them at three addresses is one trip,
-- three vehicles, six stops.
-- ----------------------------------------------------------------------------
create table public.trips (
  id                uuid not null default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  driver_profile_id uuid not null references public.driver_profiles (id) on delete restrict,
  trip_date         date not null,
  status            public.trip_status not null default 'planned',
  -- The driver's own transport: flatbed registration, HGV plus trailer, or the
  -- fact that they are driving the subject vehicle itself.
  transport_used    text,
  started_at        timestamptz,
  completed_at      timestamptz,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint trips_pkey primary key (id),
  constraint trips_id_company_key unique (id, company_id),
  constraint trips_completed_has_timestamp
    check (status <> 'completed' or completed_at is not null)
);

create index trips_company_date_idx on public.trips (company_id, trip_date desc);
create index trips_driver_date_idx on public.trips (driver_profile_id, trip_date desc);

alter table public.trips enable row level security;
alter table public.trips force row level security;
revoke all on public.trips from public;
grant select, insert, update, delete on public.trips to authenticated;
grant all on public.trips to service_role;
select app.add_touch_trigger('public.trips');

create policy trips_select_staff on public.trips
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy trips_select_own_driver on public.trips
  for select to authenticated
  using (
    driver_profile_id = (select app.current_driver_profile_id())
    and (select app.has_company(company_id))
  );

create policy trips_insert on public.trips
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy trips_update_dispatch on public.trips
  for update to authenticated
  using ((select app.can_dispatch(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

-- A driver starts and finishes their own trip from the app. They cannot
-- reassign it: driver_profile_id is pinned to them on the way out as well as
-- on the way in.
create policy trips_update_own_driver on public.trips
  for update to authenticated
  using (
    driver_profile_id = (select app.current_driver_profile_id())
    and (select app.can_write_company(company_id))
  )
  with check (
    driver_profile_id = (select app.current_driver_profile_id())
    and (select app.can_write_company(company_id))
  );

create policy trips_delete on public.trips
  for delete to authenticated
  using (
    status = 'planned'
    and (select app.can_write_company(company_id))
    and (select app.can_dispatch(company_id))
  );

-- ----------------------------------------------------------------------------
-- legs
--
-- One driver, one vehicle, one custody segment. Sequence orders a vehicle's
-- journey: sequence 1 collects from the client, sequence 2 takes it on from
-- the depot, and so on.
-- ----------------------------------------------------------------------------
create table public.legs (
  id                     uuid not null default gen_random_uuid(),
  company_id             uuid not null references public.companies (id) on delete cascade,
  consignment_vehicle_id uuid not null,
  sequence               integer not null check (sequence > 0),
  -- Null while the leg is still unassigned. RESTRICT on delete because
  -- removing a driver who holds custody history must be a deliberate act.
  driver_profile_id      uuid references public.driver_profiles (id) on delete restrict,
  trip_id                uuid,
  from_location_id       uuid,
  to_location_id         uuid,
  from_address           jsonb,
  to_address             jsonb,
  planned_start          timestamptz,
  planned_end            timestamptz,
  status                 public.leg_status not null default 'unassigned',
  -- Routed distance for this segment, used for driver pay and per-mile pricing.
  distance_miles         numeric(10, 2) check (distance_miles is null or distance_miles >= 0),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint legs_pkey primary key (id),
  constraint legs_id_company_key unique (id, company_id),
  constraint legs_vehicle_fkey
    foreign key (consignment_vehicle_id, company_id)
    references public.consignment_vehicles (id, company_id) on delete cascade,
  -- Detaching a leg from a deleted trip must not null out company_id, so the
  -- column list form is required here. Postgres 15 or later.
  constraint legs_trip_fkey
    foreign key (trip_id, company_id)
    references public.trips (id, company_id) on delete set null (trip_id),
  constraint legs_from_location_fkey
    foreign key (from_location_id, company_id)
    references public.locations (id, company_id) on delete restrict,
  constraint legs_to_location_fkey
    foreign key (to_location_id, company_id)
    references public.locations (id, company_id) on delete restrict,
  constraint legs_sequence_unique unique (consignment_vehicle_id, sequence),
  -- A leg has to know where it starts and ends, from either a saved location
  -- or a typed address.
  constraint legs_has_origin check (from_location_id is not null or from_address is not null),
  constraint legs_has_destination check (to_location_id is not null or to_address is not null),
  -- Any status past 'unassigned' implies somebody is carrying the vehicle.
  constraint legs_assigned_has_driver
    check (status in ('unassigned', 'cancelled') or driver_profile_id is not null),
  constraint legs_planned_window_ordered
    check (planned_start is null or planned_end is null or planned_end >= planned_start)
);

comment on table public.legs is
  'The custody unit: one driver in physical possession of one vehicle between two points. Multiple legs per vehicle is what makes a handover expressible.';

create index legs_vehicle_sequence_idx on public.legs (consignment_vehicle_id, sequence);
create index legs_driver_status_idx on public.legs (driver_profile_id, status)
  where driver_profile_id is not null;
create index legs_trip_idx on public.legs (trip_id) where trip_id is not null;
create index legs_company_status_idx on public.legs (company_id, status);

alter table public.legs enable row level security;
alter table public.legs force row level security;
revoke all on public.legs from public;
grant select, insert, update, delete on public.legs to authenticated;
grant all on public.legs to service_role;
select app.add_touch_trigger('public.legs');

create policy legs_select_staff on public.legs
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy legs_select_own_driver on public.legs
  for select to authenticated
  using (
    driver_profile_id = (select app.current_driver_profile_id())
    and (select app.has_company(company_id))
  );

create policy legs_insert on public.legs
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy legs_update_dispatch on public.legs
  for update to authenticated
  using ((select app.can_dispatch(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

-- The driver advances their own leg's status as they collect and deliver. They
-- cannot hand it to somebody else, and cannot pull another driver's leg to
-- themselves: driver_profile_id must equal them both before and after.
create policy legs_update_own_driver on public.legs
  for update to authenticated
  using (
    driver_profile_id = (select app.current_driver_profile_id())
    and (select app.can_write_company(company_id))
  )
  with check (
    driver_profile_id = (select app.current_driver_profile_id())
    and (select app.can_write_company(company_id))
  );

create policy legs_delete on public.legs
  for delete to authenticated
  using (
    status in ('unassigned', 'assigned')
    and (select app.can_write_company(company_id))
    and (select app.can_dispatch(company_id))
  );

-- ----------------------------------------------------------------------------
-- Driver visibility
--
-- Deferred to here because these read `legs`.
--
-- A driver sees a consignment and its vehicles only when they hold a leg on
-- it. That is deliberately narrower than "anything at a company you are linked
-- to": a self-employed driver doing one job for an operator has no business
-- reading that operator's whole order book.
-- ----------------------------------------------------------------------------

create function app.owns_leg(target_leg_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
      from public.legs l
     where l.id = target_leg_id
       and l.driver_profile_id is not null
       and l.driver_profile_id = app.current_driver_profile_id()
       -- Membership is re-checked, not assumed from the assignment. Revoking a
       -- driver's link has to cut their access on the next statement; without
       -- this, a removed driver would keep reading the legs they once held.
       and app.has_company(l.company_id)
  )
$$;

comment on function app.owns_leg(uuid) is
  'True when the current session is the driver assigned to that leg. The basis of "a driver may only record custody of a vehicle they were actually given".';

create function app.driver_sees_consignment(target_consignment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
      from public.legs l
      join public.consignment_vehicles cv on cv.id = l.consignment_vehicle_id
     where cv.consignment_id = target_consignment_id
       and l.driver_profile_id is not null
       and l.driver_profile_id = app.current_driver_profile_id()
       and app.has_company(l.company_id)
  )
$$;

create function app.driver_sees_consignment_vehicle(target_cv_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
      from public.legs l
     where l.consignment_vehicle_id = target_cv_id
       and l.driver_profile_id is not null
       and l.driver_profile_id = app.current_driver_profile_id()
       and app.has_company(l.company_id)
  )
$$;

create policy consignments_select_assigned_driver on public.consignments
  for select to authenticated
  using ((select app.driver_sees_consignment(id)));

create policy consignment_vehicles_select_assigned_driver on public.consignment_vehicles
  for select to authenticated
  using ((select app.driver_sees_consignment_vehicle(id)));

-- The driver updates the vehicle's live status as they collect and hand over.
-- Restricted to vehicles they actually hold a leg on.
create policy consignment_vehicles_update_own_driver on public.consignment_vehicles
  for update to authenticated
  using (
    (select app.driver_sees_consignment_vehicle(id))
    and (select app.can_write_company(company_id))
  )
  with check (
    (select app.driver_sees_consignment_vehicle(id))
    and (select app.can_write_company(company_id))
  );

-- ----------------------------------------------------------------------------
-- trip_stops
--
-- A departure from the spec, flagged as such: the spec describes a trip's stops
-- as derived from its legs. Derived ordering cannot record a dispatcher's
-- manual reordering, and route order is exactly what a dispatcher wants to
-- control. One row per stop, with an explicit sequence, costs one table.
-- ----------------------------------------------------------------------------
create table public.trip_stops (
  id           uuid not null default gen_random_uuid(),
  company_id   uuid not null references public.companies (id) on delete cascade,
  trip_id      uuid not null,
  leg_id       uuid not null,
  kind         public.stop_kind not null,
  sequence     integer not null check (sequence > 0),
  arrived_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint trip_stops_pkey primary key (id),
  constraint trip_stops_id_company_key unique (id, company_id),
  constraint trip_stops_trip_fkey
    foreign key (trip_id, company_id) references public.trips (id, company_id) on delete cascade,
  constraint trip_stops_leg_fkey
    foreign key (leg_id, company_id) references public.legs (id, company_id) on delete cascade,
  constraint trip_stops_sequence_unique unique (trip_id, sequence),
  -- A leg contributes at most one collection stop and one delivery stop.
  constraint trip_stops_leg_kind_unique unique (trip_id, leg_id, kind)
);

create index trip_stops_trip_idx on public.trip_stops (trip_id, sequence);
create index trip_stops_leg_idx on public.trip_stops (leg_id);

alter table public.trip_stops enable row level security;
alter table public.trip_stops force row level security;
revoke all on public.trip_stops from public;
grant select, insert, update, delete on public.trip_stops to authenticated;
grant all on public.trip_stops to service_role;
select app.add_touch_trigger('public.trip_stops');

create policy trip_stops_select_staff on public.trip_stops
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy trip_stops_select_own_driver on public.trip_stops
  for select to authenticated
  using ((select app.owns_leg(leg_id)));

create policy trip_stops_insert on public.trip_stops
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy trip_stops_update_dispatch on public.trip_stops
  for update to authenticated
  using ((select app.can_dispatch(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));

create policy trip_stops_update_own_driver on public.trip_stops
  for update to authenticated
  using ((select app.owns_leg(leg_id)) and (select app.can_write_company(company_id)))
  with check ((select app.owns_leg(leg_id)) and (select app.can_write_company(company_id)));

create policy trip_stops_delete on public.trip_stops
  for delete to authenticated
  using ((select app.can_write_company(company_id)) and (select app.can_dispatch(company_id)));
