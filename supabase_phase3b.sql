-- ============================================================================
-- Alpha Trade Links V3 — Phase 3B security update
-- Opens shop ORDER HISTORY to all logged-in reps (needed for the
-- previous-order loader to show any rep's past orders for a shop).
--
-- Admin-only analytics are unaffected. Personal performance still filters
-- to the logged-in rep in the app. This only widens READ access to order
-- history across the team.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

-- ORDERS: any authenticated user may read; writes still restricted to owner.
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders
  for select using ( auth.uid() is not null );

-- ORDER ITEMS: readable if the parent order is readable (now = any auth user).
drop policy if exists order_items_read on public.order_items;
create policy order_items_read on public.order_items
  for select using ( auth.uid() is not null );

-- (insert/update policies from Phase 3A remain unchanged — a rep can still
--  only create/edit their own orders.)

-- Verify current policies on orders:
select policyname, cmd
from pg_policies
where schemaname = 'public' and tablename in ('orders','order_items')
order by tablename, policyname;
