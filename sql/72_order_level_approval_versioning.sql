-- ===========================================================================
-- 72_order_level_approval_versioning.sql
--
-- PURPOSE:
--   Upgrades the approval workflow from product-level to ORDER-LEVEL.
--   Admin approves or rejects the FULL ORDER, not individual products.
--   Sales Rep resubmits the FULL ORDER with revised prices.
--   Each resubmission is a new "approval version" — history is preserved.
--
-- CHANGES:
--   1. orders — add approval_version (which attempt this is, starts at 1)
--   2. orders — add bill_rejection_reason already exists (no change needed)
--   3. price_approval_history — add approval_version so each history row
--      knows which attempt it belongs to
--   4. RLS — sales reps must be able to read price_approval_history for their
--      own orders (so the rep can see the rejection reason + version history)
--
-- SAFE TO RE-RUN: all ALTER TABLEs use "add column if not exists".
-- NO DATA IS DELETED OR MODIFIED.
-- ===========================================================================

-- 1. Approval version counter on orders (1 = first submission)
alter table public.orders
  add column if not exists approval_version integer not null default 1;

-- 2. Track approval version on each history record
alter table public.price_approval_history
  add column if not exists approval_version integer;

-- 3. Add bill_rejection_reason to orders if it doesn't exist (it may already)
alter table public.orders
  add column if not exists bill_rejection_reason text;

-- 4. Populate existing rows: if an order has bill_approval_status set,
--    it has already gone through at least version 1.
--    (approval_version defaults to 1 for all existing rows — already done above.)

-- 5. RLS: Sales rep can read price_approval_history for their own orders.
--    Previously only Admin could read this table. The Sales Rep needs to see
--    the rejection reason and version history on their own items.
drop policy if exists price_approval_history_rep_select on public.price_approval_history;
create policy price_approval_history_rep_select on public.price_approval_history
  for select
  using (
    -- Rep can see history for any order_id that belongs to them
    order_id in (
      select id from public.orders where sales_rep_id = auth.uid()
    )
    -- Admin can also see everything (existing policy covers this, but safe to add)
    or public.is_admin()
  );

-- 6. Sales rep INSERT into price_approval_history (for resubmit audit records)
drop policy if exists price_approval_history_rep_insert on public.price_approval_history;
create policy price_approval_history_rep_insert on public.price_approval_history
  for insert
  with check (
    -- Rep can only insert history for their own orders
    order_id in (
      select id from public.orders where sales_rep_id = auth.uid()
    )
    or public.is_admin()
  );

notify pgrst, 'reload schema';
