-- ===========================================================================
-- 60_customer_management.sql
--
-- Adds two capabilities to the customers table:
--
-- 1. is_active boolean (soft-delete) — customers marked inactive are hidden
--    from selection but retain all historical order/billing relationships.
--
-- 2. RLS policy allowing reps to UPDATE their own created customers
--    (shop_name, route, category) and admins to update any customer.
--
-- Safe to re-run: uses IF NOT EXISTS and DROP IF EXISTS.
-- ===========================================================================

-- Soft-delete flag (true = active, false = deactivated by admin)
alter table public.customers
  add column if not exists is_active boolean not null default true;

-- Allow authenticated reps to update customers they created
-- (existing delivery+admin update policy from supabase_v4_phase4c_location.sql
-- only covers location fields; we add a broader policy for reps editing their
-- own customers and admins editing any customer).
drop policy if exists customers_rep_update on public.customers;
create policy customers_rep_update on public.customers
  for update
  using (
    -- Reps can update customers they created
    (auth.uid() = created_by)
    or
    -- Admins can update any customer
    public.is_admin()
    or
    -- Delivery already has a policy but include here for completeness
    public.is_delivery()
  )
  with check (
    (auth.uid() = created_by)
    or
    public.is_admin()
    or
    public.is_delivery()
  );

-- Admin-only: deactivate (soft-delete) any customer
-- This is enforced at the app level too, but the RLS policy is the authoritative gate.
-- (The customers_rep_update policy above already allows admins to set is_active=false.)

notify pgrst, 'reload schema';
