-- ===========================================================================
-- 51_reconcile_purchase_alerts.sql
-- One-time (safe to re-run) reconcile of alert_active.
--
-- Products whose stock dropped to/below their reorder level BEFORE the alert
-- tracking existed (migration 49) never got flagged, so they don't show in
-- Reorder Alerts and never fired a push. This sets the flag correctly for the
-- current state, and clears it for anything that is comfortably above its
-- level (so a future dip can alert cleanly).
--
-- NOTE: this intentionally does NOT fire push notifications for the backlog —
-- it only corrects the state. Future crossings will notify normally.
-- ===========================================================================

-- Flag products that are at/below their reorder level but not marked.
update product_inventory
   set alert_active = true,
       alert_triggered_at = coalesce(alert_triggered_at, now())
 where inventory_initialized = true
   and current_stock <= minimum_stock
   and coalesce(alert_active, false) = false;

-- Clear the flag on products that are safely above their level.
update product_inventory
   set alert_active = false,
       alert_reset_at = coalesce(alert_reset_at, now())
 where inventory_initialized = true
   and current_stock > minimum_stock
   and coalesce(alert_active, false) = true;

-- Verify afterwards:
--   select product_id, current_stock, minimum_stock, alert_active
--   from product_inventory order by current_stock;
