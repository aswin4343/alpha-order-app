-- ===========================================================================
-- 58_price_approval_toggle.sql
--
-- Adds a runtime on/off toggle for the Price Approval workflow to the
-- existing app_settings singleton table (already admin-only RLS).
-- Default is true (on), matching the current build-time flag.
-- The Admin can flip this from Admin → Settings without a redeployment.
-- ===========================================================================

alter table public.app_settings
  add column if not exists price_approval_enabled boolean not null default true;

-- Also allow all authenticated users to READ app_settings so the rep app
-- can check the flag at order time. Write stays admin-only (existing policy).
drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
  for select using ( auth.uid() is not null );

notify pgrst, 'reload schema';
