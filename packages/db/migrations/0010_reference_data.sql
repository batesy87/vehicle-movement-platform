-- ============================================================================
-- 0010 reference data
--
-- Plan tiers. Reference data rather than seed data: it ships with the schema
-- and exists in every environment, because a company row cannot be created
-- without a plan to point at.
--
-- Written as an upsert so re-running the migrations against an existing
-- database updates the tiers rather than failing on the unique key. Prices are
-- placeholders pending a proper competitor feature audit.
--
-- Kept in step with packages/shared/src/plans.ts, which the feature-parity test
-- enforces.
-- ============================================================================

insert into public.plans (key, name, price_monthly, included_jobs_per_month, overage_price_per_job, sort_order, features)
values
  (
    'starter', 'Starter', 49.00, 75, 1.50, 10,
    jsonb_build_object(
      'poc_pod_capture', true,
      'multi_vehicle_consignments', true,
      'leg_handover', false,
      'live_gps_tracking', false,
      'automatic_invoicing', false,
      'rate_cards', true,
      'analytics_dashboard', false,
      'multi_depot', false,
      'api_access', false,
      'white_labelling', false
    )
  ),
  (
    'growth', 'Growth', 99.00, 200, 1.00, 20,
    jsonb_build_object(
      'poc_pod_capture', true,
      'multi_vehicle_consignments', true,
      'leg_handover', true,
      'live_gps_tracking', true,
      'automatic_invoicing', true,
      'rate_cards', true,
      'analytics_dashboard', true,
      'multi_depot', false,
      'api_access', false,
      'white_labelling', false
    )
  ),
  (
    'pro', 'Pro', 149.00, null, null, 30,
    jsonb_build_object(
      'poc_pod_capture', true,
      'multi_vehicle_consignments', true,
      'leg_handover', true,
      'live_gps_tracking', true,
      'automatic_invoicing', true,
      'rate_cards', true,
      'analytics_dashboard', true,
      'multi_depot', true,
      'api_access', true,
      'white_labelling', true
    )
  )
on conflict (key) do update
  set name                    = excluded.name,
      price_monthly           = excluded.price_monthly,
      included_jobs_per_month = excluded.included_jobs_per_month,
      overage_price_per_job   = excluded.overage_price_per_job,
      sort_order              = excluded.sort_order,
      features                = excluded.features,
      updated_at              = now();

-- Multi-vehicle consignments are on every tier deliberately. It is a
-- structural capability of the data model rather than a premium add-on, and
-- crippling it on the cheapest plan would mean shipping a worse product to the
-- customers most likely to leave. Leg-based handover and multi-depot carry the
-- tiering weight instead, since those are genuinely advanced operations.
