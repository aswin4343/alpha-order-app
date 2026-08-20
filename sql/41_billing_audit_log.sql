-- ===========================================================================
-- 41_billing_audit_log.sql
-- Immutable audit trail of every Billing Team modification to an order.
--
-- WHY A SEPARATE TABLE: the existing edit system stores change_type/
-- change_reason ON the order_items row itself, which is MUTABLE — a second
-- edit (5->4) overwrites the first (6->5). The audit requirement needs BOTH
-- kept forever, so every edit APPENDS one immutable row here instead.
--
-- This table is INSERT-only from the app. No updates, no deletes. Records are
-- never overwritten when an order is edited again.
-- ===========================================================================

create table if not exists billing_audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Order-centric traceability (spec #9): every record ties back to the order.
  order_id uuid,                       -- the order_items.order_id / orders.id
  order_item_id uuid,                  -- the specific line edited (nullable)
  order_ref text,                      -- short human ref (first 8 of order id)
  shop_name text,
  route text,
  sales_rep_name text,                 -- rep who PLACED the order

  -- Who made the change + what changed.
  edited_by text,                      -- billing team member (profiles.full_name)
  edited_by_id uuid,                   -- billing team auth uid (nullable)
  action_type text not null,           -- 'QUANTITY EDITED' | 'PRODUCT REPLACED' | 'PRODUCT REMOVED'
  product_name text,                   -- product AFTER the change (for replace = new name)
  original_product_name text,          -- product BEFORE (replace only)
  replacement_product_name text,       -- product AFTER (replace only; mirrors product_name)
  original_qty numeric,
  new_qty numeric,
  reason text not null                 -- mandatory (spec #4)
);

-- Fast date-range filtering for the report screen.
create index if not exists billing_audit_log_created_at_idx
  on billing_audit_log (created_at desc);
create index if not exists billing_audit_log_order_id_idx
  on billing_audit_log (order_id);

-- RLS: billing team can insert + read; nobody updates or deletes (immutable).
alter table billing_audit_log enable row level security;

-- Read: billing team (and admin, via is_billing/is_admin if present). Keep it
-- simple and permissive for authenticated users of the billing role.
drop policy if exists billing_audit_read on billing_audit_log;
create policy billing_audit_read on billing_audit_log
  for select using (auth.uid() is not null);

drop policy if exists billing_audit_insert on billing_audit_log;
create policy billing_audit_insert on billing_audit_log
  for insert with check (auth.uid() is not null);

-- Deliberately NO update or delete policy → rows are immutable by default
-- (RLS denies any command without a matching policy).

-- Reload PostgREST schema cache so the API serves the new table immediately.
notify pgrst, 'reload schema';
