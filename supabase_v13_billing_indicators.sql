-- ============================================================================
-- Alpha Trade Links — Billing visibility: New Customer, Special Price,
-- Scheme Off (per-order/per-item exceptions, never touching master data)
--
-- Purely additive. Run in Supabase → SQL Editor.
-- ============================================================================

-- 1. NEW CUSTOMER — one-time intro details on the FIRST order only ----------
-- Stored on the order row itself, not the customers table, so this sensitive
-- data touches the cloud exactly once (for Billing to see on that one order)
-- and is never part of the customer's permanent cloud record.
alter table public.orders
  add column if not exists is_new_customer boolean not null default false,
  add column if not exists intro_phone text,
  add column if not exists intro_gstn text,
  add column if not exists intro_credit_days text,
  add column if not exists intro_email text;

-- 2. SPECIAL PRICE — per-line price-override tracking on order_items --------
-- The catalogue/product price never changes; this only records what price
-- was actually used on THIS line, and what the normal price was at the time,
-- so Billing can see "Normal ₹100 → Special ₹90" without it affecting any
-- other order.
alter table public.order_items
  add column if not exists normal_price numeric,     -- catalogue price at order time
  add column if not exists is_special_price boolean not null default false;

-- 3. SCHEME OFF — per-line exception, never touches the product's own scheme -
-- scheme_enabled defaults true (matches "Scheme: ON by default"). Setting it
-- false on one line never modifies public.products' own slabs/scheme config.
alter table public.order_items
  add column if not exists scheme_enabled boolean not null default true;

-- Done.
