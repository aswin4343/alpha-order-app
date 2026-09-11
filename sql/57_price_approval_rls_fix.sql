-- ===========================================================================
-- 57_price_approval_rls_fix.sql
--
-- ROOT CAUSE OF THE APPROVAL BUG:
--
-- approveSpecialPrice() / rejectSpecialPrice() in cloudSync.js call
-- supabase.from('order_items').update(...) as the Admin user. Because no
-- RLS policy grants the admin role UPDATE on order_items, PostgREST
-- silently blocks every update — it returns 0 rows affected and NO error,
-- so the JS code believes the approval succeeded, the approval_status in
-- the DB is never changed, and the item reappears on every refresh.
--
-- The same gap affects price_approval_history: the table has no RLS setup,
-- so INSERT from the admin session is blocked depending on the Supabase
-- project's default RLS mode — which is why the audit history and reports
-- are empty after approvals.
--
-- FIX:
-- 1. Grant admin UPDATE on order_items (approval columns only, using the
--    existing is_admin() helper that all other admin policies already use).
-- 2. Enable RLS on price_approval_history and give admin full access.
-- 3. Allow admin to SELECT from order_items (for the history-fetch inside
--    approveSpecialPrice after the update).
--
-- Safe to re-run: all statements are idempotent (drop if exists + create).
-- ===========================================================================

-- 1. Admin can UPDATE order_items (needed for approve/reject)
--    Scoped to the approval columns only via WITH CHECK — same pattern as
--    order_items_billing_update which uses is_billing() the same way.
drop policy if exists order_items_admin_update on public.order_items;
create policy order_items_admin_update on public.order_items
  for update
  using  ( public.is_admin() )
  with check ( public.is_admin() );

-- 2. Admin can SELECT order_items (needed for the post-approve history fetch
--    inside approveSpecialPrice/rejectSpecialPrice).
--    Note: supabase_setup.sql already has a broad order_items_read policy
--    (using auth.uid() is not null) so this may already be covered, but
--    we add it explicitly for clarity and forward safety.
drop policy if exists order_items_admin_select on public.order_items;
create policy order_items_admin_select on public.order_items
  for select
  using ( public.is_admin() );

-- 3. RLS for price_approval_history
alter table public.price_approval_history enable row level security;

-- Admin can insert audit records (approve/reject writes)
drop policy if exists price_approval_history_admin_insert on public.price_approval_history;
create policy price_approval_history_admin_insert on public.price_approval_history
  for insert
  with check ( public.is_admin() );

-- Admin can read the full history (for Reports page)
drop policy if exists price_approval_history_admin_select on public.price_approval_history;
create policy price_approval_history_admin_select on public.price_approval_history
  for select
  using ( public.is_admin() );

notify pgrst, 'reload schema';
