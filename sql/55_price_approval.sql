-- ===========================================================================
-- 55_price_approval.sql — Admin approval for special/custom pricing
--
-- Any order line where the rep's price differs from the system default
-- (is_special_price = true, already computed at order-save time) now requires
-- Admin sign-off before it can be billed. ONLY that line is held — the rest
-- of the order proceeds through Billing normally.
--
-- approval_status is null for ordinary (non-special) lines — no workflow
-- applies to them at all. For special-priced lines it starts 'pending' and
-- becomes 'approved' or 'rejected'.
-- ===========================================================================

alter table order_items add column if not exists approval_status text;      -- null | 'pending' | 'approved' | 'rejected'
alter table order_items add column if not exists approved_by text;
alter table order_items add column if not exists approved_by_id uuid;
alter table order_items add column if not exists approved_at timestamptz;
alter table order_items add column if not exists approval_reason text;      -- optional note (mainly for rejection)

create index if not exists order_items_pending_approval_idx
  on order_items (order_id)
  where approval_status = 'pending';

notify pgrst, 'reload schema';
