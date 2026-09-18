-- Migration 69: Fix stuck orders where all items approved but billing_status
-- was never transitioned from 'pending_approval' → 'pending'.
--
-- ROOT CAUSE (v182):
--   approveSpecialPrice() only updated order_items.approval_status but never
--   updated orders.billing_status, leaving the parent order permanently hidden
--   from the Billing Team's .neq('billing_status','pending_approval') filter.
--
-- This migration is safe to run multiple times (idempotent WHERE clauses).
-- It ONLY touches orders that are genuinely stuck:
--   - billing_status = 'pending_approval'
--   - AND no order_items remain with approval_status = 'pending' (non-removed)
--   - AND at least one order_items row has approval_status = 'approved'
--
-- Orders where a rep hasn't acted yet (still has pending items) are left alone.

BEGIN;

-- ─── Step 1: Identify and fix stuck orders ───────────────────────────────────
-- A stuck order = billing_status='pending_approval' but zero pending items left.
-- We promote these to billing_status='pending' so Billing can process them.

WITH stuck_orders AS (
  SELECT
    o.id              AS order_id,
    -- Count pending items (non-removed)
    COUNT(CASE WHEN oi.approval_status = 'pending' AND (oi.removed IS NULL OR oi.removed = false) THEN 1 END)
      AS pending_count,
    -- Count approved items (non-removed)
    COUNT(CASE WHEN oi.approval_status = 'approved' AND (oi.removed IS NULL OR oi.removed = false) THEN 1 END)
      AS approved_count,
    -- Recalculate totals from approved non-removed items
    COALESCE(
      SUM(CASE
        WHEN oi.approval_status = 'approved' AND (oi.removed IS NULL OR oi.removed = false)
        THEN COALESCE(oi.approved_price, oi.unit_price, 0) * COALESCE(oi.qty, 0)
        ELSE 0
      END), 0
    ) AS recalc_value,
    COALESCE(
      SUM(CASE
        WHEN oi.approval_status = 'approved' AND (oi.removed IS NULL OR oi.removed = false)
        THEN COALESCE(oi.qty, 0) ELSE 0
      END), 0
    ) AS recalc_qty,
    COUNT(CASE
      WHEN oi.approval_status = 'approved' AND (oi.removed IS NULL OR oi.removed = false)
      THEN 1 END
    ) AS recalc_products
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  WHERE
    o.billing_status = 'pending_approval'
    AND (o.hidden IS NULL OR o.hidden = false)
  GROUP BY o.id
),
fixable AS (
  SELECT * FROM stuck_orders
  WHERE pending_count = 0   -- no items still waiting for decision
    AND approved_count > 0  -- at least one item was approved (not all rejected)
)
UPDATE orders
SET
  billing_status          = 'pending',
  bill_approval_status    = 'approved',
  bill_approved_at        = NOW(),
  bill_approval_required  = false,
  total_value             = ROUND(fixable.recalc_value),
  total_quantity          = fixable.recalc_qty,
  total_products          = fixable.recalc_products
FROM fixable
WHERE orders.id = fixable.order_id
  AND orders.billing_status = 'pending_approval'; -- double-check idempotency

-- ─── Step 2: Report what was fixed (shows up in migration output) ─────────────
DO $$
DECLARE
  fixed_count INTEGER;
BEGIN
  GET DIAGNOSTICS fixed_count = ROW_COUNT;
  RAISE NOTICE 'Migration 69: promoted % stuck order(s) from pending_approval → pending (Billing Team can now see them)', fixed_count;
END $$;

-- ─── Step 3: Audit — log what was changed in price_approval_history ──────────
-- This gives the team a paper trail that a backfill ran for these orders.
-- Non-fatal: only runs if price_approval_history table exists.
DO $$
BEGIN
  INSERT INTO price_approval_history (
    order_id, product_name, shop_name, order_date,
    decision, decided_by, decided_at, rejection_reason
  )
  SELECT
    o.id,
    'BACKFILL: order promoted by migration 69',
    o.shop_name,
    o.order_date,
    'approved',
    'system-migration-69',
    NOW(),
    'Order was stuck in pending_approval with all items already approved. Promoted to pending by migration 69 (v182 fix).'
  FROM orders o
  WHERE o.billing_status = 'pending'
    AND o.bill_approved_at = (SELECT MAX(bill_approved_at) FROM orders WHERE bill_approval_status = 'approved' AND bill_approved_at IS NOT NULL LIMIT 1)
    -- A rough filter; doesn't need to be perfect — this is just an audit note
  LIMIT 0; -- disable this block for now; uncomment if audit trail is needed
  -- The LIMIT 0 above makes this a no-op — remove it to enable audit entries.
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'price_approval_history audit insert skipped (table may not exist): %', SQLERRM;
END $$;

COMMIT;

-- ─── Manual verification query (run after migration) ────────────────────────
-- SELECT o.id, o.shop_name, o.order_date, o.billing_status, o.bill_approval_status,
--        COUNT(oi.id) AS total_items,
--        COUNT(CASE WHEN oi.approval_status = 'pending' THEN 1 END) AS pending_items,
--        COUNT(CASE WHEN oi.approval_status = 'approved' THEN 1 END) AS approved_items
-- FROM orders o
-- JOIN order_items oi ON oi.order_id = o.id
-- WHERE o.billing_status = 'pending_approval'
-- GROUP BY o.id, o.shop_name, o.order_date, o.billing_status, o.bill_approval_status
-- ORDER BY o.order_date DESC;
-- (Should return 0 rows after migration runs successfully.)
