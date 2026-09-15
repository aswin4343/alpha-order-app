-- ===========================================================================
-- 63_price_versioning.sql
--
-- Adds price governance infrastructure:
--
-- 1. Products: price versioning + wholesale threshold + last approved price
-- 2. Order_items: approved_price_version for stale-approval detection
-- 3. Orders: bill_approval_required flag (entire bill needs admin before billing)
--
-- Safe to re-run: uses "add column if not exists" throughout.
-- ===========================================================================

-- Price versioning on products
alter table public.products
  add column if not exists price_version         integer not null default 1,
  add column if not exists price_changed_at      timestamptz,
  add column if not exists price_changed_by      uuid references public.profiles(id),
  add column if not exists price_increased       boolean not null default false,
  add column if not exists previous_retail       numeric,
  add column if not exists previous_wholesale    numeric,
  -- Wholesale threshold: selling qty at which wholesale price is auto-allowed
  -- Defaults to qty_in_box (1 full box). Set explicitly via Excel or Admin.
  add column if not exists wholesale_threshold   integer,
  -- Last approved price (per product, reusable until next price version)
  add column if not exists last_approved_price       numeric,
  add column if not exists last_approved_version     integer,  -- price_version it was approved against
  add column if not exists last_approved_at          timestamptz,
  add column if not exists last_approved_by          uuid references public.profiles(id);

-- Order items: track which price version was current at approval time
alter table public.order_items
  add column if not exists approved_price_version integer,
  add column if not exists approval_reason        text;   -- structured reason code

-- Orders: bill-level approval flag (whole bill blocked from billing until approved)
alter table public.orders
  add column if not exists bill_approval_required boolean not null default false,
  add column if not exists bill_approval_status   text,    -- null | 'pending' | 'approved' | 'rejected'
  add column if not exists bill_approved_at       timestamptz,
  add column if not exists bill_approved_by       uuid references public.profiles(id),
  add column if not exists bill_rejection_reason  text;

-- Index for efficient pending bill lookups
create index if not exists orders_bill_approval_idx on public.orders (bill_approval_status)
  where bill_approval_status = 'pending';

notify pgrst, 'reload schema';
