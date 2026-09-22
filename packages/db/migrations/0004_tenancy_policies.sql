-- ============================================================================
-- 0004 tenancy policies
--
-- Policies for the tables in 0002. From 0005 onwards, policies sit in the same
-- file as the tables they guard; this split exists only because the helpers in
-- 0003 read the tables in 0002.
--
-- Conventions applied here and everywhere after:
--
--   * One policy per operation. No FOR ALL, because a FOR ALL policy's USING
--     clause silently doubles as its WITH CHECK and that is easy to misread.
--   * Every INSERT and UPDATE policy has an explicit WITH CHECK. A policy with
--     USING but no WITH CHECK lets a user update a row and move it out of their
--     own tenant on the way past.
--   * No USING (true), ever. The schema guard test fails the build if one
--     appears.
--   * Reads are permitted for any company the session belongs to. Writes
--     additionally require that company to be the explicitly chosen active one.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- plans
--
-- Public reference data. Writes are service-role only, which needs no policy
-- because service_role carries bypassrls; the absence of a write policy is
-- what denies everyone else.
-- ----------------------------------------------------------------------------
create policy plans_select_public
  on public.plans
  for select
  to anon, authenticated
  using (is_public);

-- ----------------------------------------------------------------------------
-- companies
-- ----------------------------------------------------------------------------
create policy companies_select_members
  on public.companies
  for select
  to authenticated
  using ((select app.has_company(id)));

-- Companies are not created directly. Signup goes through
-- app.create_company_for_current_user() in 0009, which creates the company and
-- its first owner in one transaction. A brand new user has no memberships, so
-- an INSERT policy here could only be written as USING (true), which is exactly
-- what we refuse to do.

create policy companies_update_admins
  on public.companies
  for update
  to authenticated
  using ((select app.can_manage_company(id)))
  with check ((select app.can_manage_company(id)));

-- No delete policy. Closing a company sets status = 'cancelled'; the row and
-- its custody history stay, because a deleted tenant takes its proof of
-- delivery with it and that evidence may be needed years later.

-- ----------------------------------------------------------------------------
-- company_users
-- ----------------------------------------------------------------------------

-- A member can see who else is at the companies they belong to. Drivers linked
-- to a company can see its staff too, which is how they know who dispatched
-- their work.
create policy company_users_select_members
  on public.company_users
  for select
  to authenticated
  using ((select app.has_company(company_id)));

create policy company_users_insert_admins
  on public.company_users
  for insert
  to authenticated
  with check (
    (select app.can_write_company(company_id))
    and (select app.can_manage_company(company_id))
  );

create policy company_users_update_admins
  on public.company_users
  for update
  to authenticated
  using ((select app.can_manage_company(company_id)))
  with check (
    (select app.can_write_company(company_id))
    and (select app.can_manage_company(company_id))
  );

create policy company_users_delete_admins
  on public.company_users
  for delete
  to authenticated
  using (
    (select app.can_write_company(company_id))
    and (select app.can_manage_company(company_id))
  );

-- ----------------------------------------------------------------------------
-- driver_profiles
--
-- The one table with no company_id. Its isolation rule is different in kind:
-- a driver owns their row, and a company earns sight of it by being accepted.
-- ----------------------------------------------------------------------------

create policy driver_profiles_select_own
  on public.driver_profiles
  for select
  to authenticated
  using (auth_user_id = (select auth.uid()));

-- Acceptance is all-or-nothing, so this is a whole-row grant rather than a
-- column-level one. A company sees a driver's licence details and contact
-- information from the moment that driver accepts, and not a moment before.
--
-- Invited-but-not-accepted links deliberately do NOT match: the inviting
-- company can see the stub it created only through the invitation it holds.
create policy driver_profiles_select_linked_companies
  on public.driver_profiles
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.driver_company_links dcl
       where dcl.driver_profile_id = driver_profiles.id
         and dcl.status = 'active'
         and (select app.has_company(dcl.company_id))
    )
  );

-- A driver claims their own profile when they first sign in. They may only
-- attach their own auth user, and only to a row that is not already claimed;
-- both halves are enforced by app.claim_driver_profile() in 0009, which is the
-- only supported path. Direct inserts are for a driver creating their own
-- profile from scratch.
create policy driver_profiles_insert_self
  on public.driver_profiles
  for insert
  to authenticated
  with check (auth_user_id = (select auth.uid()));

create policy driver_profiles_update_own
  on public.driver_profiles
  for update
  to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

-- Companies cannot edit a driver's global profile. Anything company-specific
-- about that driver -- pay rate, terms, notes, employment type -- belongs on
-- driver_company_links, which they do control.

-- ----------------------------------------------------------------------------
-- driver_company_links
-- ----------------------------------------------------------------------------

-- Both sides of the relationship can see it: the company that issued it, and
-- the driver it concerns. The driver clause covers invited links too, since a
-- driver must be able to see an invitation in order to accept it.
create policy driver_company_links_select
  on public.driver_company_links
  for select
  to authenticated
  using (
    (select app.has_company(company_id))
    or driver_profile_id = (select app.current_driver_profile_id())
  );

create policy driver_company_links_insert_dispatchers
  on public.driver_company_links
  for insert
  to authenticated
  with check (
    (select app.can_write_company(company_id))
    and (select app.can_dispatch(company_id))
    -- A company may only ever create a link in the 'invited' state. Nobody can
    -- self-serve their way to an active link: that transition belongs to the
    -- driver, through app.accept_driver_link() in 0009.
    and status = 'invited'
  );

-- Company side: change the commercial terms, or deactivate the driver.
create policy driver_company_links_update_dispatchers
  on public.driver_company_links
  for update
  to authenticated
  using (
    (select app.can_write_company(company_id))
    and (select app.can_dispatch(company_id))
  )
  with check (
    (select app.can_write_company(company_id))
    and (select app.can_dispatch(company_id))
  );

-- Driver side: accept or decline. Restricted to their own link. Moving a link
-- to 'active' also requires accepted_at to be set, which the table's check
-- constraint enforces regardless of who is writing.
create policy driver_company_links_update_own
  on public.driver_company_links
  for update
  to authenticated
  using (driver_profile_id = (select app.current_driver_profile_id()))
  with check (driver_profile_id = (select app.current_driver_profile_id()));

create policy driver_company_links_delete_admins
  on public.driver_company_links
  for delete
  to authenticated
  using (
    (select app.can_write_company(company_id))
    and (select app.can_manage_company(company_id))
  );

-- ----------------------------------------------------------------------------
-- invitations
--
-- Readable by the issuing company's dispatchers, and by the invitee once they
-- have an account whose email matches. Acceptance by token happens through a
-- SECURITY DEFINER function in 0009, because someone accepting an invitation
-- usually has no membership yet and therefore cannot see the row at all.
-- ----------------------------------------------------------------------------

create policy invitations_select_issuer
  on public.invitations
  for select
  to authenticated
  using (
    (select app.has_company(company_id))
    and (select app.can_dispatch(company_id))
  );

create policy invitations_select_invitee
  on public.invitations
  for select
  to authenticated
  using (lower(email) = (select app.current_user_email()));

create policy invitations_insert_dispatchers
  on public.invitations
  for insert
  to authenticated
  with check (
    (select app.can_write_company(company_id))
    and (select app.can_dispatch(company_id))
    and status = 'pending'
  );

-- Revoking or resending. Acceptance is not done here.
create policy invitations_update_dispatchers
  on public.invitations
  for update
  to authenticated
  using (
    (select app.can_write_company(company_id))
    and (select app.can_dispatch(company_id))
  )
  with check (
    (select app.can_write_company(company_id))
    and (select app.can_dispatch(company_id))
  );
