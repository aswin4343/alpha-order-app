-- ============================================================================
-- Alpha Trade Links — GST % and HSN Code per product (for invoice generation)
--
-- Purely additive. Populated via the existing Product & Price Excel upload —
-- no new upload flow needed, just two optional new columns in the same file.
-- Run in Supabase → SQL Editor.
-- ============================================================================

alter table public.products
  add column if not exists gst numeric,   -- GST % for this product, e.g. 5, 12, 18
  add column if not exists hsn text;      -- HSN code, e.g. '20041000'

-- Free quantity (scheme units) actually applied to each order line, captured
-- AT ORDER TIME — never recomputed later from the product's current scheme,
-- which can change. This is what the invoice's FQTY column reads directly.
alter table public.order_items
  add column if not exists free_qty numeric not null default 0;

-- Done.
