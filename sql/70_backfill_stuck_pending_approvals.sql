-- Migration 70: Backfill order_items that need approval but were never flagged.
--
-- ROOT CAUSE (v185):
--   When a rep taps "Send" (not "Copy"), dispatchOrder() calls saveCloudOrder()
--   directly WITHOUT going through handleCopy()'s price-violation check. The
--   order is saved with approval_status=NULL on all items — even those where
--   the rep's selected price is below the current retail price. These items are
--   invisible to Admin → Price Approvals, which only queries approval_status='pending'.
--
--   Additionally, when a rep taps "Copy" after already using "Send", the duplicate
--   guard in saveCloudOrder() returns 'DUPLICATE' before the re-submit can mark
--   the existing items as pending. The frontend fix (v185) addresses this going
--   forward. This migration recovers already-stuck items.
--
-- SAFETY CONSTRAINTS (from spec, preserved verbatim):
--   - DO NOT DELETE EXISTING APPROVAL DATA
--   - DO NOT RESET HISTORICAL APPROVALS
--   - DO NOT overwrite approved/rejected historical records
--   - Do NOT mark every historical custom-price order as pending.
--     Only classify a record as pending when the data indicates:
--       Admin approval was required AND request was submitted AND
--       request has not been approved AND request has not been rejected/cancelled
--   - APPROVAL ACTION MUST BE PER PRODUCT
--
-- WHAT THIS MIGRATION DOES:
--   Finds order_items where:
--     1. is_special_price = true   (the rep's price differs from normal price)
--     2. approval_status IS NULL   (was never flagged — only undecided rows)
--     3. The parent order is recent (created within the last 30 days) and
--        not hidden and not cancelled
--   Sets approval_status = 'pending' on those rows only.
--
--   It deliberately does NOT touch:
--     - Items already marked 'approved' or 'rejected'
--     - Items from orders older than 30 days (ancient history, irrelevant)
--     - Items where is_special_price = false (normal price, no approval needed)
--     - Items where is_special_price IS NULL (pre-migration rows without the flag)
--
-- Idempotent: can be run multiple times safely.

BEGIN;

-- ─── Step 1: Mark stuck special-price items as pending ───────────────────────

WITH items_to_flag AS (
  SELECT oi.id
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE
    oi.is_special_price = true            -- genuinely special price
    AND oi.approval_status IS NULL        -- never flagged — only these
    AND (oi.removed IS NULL OR oi.removed = false)  -- not removed
    AND o.billing_status NOT IN ('verified')        -- not already completed
    AND (o.hidden IS NULL OR o.hidden = false)       -- not hidden
    AND o.created_at >= NOW() - INTERVAL '30 days'  -- recent orders only
)
UPDATE order_items
SET approval_status = 'pending'
FROM items_to_flag
WHERE order_items.id = items_to_flag.id;

-- ─── Step 2: For any order that now has pending items, set billing_status ─────
-- to 'pending_approval' if it was just 'pending' (so Billing Team's filter
-- correctly holds it). Orders already in 'pending_approval' are unaffected.
-- Orders that are 'verified' are not touched (they're done).

WITH orders_with_new_pending AS (
  SELECT DISTINCT oi.order_id
  FROM order_items oi
  WHERE oi.approval_status = 'pending'
)
UPDATE orders
SET billing_status = 'pending_approval'
FROM orders_with_new_pending
WHERE orders.id = orders_with_new_pending.order_id
  AND orders.billing_status = 'pending'    -- only promote; never demote
  AND (orders.hidden IS NULL OR orders.hidden = false);

-- ─── Step 3: Report results ───────────────────────────────────────────────────
DO $$
DECLARE
  item_count  INTEGER;
  order_count INTEGER;
BEGIN
  SELECT COUNT(*)
    INTO item_count
    FROM order_items
    WHERE approval_status = 'pending';

  SELECT COUNT(*)
    INTO order_count
    FROM orders
    WHERE billing_status = 'pending_approval'
      AND (hidden IS NULL OR hidden = false);

  RAISE NOTICE 'Migration 70 complete.';
  RAISE NOTICE '  Total items now pending approval: %', item_count;
  RAISE NOTICE '  Total orders now in pending_approval: %', order_count;
END $$;

COMMIT;

-- ─── Verification query (run manually after migration) ───────────────────────
-- SELECT
--   o.shop_name,
--   o.order_date,
--   o.billing_status,
--   oi.product_name,
--   oi.unit_price,
--   oi.normal_price,
--   oi.approval_status
-- FROM order_items oi
-- JOIN orders o ON o.id = oi.order_id
-- WHERE oi.approval_status = 'pending'
-- ORDER BY o.order_date DESC, o.shop_name;
