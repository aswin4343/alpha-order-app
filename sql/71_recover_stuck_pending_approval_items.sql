-- Migration 71: Recover orders where order_items have approval_status='pending'
-- but the parent order was never flipped to billing_status='pending_approval'.
--
-- ROOT CAUSE (v188 and earlier):
--   saveCloudOrder used evaluatePriceApproval() for billNeedsApproval (strict
--   criteria, allows some wholesale prices below retail without approval), but
--   used a simpler isSpecial check (ep !== normalPrice) for setting
--   order_items.approval_status='pending'. These two could diverge:
--     → order_items.approval_status = 'pending'  (isSpecial fired)
--     → orders.billing_status       = 'pending'  (billNeedsApproval=false)
--     → orders.bill_approval_required = false
--   The Admin notification was never sent and Admin could never see these items.
--   The order flowed straight to Billing while approval items sat pending forever.
--
-- This migration promotes ALL such orphaned orders to billing_status='pending_approval'
-- and sets bill_approval_required=true so Admin can now find and act on them.
--
-- SAFETY:
--   - Idempotent: only touches orders still in billing_status='pending' that
--     have at least one non-removed order_item with approval_status='pending'.
--   - Does NOT touch verified orders.
--   - Does NOT touch already-fixed orders (billing_status='pending_approval').
--   - Does NOT touch orders without any pending approval items.
--   - Does NOT modify approval_status on order_items.
--   - Does NOT delete any data.

BEGIN;

-- ─── Step 1: Identify and promote stuck orders ────────────────────────────────
-- A stuck order = billing_status='pending' BUT has at least one
-- non-removed order_item with approval_status='pending'.

WITH stuck_orders AS (
  SELECT DISTINCT o.id AS order_id
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE
    o.billing_status = 'pending'         -- never got flipped to pending_approval
    AND o.hidden = false
    AND oi.approval_status = 'pending'   -- has items waiting for Admin decision
    AND (oi.removed IS NULL OR oi.removed = false)  -- item is still active
)
UPDATE orders
SET
  billing_status          = 'pending_approval',
  bill_approval_required  = true,
  bill_approval_status    = 'pending'
FROM stuck_orders
WHERE orders.id = stuck_orders.order_id
  AND orders.billing_status = 'pending';  -- double-check idempotency

-- ─── Step 2: Report ───────────────────────────────────────────────────────────
DO $$
DECLARE
  fixed_count INTEGER;
BEGIN
  GET DIAGNOSTICS fixed_count = ROW_COUNT;
  RAISE NOTICE 'Migration 71: promoted % stuck order(s) from pending → pending_approval (Admin can now see them)', fixed_count;
END $$;

COMMIT;

-- ─── Verification query (run after migration) ─────────────────────────────────
-- After this runs, the following query should return 0 rows:
--
-- SELECT o.id, o.shop_name, o.order_date, o.billing_status,
--        COUNT(oi.id) FILTER (WHERE oi.approval_status = 'pending' AND (oi.removed IS NULL OR oi.removed = false)) AS pending_items
-- FROM orders o
-- JOIN order_items oi ON oi.order_id = o.id
-- WHERE o.billing_status = 'pending'
--   AND o.hidden = false
-- GROUP BY o.id, o.shop_name, o.order_date, o.billing_status
-- HAVING COUNT(oi.id) FILTER (WHERE oi.approval_status = 'pending' AND (oi.removed IS NULL OR oi.removed = false)) > 0
-- ORDER BY o.order_date DESC;
--
-- And the CHICKY CHICKZ order should now appear here:
--
-- SELECT o.id, o.shop_name, o.order_date, o.billing_status, o.bill_approval_required,
--        o.bill_approval_status,
--        COUNT(oi.id) FILTER (WHERE oi.approval_status = 'pending') AS pending_items
-- FROM orders o
-- JOIN order_items oi ON oi.order_id = o.id
-- WHERE o.shop_name ILIKE '%CHICKY%'
-- GROUP BY o.id, o.shop_name, o.order_date, o.billing_status, o.bill_approval_required, o.bill_approval_status
-- ORDER BY o.order_date DESC;
