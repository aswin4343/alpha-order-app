-- ============================================================================
-- Alpha Trade Links V4 — Order Date (#1) + per-order Route (#2)
--
-- Adds an order_date column so reps can set/choose the order date (default
-- today, future dates allowed). Route is already stored per-order, so no schema
-- change is needed for #2 — the app just lets it be overridden per order.
-- Run in Supabase → SQL Editor. Safe — adds a column, backfills existing rows.
-- ============================================================================

-- 1. Add order_date (date only). Existing orders get their created_at date.
alter table public.orders
  add column if not exists order_date date;

-- 2. Backfill existing orders so nothing is null (use the created date).
update public.orders
set order_date = (created_at at time zone 'Asia/Kolkata')::date
where order_date is null;

-- 3. Index for date-based filtering (billing, reports, performance).
create index if not exists orders_order_date_idx on public.orders(order_date);

-- Done.
