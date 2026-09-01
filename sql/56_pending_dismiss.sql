-- ===========================================================================
-- 56_pending_dismiss.sql — "Delete" a pending stock-out item
--
-- Lets a rep clear a stock-out line out of Pending Orders when the customer
-- no longer wants it. This is deliberately NON-DESTRUCTIVE:
--
--   * It does NOT touch the parent order. Those orders are already verified
--     and billed — deleting one would destroy real invoice data.
--   * It does NOT delete the order_items row. The original "removed as Stock
--     Out" record stays exactly as it was, so billing history and the
--     Partial Verification report remain complete and auditable.
--
-- It only stamps the line as dismissed, and loadPendingStockOuts filters
-- those out. Reversible by clearing the column.
-- ===========================================================================

alter table order_items add column if not exists pending_dismissed_at timestamptz;
alter table order_items add column if not exists pending_dismissed_by text;

notify pgrst, 'reload schema';
