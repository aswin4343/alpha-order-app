-- ============================================================================
-- ATL Flow — Billing snapshot columns on order_items
--
-- Captures MRP, GST% and HSN from the product AT ORDER TIME, same reasoning as
-- the existing normal_price/scheme_applied/free_qty snapshots: the catalogue
-- can change after an order is placed, but a bill for that order must always
-- reflect what applied when it was placed, not what's true today.
--
-- Purely additive — nullable, no data touched. Orders placed BEFORE this ships
-- will simply have these fields empty (Full Bill/Picker Bill fall back to the
-- live catalogue by product name for those older rows only).
-- Run in Supabase → SQL Editor.
-- ============================================================================

alter table public.order_items
  add column if not exists mrp numeric,          -- MRP at order time
  add column if not exists gst_percent numeric,   -- GST % at order time (0/5/12/18/28)
  add column if not exists hsn text;              -- HSN code at order time

-- Done.
