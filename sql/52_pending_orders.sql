-- ===========================================================================
-- 52_pending_orders.sql — Pending Orders / Rescheduling (Phase 1+2)
--
-- Deliberately NO new table. A stock-out removal is already a fully-formed
-- order_items row (removed=true, change_type='removed', change_reason='Stock
-- Out'). We only add columns to TRACK its reschedule outcome, reusing the
-- existing order/order_items architecture end-to-end:
--   - "Pending"   = removed=true, change_reason='Stock Out', rescheduled_order_id IS NULL
--   - "Rescheduled" / "Added to Existing Order" = rescheduled_order_id IS NOT NULL
--     (rescheduled_is_addon distinguishes which)
-- The rescheduled item becomes a normal NEW order (via the app's existing
-- saveCloudOrder), so Billing's own existing shop+order_date grouping
-- (see loadBillingCounts) automatically treats it as an add-on if the
-- customer already has an order that date, or as a standalone order if not —
-- no new merge logic needed anywhere.
-- ===========================================================================

alter table order_items add column if not exists rescheduled_to_date date;
alter table order_items add column if not exists rescheduled_order_id uuid;
alter table order_items add column if not exists rescheduled_is_addon boolean;
alter table order_items add column if not exists rescheduled_at timestamptz;
alter table order_items add column if not exists rescheduled_by text;

create index if not exists order_items_pending_stockout_idx
  on order_items (order_id)
  where removed = true and change_reason = 'Stock Out';

notify pgrst, 'reload schema';
