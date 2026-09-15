-- ===========================================================================
-- 62_sell_by_units.sql
--
-- Adds three selling-unit permission flags to the products table:
--   sell_by_piece  — can this product be sold as individual Pieces?
--   sell_by_outer  — can this product be sold as Outers?
--   sell_by_box    — can this product be sold as Boxes?
--
-- Safe defaults (backward compatible):
--   sell_by_piece = true   — all existing products keep Piece as an option
--   sell_by_outer = false  — stays false until Admin uploads a file with SELL BY OUTER = YES
--   sell_by_box = false    — stays false until Admin uploads a file with SELL BY BOX = YES
--
-- When Admin uploads a new Master Price List, importFullProducts reads the
-- SELL BY PIECE / SELL BY OUTER / SELL BY BOX columns and overrides these.
-- Existing products not included in the upload retain their current values.
-- ===========================================================================

alter table public.products
  add column if not exists sell_by_piece boolean not null default true,
  add column if not exists sell_by_outer boolean not null default false,
  add column if not exists sell_by_box   boolean not null default false;

notify pgrst, 'reload schema';
