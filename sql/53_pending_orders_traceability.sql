-- ===========================================================================
-- 53_pending_orders_traceability.sql — Phase 3
-- Lets Billing see, on the NEW order created by a reschedule, exactly which
-- original stock-out line it came from — the reverse pointer to the columns
-- 52 added on the SOURCE item. Both directions are now traceable:
--   original item .rescheduled_order_id      -> points forward to the new order
--   new item      .rescheduled_from_item_id  -> points back to the original line
-- ===========================================================================

alter table order_items add column if not exists rescheduled_from_item_id uuid;
alter table order_items add column if not exists rescheduled_from_order_id uuid;
alter table order_items add column if not exists rescheduled_from_date date;

notify pgrst, 'reload schema';
