-- ============================================================================
-- Alpha Trade Links V4 — Phase 4C (part 2): Smart shop location system
-- Stores each shop's verified GPS (from delivery), always overwritten with the
-- latest. Used for nearest-first delivery sorting from the hub.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

-- Add location columns to the customers master record (safe: nullable).
alter table public.customers
  add column if not exists shop_latitude double precision,
  add column if not exists shop_longitude double precision,
  add column if not exists location_verified boolean not null default false,
  add column if not exists first_verified_date timestamptz,
  add column if not exists last_delivery_date timestamptz;

-- Allow delivery users to UPDATE a customer's location fields.
-- (customers_insert already lets any authed user insert; add an update policy.)
drop policy if exists customers_delivery_update on public.customers;
create policy customers_delivery_update on public.customers
  for update using ( public.is_delivery() or public.is_admin() )
  with check ( public.is_delivery() or public.is_admin() );

-- Done.
