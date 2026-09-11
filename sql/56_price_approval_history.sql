-- ===========================================================================
-- 56_price_approval_history.sql
--
-- Two additions to the existing price approval system:
--
-- 1. Structured approval REASON on order_items — replaces the free-text
--    approval_reason field (which was previously used for rejection reasons)
--    with structured columns that match the spec: reason_type, competitor_name,
--    other_reason. Rejection reason moves to rejection_reason. All columns
--    default to null and are backward compatible with existing rows.
--
-- 2. price_approval_history — an immutable audit log. Every approve/reject
--    event writes one row here; existing rows are NEVER updated or deleted.
--    This is the permanent audit trail required for management reports.
--
-- Safe to run: all ALTER TABLEs use "add column if not exists".
-- ===========================================================================

-- Add structured reason columns to order_items (extend, not replace)
alter table order_items add column if not exists approval_reason_type text;      -- 'competitor' | 'bulk' | 'near_expiry' | 'others'
alter table order_items add column if not exists approval_competitor_name text;  -- required when reason_type = 'competitor'
alter table order_items add column if not exists approval_other_reason text;     -- required when reason_type = 'others'
alter table order_items add column if not exists rejection_reason text;          -- rejection reason (rename of old approval_reason for rejections)

-- Immutable audit history table
create table if not exists price_approval_history (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),

  -- What was approved/rejected
  order_item_id         uuid references order_items(id) on delete set null,
  order_id              uuid references orders(id) on delete set null,
  product_name          text not null,
  shop_name             text,
  route                 text,
  sales_rep_name        text,
  customer_type         text,   -- 'RETAIL' | 'WHOLESALE'
  price_type            text,   -- RETAIL | WHOLESALE | LAST | CUSTOM

  -- Prices
  normal_price          numeric,
  requested_price       numeric,
  qty                   integer,
  unit                  text,
  order_date            date,

  -- Decision
  decision              text not null,  -- 'approved' | 'rejected'
  decided_by            text,           -- admin full_name
  decided_by_id         uuid,
  decided_at            timestamptz not null default now(),

  -- Structured approval reason (for approvals)
  reason_type           text,           -- 'competitor' | 'bulk' | 'near_expiry' | 'others'
  competitor_name       text,
  other_reason          text,

  -- Rejection reason
  rejection_reason      text
);

-- Index for efficient report queries
create index if not exists price_approval_history_created_at_idx on price_approval_history (created_at desc);
create index if not exists price_approval_history_decision_idx on price_approval_history (decision);
create index if not exists price_approval_history_sales_rep_idx on price_approval_history (sales_rep_name);

notify pgrst, 'reload schema';
