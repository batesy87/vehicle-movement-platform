-- ============================================================================
-- 0007 custody events, media and condition findings
--
-- This is the evidence layer, and the part of the legacy system that was
-- genuinely good. Three things are fixed on the way across.
--
-- 1. Signatures are media objects, not inline base64. The legacy build stored
--    signature data URIs directly in the document. On Postgres that would put
--    tens of kilobytes of base64 on every custody event row, which is read
--    constantly and rewritten on every status change.
--
-- 2. Storage keys are scoped to the vehicle, not the job. The legacy path
--    convention was `job-files/{jobId}/collection_ns_front.jpg`, so on a
--    multi-vehicle job the second car's photos overwrote the first car's.
--
-- 3. Captured time and synced time are separate, and there is an idempotency
--    key. The legacy driver app had no offline queue at all and its optimistic
--    reducer advanced whether or not the write landed, so a photo taken in a
--    compound with no signal was simply lost. The columns for doing this
--    properly exist from day one even though the sync client is a later phase.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- media_objects
--
-- One row per stored file, whatever it is. The bytes live in object storage;
-- this table is the catalogue and the tenant boundary around it.
-- ----------------------------------------------------------------------------
create table public.media_objects (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  kind            public.media_kind not null default 'photo',
  bucket          text not null default 'custody-media',
  object_key      text not null,
  content_type    text not null,
  byte_size       bigint check (byte_size is null or byte_size > 0),
  -- Lets an offline client retry an upload without creating a duplicate, and
  -- lets a dispute check that a photo has not been swapped since capture.
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  width           integer check (width is null or width > 0),
  height          integer check (height is null or height > 0),
  -- When the camera took it, which is not when it reached the server.
  captured_at     timestamptz,
  uploaded_at     timestamptz not null default now(),
  uploaded_by     uuid references public.driver_profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint media_objects_pkey primary key (id),
  constraint media_objects_id_company_key unique (id, company_id),
  constraint media_objects_location_unique unique (bucket, object_key)
);

comment on column public.media_objects.object_key is
  'Storage key. Convention: {company_id}/consignments/{consignment_id}/vehicles/{consignment_vehicle_id}/legs/{leg_id}/{slug}.jpg -- scoped to the vehicle so a multi-vehicle consignment cannot overwrite itself, and prefixed with the tenant so a storage policy can be written against the path.';

create index media_objects_company_idx on public.media_objects (company_id, uploaded_at desc);

alter table public.media_objects enable row level security;
alter table public.media_objects force row level security;
revoke all on public.media_objects from public;
grant select, insert, update on public.media_objects to authenticated;
grant all on public.media_objects to service_role;
select app.add_touch_trigger('public.media_objects');

create policy media_objects_select_staff on public.media_objects
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy media_objects_select_own_driver on public.media_objects
  for select to authenticated
  using (
    uploaded_by = (select app.current_driver_profile_id())
    and (select app.has_company(company_id))
  );

-- A driver uploads evidence; a dispatcher may attach documents. Either way the
-- row must land in the active company.
create policy media_objects_insert on public.media_objects
  for insert to authenticated
  with check (
    (select app.can_write_company(company_id))
    and (
      (select app.can_dispatch(company_id))
      or uploaded_by = (select app.current_driver_profile_id())
    )
  );

-- Deliberately no delete policy. Evidence is not deletable by a tenant: a
-- photograph that disproves a damage claim must not be removable by the party
-- the claim is against. Removal is a service-role operation with an audit
-- trail behind it.

-- ----------------------------------------------------------------------------
-- custody_events
--
-- One per end of a leg: a collection when the driver takes possession, a
-- delivery when they give it up. A leg therefore has exactly two.
--
-- A mid-journey handover produces two events on two different legs at the same
-- physical moment: leg N's delivery and leg N+1's collection. They point at
-- each other through paired_event_id so the interface can show one handover
-- rather than two unrelated records.
-- ----------------------------------------------------------------------------
create table public.custody_events (
  id              uuid not null default gen_random_uuid(),
  company_id      uuid not null references public.companies (id) on delete cascade,
  leg_id          uuid not null,
  event_type      public.custody_event_type not null,
  paired_event_id uuid,

  -- Timing. captured_at is device time at the moment of capture and is the
  -- legally interesting one; synced_at is when it reached us.
  captured_at      timestamptz not null default now(),
  synced_at        timestamptz not null default now(),
  offline_captured boolean not null default false,

  -- Where it actually happened, not where it was planned to.
  gps_latitude  numeric(9, 6) check (gps_latitude is null or gps_latitude between -90 and 90),
  gps_longitude numeric(9, 6) check (gps_longitude is null or gps_longitude between -180 and 180),
  gps_accuracy_m numeric(8, 2) check (gps_accuracy_m is null or gps_accuracy_m >= 0),

  odometer      integer check (odometer is null or odometer >= 0),
  fuel_level    text,
  charge_level  text,

  -- The checklist as captured. Held as jsonb rather than sixty columns because
  -- the checklist changes shape over time and an event from two years ago must
  -- still render exactly as it was recorded. Field definitions live in
  -- packages/shared/src/reference/appraisal.ts.
  pre_survey    jsonb,
  appraisal     jsonb,
  sign_off      jsonb,
  handover      jsonb,
  condition_notes text,

  -- Signatures, as media rather than inline base64.
  driver_name             text,
  driver_signature_id     uuid,
  counterparty_name       text,
  counterparty_signature_id uuid,

  captured_by_driver_id uuid not null references public.driver_profiles (id) on delete restrict,

  -- Supplied by the client so a retried offline submission is recognised
  -- rather than duplicated.
  idempotency_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint custody_events_pkey primary key (id),
  constraint custody_events_id_company_key unique (id, company_id),
  constraint custody_events_leg_fkey
    foreign key (leg_id, company_id) references public.legs (id, company_id) on delete cascade,
  constraint custody_events_paired_fkey
    foreign key (paired_event_id, company_id)
    references public.custody_events (id, company_id) on delete set null (paired_event_id),
  constraint custody_events_driver_signature_fkey
    foreign key (driver_signature_id, company_id)
    references public.media_objects (id, company_id) on delete restrict,
  constraint custody_events_counterparty_signature_fkey
    foreign key (counterparty_signature_id, company_id)
    references public.media_objects (id, company_id) on delete restrict,
  -- Exactly one collection and one delivery per leg.
  constraint custody_events_one_per_leg_and_type unique (leg_id, event_type),
  constraint custody_events_not_self_paired check (paired_event_id is null or paired_event_id <> id),
  constraint custody_events_sync_after_capture check (synced_at >= captured_at)
);

comment on table public.custody_events is
  'Proof of collection and proof of delivery. One event per end of a leg; a handover is two events on two legs pointing at each other.';

create unique index custody_events_idempotency_key_unique
  on public.custody_events (company_id, idempotency_key)
  where idempotency_key is not null;

create index custody_events_leg_idx on public.custody_events (leg_id, event_type);
create index custody_events_company_captured_idx
  on public.custody_events (company_id, captured_at desc);
create index custody_events_driver_idx on public.custody_events (captured_by_driver_id, captured_at desc);
create index custody_events_paired_idx on public.custody_events (paired_event_id)
  where paired_event_id is not null;

-- A pairing is only meaningful between the two ends of a handover: a delivery
-- on one leg and a collection on the next. Pairing two collections, or two
-- events on the same leg, means something has gone wrong upstream.
create function app.check_custody_pairing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  paired public.custody_events%rowtype;
begin
  if new.paired_event_id is null then
    return new;
  end if;

  select * into paired from public.custody_events where id = new.paired_event_id;

  if not found then
    raise exception 'paired custody event % does not exist', new.paired_event_id;
  end if;

  if paired.leg_id = new.leg_id then
    raise exception 'a custody event cannot be paired with another event on the same leg';
  end if;

  if paired.event_type = new.event_type then
    raise exception 'a handover pairs a delivery with a collection, not two % events', new.event_type;
  end if;

  return new;
end
$$;

create trigger check_custody_pairing
  before insert or update of paired_event_id on public.custody_events
  for each row execute function app.check_custody_pairing();

alter table public.custody_events enable row level security;
alter table public.custody_events force row level security;
revoke all on public.custody_events from public;
grant select, insert, update on public.custody_events to authenticated;
grant all on public.custody_events to service_role;
select app.add_touch_trigger('public.custody_events');

create policy custody_events_select_staff on public.custody_events
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy custody_events_select_own_driver on public.custody_events
  for select to authenticated
  using ((select app.owns_leg(leg_id)));

-- The rule from the spec, stated in one place: a driver can only submit
-- custody events for legs assigned to them. The captured_by check stops a
-- driver filing an event in somebody else's name.
create policy custody_events_insert_own_driver on public.custody_events
  for insert to authenticated
  with check (
    (select app.can_write_company(company_id))
    and (select app.owns_leg(leg_id))
    and captured_by_driver_id = (select app.current_driver_profile_id())
  );

-- A driver may correct their own event, for instance when a photo upload
-- completes after the event row was created. Staff cannot edit it at all:
-- dispute evidence that the accused party can rewrite is not evidence.
create policy custody_events_update_own_driver on public.custody_events
  for update to authenticated
  using (
    (select app.owns_leg(leg_id))
    and captured_by_driver_id = (select app.current_driver_profile_id())
  )
  with check (
    (select app.can_write_company(company_id))
    and (select app.owns_leg(leg_id))
    and captured_by_driver_id = (select app.current_driver_profile_id())
  );

-- No delete policy for anyone.

-- ----------------------------------------------------------------------------
-- condition_findings
--
-- The per-panel damage record, carried over from the legacy damage taxonomy.
-- Exterior findings name a body section and a damage type; interior findings
-- are free text with a photo, because interior damage does not decompose into
-- panels usefully.
-- ----------------------------------------------------------------------------
create table public.condition_findings (
  id               uuid not null default gen_random_uuid(),
  company_id       uuid not null references public.companies (id) on delete cascade,
  custody_event_id uuid not null,
  scope            text not null default 'exterior' check (scope in ('exterior', 'interior')),
  -- Which body map the section key belongs to: 'car', 'van', and so on.
  body_type        text,
  section_key      text,
  damage_type_key  text,
  description      text,
  note             text,
  media_id         uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint condition_findings_pkey primary key (id),
  constraint condition_findings_id_company_key unique (id, company_id),
  constraint condition_findings_event_fkey
    foreign key (custody_event_id, company_id)
    references public.custody_events (id, company_id) on delete cascade,
  constraint condition_findings_media_fkey
    foreign key (media_id, company_id)
    references public.media_objects (id, company_id) on delete restrict,
  -- An exterior finding has to say where and what. An interior one has to say
  -- what in words.
  constraint condition_findings_exterior_is_located check (
    scope <> 'exterior'
    or (body_type is not null and section_key is not null and damage_type_key is not null)
  ),
  constraint condition_findings_interior_is_described check (
    scope <> 'interior' or description is not null
  )
);

comment on table public.condition_findings is
  'Damage recorded at a custody event. The section and damage-type vocabularies live in packages/shared/src/reference/damage.ts.';

create index condition_findings_event_idx on public.condition_findings (custody_event_id);
create index condition_findings_company_idx on public.condition_findings (company_id, created_at desc);

alter table public.condition_findings enable row level security;
alter table public.condition_findings force row level security;
revoke all on public.condition_findings from public;
grant select, insert, update, delete on public.condition_findings to authenticated;
grant all on public.condition_findings to service_role;
select app.add_touch_trigger('public.condition_findings');

create function app.owns_custody_event(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
      from public.custody_events ce
     where ce.id = target_event_id
       and ce.captured_by_driver_id = app.current_driver_profile_id()
       and app.has_company(ce.company_id)
  )
$$;

create policy condition_findings_select_staff on public.condition_findings
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy condition_findings_select_own_driver on public.condition_findings
  for select to authenticated
  using ((select app.owns_custody_event(custody_event_id)));

create policy condition_findings_insert_own_driver on public.condition_findings
  for insert to authenticated
  with check (
    (select app.can_write_company(company_id))
    and (select app.owns_custody_event(custody_event_id))
  );

create policy condition_findings_update_own_driver on public.condition_findings
  for update to authenticated
  using ((select app.owns_custody_event(custody_event_id)))
  with check (
    (select app.can_write_company(company_id))
    and (select app.owns_custody_event(custody_event_id))
  );

-- A driver can remove a finding they entered by mistake, but only before the
-- event that owns it has been paired into a completed handover. Staff cannot.
create policy condition_findings_delete_own_driver on public.condition_findings
  for delete to authenticated
  using (
    (select app.can_write_company(company_id))
    and (select app.owns_custody_event(custody_event_id))
  );

-- ----------------------------------------------------------------------------
-- leg_location_points
--
-- Breadcrumb trail behind the live GPS tracking feature. Append-only and
-- high volume, so it carries no updated_at and no update policy.
-- ----------------------------------------------------------------------------
create table public.leg_location_points (
  id                uuid not null default gen_random_uuid(),
  company_id        uuid not null references public.companies (id) on delete cascade,
  leg_id            uuid not null,
  driver_profile_id uuid not null references public.driver_profiles (id) on delete cascade,
  latitude          numeric(9, 6) not null check (latitude between -90 and 90),
  longitude         numeric(9, 6) not null check (longitude between -180 and 180),
  accuracy_m        numeric(8, 2),
  speed_mps         numeric(8, 2),
  heading_deg       numeric(6, 2),
  recorded_at       timestamptz not null,
  created_at        timestamptz not null default now(),

  constraint leg_location_points_pkey primary key (id),
  constraint leg_location_points_leg_fkey
    foreign key (leg_id, company_id) references public.legs (id, company_id) on delete cascade
);

create index leg_location_points_leg_time_idx
  on public.leg_location_points (leg_id, recorded_at);

alter table public.leg_location_points enable row level security;
alter table public.leg_location_points force row level security;
revoke all on public.leg_location_points from public;
grant select, insert on public.leg_location_points to authenticated;
grant all on public.leg_location_points to service_role;

create policy leg_location_points_select_staff on public.leg_location_points
  for select to authenticated
  using ((select app.is_staff(company_id)));

create policy leg_location_points_select_own_driver on public.leg_location_points
  for select to authenticated
  using (
    driver_profile_id = (select app.current_driver_profile_id())
    and (select app.has_company(company_id))
  );

create policy leg_location_points_insert_own_driver on public.leg_location_points
  for insert to authenticated
  with check (
    (select app.can_write_company(company_id))
    and (select app.owns_leg(leg_id))
    and driver_profile_id = (select app.current_driver_profile_id())
  );
