-- ============================================================================
-- HOTFIX (this session) — order_items.price_type was missing from the live DB
-- despite the app code expecting it. Discovered via a full schema audit after
-- Billing broke in production. Safe to re-run (idempotent).
-- ============================================================================

alter table public.order_items
  add column if not exists price_type text; -- 'WHOLESALE' | 'RETAIL' | 'MRP' | 'CUSTOM' | null (legacy orders)

notify pgrst, 'reload schema';

-- Done.
