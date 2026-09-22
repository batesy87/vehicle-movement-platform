-- ============================================================================
-- 0008 billing, usage metering and audit
--
-- Stripe integration itself is a later phase. What exists here is the schema it
-- will write into, plus the usage counter that plan enforcement reads. Getting
-- the metering table in now matters because plan limits have to be enforced
-- server-side before any UI hides a button, and that needs somewhere to count.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- invoices and invoice_lines
-- ----------------------------------------------------------------------------
create table public.invoices (
  id            uuid not null default gen_random_uuid(),
  company_id    uuid not null references public.companies (id) on delete cascade,
  client_id     uuid not null,
  -- Per-tenant, like consignment references.
  invoice_no    integer not null,
  status        public.invoice_status not null default 'draft',
  issued_on     date,
  due_on        date,
  currency      char(3) not null default 'GBP',
  subtotal      numeric(12, 2) not null default 0 check (subtotal >= 0),
  tax_amount    numeric(12, 2) not null default 0 check (tax_amount >= 0),
  total         numeric(12, 2) not null default 0 check (total >= 0),
  paid_at       timestamptz,
  external_ref  text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint invoices_pkey primary key (id),
  constraint invoices_id_company_key unique (id, company_id),
  constraint invoices_number_unique unique (company_id, invoice_no),
  constraint invoices_client_fkey
    foreign key (client_id, company_id) references public.clients (id, company_id) on delete restrict,
  constraint invoices_issued_has_date check (status = 'draft' or issued_on is not null),
  constraint invoices_paid_has_timestamp check (status <> 'paid' or paid_at is not null),
  constraint invoices_due_after_issue check (due_on is null or issued_on is null or due_on >= issued_on)
);

create index invoices_company_status_idx on public.invoices (company_id, status);
create index invoices_client_idx on public.invoices (client_id);

create table public.invoice_lines (
  id             uuid not null default gen_random_uuid(),
  company_id     uuid not null references public.companies (id) on delete cascade,
  invoice_id     uuid not null,
  -- The consignment this line bills for. One consignment, one line.
  consignment_id uuid,
  description    text not null,
  quantity       numeric(10, 2) not null default 1 check (quantity > 0),
  unit_amount    numeric(12, 2) not null check (unit_amount >= 0),
  tax_rate       numeric(6, 4) not null default 0 check (tax_rate >= 0),
  line_total     numeric(12, 2) not null check (line_total >= 0),
  sequence       integer not null default 1 check (sequence > 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint invoice_lines_pkey primary key (id),
  constraint invoice_lines_id_company_key unique (id, company_id),
  constraint invoice_lines_invoice_fkey
    foreign key (invoice_id, company_id)
    references public.invoices (id, company_id) on delete cascade,
  constraint invoice_lines_consignment_fkey
    foreign key (consignment_id, company_id)
    references public.consignments (id, company_id) on delete restrict,
  constraint invoice_lines_sequence_unique unique (invoice_id, sequence)
);

-- A consignment is billed once. Re-billing it is a credit note plus a new
-- invoice, not a second line.
create unique index invoice_lines_one_per_consignment
  on public.invoice_lines (consignment_id)
  where consignment_id is not null;

create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id, sequence);

alter table public.invoices enable row level security;
alter table public.invoices force row level security;
alter table public.invoice_lines enable row level security;
alter table public.invoice_lines force row level security;
revoke all on public.invoices from public;
revoke all on public.invoice_lines from public;
grant select, insert, update on public.invoices to authenticated;
grant select, insert, update, delete on public.invoice_lines to authenticated;
grant all on public.invoices to service_role;
grant all on public.invoice_lines to service_role;
select app.add_touch_trigger('public.invoices');
select app.add_touch_trigger('public.invoice_lines');

-- Finance is admin-only, and invisible to drivers and viewers alike. A
-- self-employed driver linked to the company must not see what the client is
-- being charged for the job they just ran.
create policy invoices_select on public.invoices
  for select to authenticated
  using ((select app.can_manage_company(company_id)));

create policy invoices_insert on public.invoices
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

-- Issued invoices are not editable back into draft; that is a credit note.
create policy invoices_update_drafts on public.invoices
  for update to authenticated
  using (status in ('draft', 'issued') and (select app.can_manage_company(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

create policy invoice_lines_select on public.invoice_lines
  for select to authenticated
  using ((select app.can_manage_company(company_id)));

create policy invoice_lines_insert on public.invoice_lines
  for insert to authenticated
  with check ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

create policy invoice_lines_update on public.invoice_lines
  for update to authenticated
  using ((select app.can_manage_company(company_id)))
  with check ((select app.can_write_company(company_id)) and (select app.can_manage_company(company_id)));

create policy invoice_lines_delete on public.invoice_lines
  for delete to authenticated
  using (
    (select app.can_write_company(company_id))
    and (select app.can_manage_company(company_id))
    and exists (
      select 1 from public.invoices i
       where i.id = invoice_lines.invoice_id and i.status = 'draft'
    )
  );

-- ----------------------------------------------------------------------------
-- usage_counters
--
-- One row per company per billing period. `consignments_started` is what plan
-- enforcement reads before allowing a new booking, and what metered overage
-- bills from.
--
-- Maintained by a trigger rather than by application code, because a missed
-- increment is revenue quietly lost and there is no reason to trust every
-- future call site to remember.
-- ----------------------------------------------------------------------------
create table public.usage_counters (
  id                   uuid not null default gen_random_uuid(),
  company_id           uuid not null references public.companies (id) on delete cascade,
  -- First day of the period. Month granularity for now.
  period_start         date not null,
  consignments_started integer not null default 0 check (consignments_started >= 0),
  consignments_completed integer not null default 0 check (consignments_completed >= 0),
  overage_units        integer not null default 0 check (overage_units >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint usage_counters_pkey primary key (id),
  constraint usage_counters_period_unique unique (company_id, period_start)
);

create index usage_counters_company_period_idx
  on public.usage_counters (company_id, period_start desc);

alter table public.usage_counters enable row level security;
alter table public.usage_counters force row level security;
revoke all on public.usage_counters from public;
grant select on public.usage_counters to authenticated;
grant all on public.usage_counters to service_role;

-- Readable so the app can show "62 of 75 jobs used". Not writable by anyone:
-- the trigger below owns it.
create policy usage_counters_select on public.usage_counters
  for select to authenticated
  using ((select app.is_staff(company_id)));

create function app.record_consignment_usage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  period date := date_trunc('month', now())::date;
begin
  -- A consignment counts when it leaves draft, not when the row is created,
  -- so a dispatcher can build and discard a draft without burning allowance.
  if tg_op = 'INSERT' then
    if new.status = 'draft' then
      return new;
    end if;
  elsif old.status <> 'draft' or new.status = 'draft' then
    return new;
  end if;

  insert into public.usage_counters (company_id, period_start, consignments_started)
  values (new.company_id, period, 1)
  on conflict (company_id, period_start)
  do update set consignments_started = public.usage_counters.consignments_started + 1,
                updated_at = now();

  return new;
end
$$;

create trigger record_consignment_usage
  after insert or update of status on public.consignments
  for each row execute function app.record_consignment_usage();

select app.add_touch_trigger('public.usage_counters');

-- ----------------------------------------------------------------------------
-- audit_log
--
-- Append-only. Status changes in general, and anything touching custody
-- evidence in particular, because that is what a dispute turns on months
-- later.
--
-- There is no update policy and no delete policy, for anyone including company
-- owners. An audit trail the audited party can edit is decoration.
-- ----------------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies (id) on delete cascade,
  table_name  text not null,
  record_id   uuid not null,
  action      public.audit_action not null,
  -- Only the columns that actually changed, as {column: {from, to}}.
  changes     jsonb,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_driver_profile_id uuid references public.driver_profiles (id) on delete set null,
  occurred_at timestamptz not null default now()
);

create index audit_log_company_time_idx on public.audit_log (company_id, occurred_at desc);
create index audit_log_record_idx on public.audit_log (table_name, record_id, occurred_at desc);

alter table public.audit_log enable row level security;
alter table public.audit_log force row level security;
revoke all on public.audit_log from public;
grant select, insert on public.audit_log to authenticated;
grant all on public.audit_log to service_role;

create policy audit_log_select on public.audit_log
  for select to authenticated
  using ((select app.can_manage_company(company_id)));

create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check ((select app.can_write_company(company_id)));

-- Generic status-change recorder, attached to the tables whose transitions
-- matter. It reads OLD and NEW dynamically so one function covers them all.
create function app.record_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  old_status text;
  new_status text;
begin
  old_status := to_jsonb(old) ->> 'status';
  new_status := to_jsonb(new) ->> 'status';

  if old_status is not distinct from new_status then
    return new;
  end if;

  insert into public.audit_log (
    company_id, table_name, record_id, action, changes,
    actor_user_id, actor_driver_profile_id
  )
  values (
    new.company_id,
    tg_table_name,
    new.id,
    'update',
    jsonb_build_object('status', jsonb_build_object('from', old_status, 'to', new_status)),
    auth.uid(),
    app.current_driver_profile_id()
  );

  return new;
end
$$;

create trigger audit_status_change
  after update of status on public.consignments
  for each row execute function app.record_status_change();

create trigger audit_status_change
  after update of status on public.legs
  for each row execute function app.record_status_change();

create trigger audit_status_change
  after update of current_status on public.consignment_vehicles
  for each row execute function app.record_status_change();

create trigger audit_status_change
  after update of status on public.trips
  for each row execute function app.record_status_change();

create trigger audit_status_change
  after update of status on public.invoices
  for each row execute function app.record_status_change();

-- Custody events are the dispute-critical ones, so every insert is logged, not
-- only changes.
create function app.record_custody_event_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.audit_log (
    company_id, table_name, record_id, action, changes,
    actor_user_id, actor_driver_profile_id
  )
  values (
    new.company_id,
    tg_table_name,
    new.id,
    lower(tg_op)::public.audit_action,
    jsonb_build_object(
      'leg_id', new.leg_id,
      'event_type', new.event_type,
      'captured_at', new.captured_at,
      'offline_captured', new.offline_captured
    ),
    auth.uid(),
    new.captured_by_driver_id
  );
  return new;
end
$$;

create trigger audit_custody_event
  after insert or update on public.custody_events
  for each row execute function app.record_custody_event_audit();
