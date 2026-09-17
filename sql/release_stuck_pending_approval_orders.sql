-- ============================================================
-- RELEASE ORDERS WRONGLY STUCK IN pending_approval
-- ============================================================
-- Root cause: saveCloudOrder used a naive "effectivePrice ≠ normalPrice"
-- check to flip orders to pending_approval. This incorrectly caught
-- wholesale-priced orders (wholesale ≠ retail) even when NO genuine
-- price violation existed. Those orders were hidden from Billing.
--
-- This script identifies and releases all such stuck orders:
--   billing_status = 'pending_approval'   (hidden from Billing)
--   bill_approval_status = 'pending'      (Admin hasn't acted yet)
--   hidden = false                        (not rep-deleted)
--
-- Safe to run: it only touches orders where Admin has NOT yet made a
-- decision. Orders that Admin genuinely approved/rejected are untouched.
-- ============================================================

-- Preview first (run this SELECT to see what will be released):
SELECT
  o.id,
  o.shop_name,
  o.route,
  o.order_date,
  o.total_value,
  o.billing_status,
  o.bill_approval_status,
  p.full_name AS rep_name
FROM orders o
LEFT JOIN profiles p ON p.id = o.sales_rep_id
WHERE o.billing_status = 'pending_approval'
  AND (o.bill_approval_status = 'pending' OR o.bill_approval_status IS NULL)
  AND o.hidden = false
ORDER BY o.order_date DESC, o.shop_name;

-- ============================================================
-- ACTUAL FIX: release the stuck orders back to Billing queue
-- (comment out the SELECT above and run this UPDATE)
-- ============================================================

UPDATE orders
SET
  billing_status        = 'pending',
  bill_approval_required = false,
  bill_approval_status  = NULL
WHERE billing_status = 'pending_approval'
  AND (bill_approval_status = 'pending' OR bill_approval_status IS NULL)
  AND hidden = false;

-- Also reset the order_items approval_status that was incorrectly set to
-- 'pending' on items that aren't genuinely special-priced.
-- This resets only items whose ORDER was stuck (joins to the orders above
-- which have now been released), and only items still in 'pending' state.
-- Items that Admin already approved ('approved'/'rejected') are untouched.
UPDATE order_items oi
SET approval_status = NULL
FROM orders o
WHERE oi.order_id = o.id
  AND oi.approval_status = 'pending'
  AND o.billing_status = 'pending'          -- already released by UPDATE above
  AND o.bill_approval_required = false;     -- confirmed released
