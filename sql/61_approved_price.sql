-- ===========================================================================
-- 61_approved_price.sql
--
-- Adds approved_price to order_items so the Admin can modify the requested
-- price before approving (spec: admin can approve at a different value from
-- what the rep requested; both must be stored separately).
--
-- Also adds approved_price to price_approval_history for the audit trail.
-- Safe to re-run: uses "add column if not exists".
-- ===========================================================================

alter table public.order_items
  add column if not exists approved_price numeric;   -- set by admin on approval; null = use unit_price

alter table public.price_approval_history
  add column if not exists approved_price numeric;   -- the price admin actually approved (may differ from requested_price)

notify pgrst, 'reload schema';
