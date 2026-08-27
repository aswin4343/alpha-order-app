-- ===========================================================================
-- 54_fix_reschedule_permission.sql
--
-- Root cause: the Reschedule action needs the SALES REP to UPDATE their own
-- order_items rows (claim + link the reschedule). Every other order_items
-- update in this app (qty edit, remove, replace) has always been done by
-- BILLING, never by a rep — so a rep-permitting UPDATE policy may simply
-- never have existed. If so, the update silently matches ZERO rows (RLS
-- doesn't error, it just filters out rows the policy doesn't allow), which is
-- exactly why the app reports "already rescheduled" even on a brand-new item.
--
-- This ADDS a policy — it only WIDENS access, never narrows or removes any
-- existing policy, so it cannot break Billing's or Admin's existing access.
-- ===========================================================================

-- STEP 1 — Run this first to see what's currently allowed:
--   select policyname, cmd, qual, with_check from pg_policies where tablename = 'order_items';
-- If you see no policy with cmd='UPDATE' that a plain salesperson would
-- satisfy, this confirms the diagnosis.

-- STEP 2 — Grant reps UPDATE on order_items rows that belong to THEIR OWN
-- orders (scoped — a rep still cannot touch another rep's order, or fields
-- unrelated to their own orders' items).
drop policy if exists order_items_rep_update_own on order_items;
create policy order_items_rep_update_own on order_items
  for update
  using (
    exists (
      select 1 from orders o
      where o.id = order_items.order_id
        and o.sales_rep_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from orders o
      where o.id = order_items.order_id
        and o.sales_rep_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
