-- ============================================================================
-- Alpha Trade Links — Store Selected Price Type alongside Final Selling Rate
--
-- unit_price / normal_price / is_special_price already exist (earlier phase).
-- This adds the missing piece: WHICH price type was actually selected
-- (WHOLESALE | RETAIL | MRP | CUSTOM), per the pricing/billing update spec's
-- explicit "store both price type and final rate" requirement.
--
-- Purely additive. Run in Supabase → SQL Editor.
-- ============================================================================

alter table public.order_items
  add column if not exists price_type text; -- 'WHOLESALE' | 'RETAIL' | 'MRP' | 'CUSTOM' | null (legacy orders)

-- Done.
