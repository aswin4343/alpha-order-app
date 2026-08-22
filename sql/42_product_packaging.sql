-- ===========================================================================
-- 42_product_packaging.sql
-- Adds per-product packaging/conversion master data so a sales rep can order
-- in Piece / Outer / Box while Billing always receives individual pieces.
--
--   qty_in_box = total individual pieces in one box   (Pieces Per Box)
--   outer_qty  = number of outer units inside one box
--   box        = box unit count (informational, usually 1)
--
-- Derived in the app (never stored): pieces_per_outer = qty_in_box / outer_qty.
-- All nullable — a product with no packaging data simply offers only "Piece".
-- Existing price/GST/scheme columns are untouched.
-- ===========================================================================

alter table products add column if not exists qty_in_box numeric;
alter table products add column if not exists outer_qty  numeric;
alter table products add column if not exists box        numeric;

-- Order-line audit of the rep's original entry before piece-conversion.
-- order_items.qty is ALWAYS individual pieces; these record what was typed.
alter table order_items add column if not exists entered_qty  numeric;
alter table order_items add column if not exists entered_unit text;

-- Reload PostgREST schema cache so the API serves the new columns immediately.
notify pgrst, 'reload schema';
