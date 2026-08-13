-- ============================================================================
-- Alpha Trade Links — Order Item price/scheme capture (for Order Summary)
--
-- order_items never stored per-line price or scheme, so full order summaries
-- could only show product + qty, not what was actually charged/offered.
--
-- This adds two NULLABLE columns. Existing rows stay NULL (we cannot know
-- historical prices — they were never recorded, and today's catalogue price
-- may differ from what was charged at the time). Going forward, saveCloudOrder
-- writes the effective unit price + scheme text at the moment the order is
-- placed, so future Order Summaries can show a real, accurate breakdown.
--
-- Purely additive — no existing column, calculation, or row is changed.
-- Run in Supabase → SQL Editor.
-- ============================================================================

alter table public.order_items
  add column if not exists unit_price numeric,       -- effective price charged per unit, at order time
  add column if not exists scheme_applied text;       -- human-readable scheme text at order time, if any

-- Done.
