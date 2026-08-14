-- ============================================================================
-- Alpha Trade Links — Bulk catch-up: mark real pending orders as Verified /
-- QC-Verified / Delivered, for orders placed up to and including TODAY.
--
-- Use case: these orders were genuinely billed, checked, and delivered in
-- real life during the testing period — the app's records just need to catch
-- up. This is a data-correction operation, not a workflow shortcut.
--
-- SCOPE: only orders with created_at <= end of TODAY (Asia/Kolkata) that are
-- still billing_status = 'pending'. Anything created after today (or already
-- in progress) is left completely untouched.
--
-- IMPORTANT — run PART 0 (preview) first and read the numbers before running
-- PART 1-4. If the counts don't look right, STOP and tell Claude before
-- proceeding — this is real business data.
-- ============================================================================

-- ── PART 0 — PREVIEW ONLY (run this first, changes nothing) ─────────────────
select
  count(*) as orders_to_verify,
  min(created_at) as earliest_order,
  max(created_at) as latest_order
from public.orders
where billing_status = 'pending'
  and created_at <= (current_date + interval '1 day') at time zone 'Asia/Kolkata';

-- Look at the actual list before proceeding, if you want to double check:
-- select id, shop_name, sales_rep_id, created_at from public.orders
-- where billing_status = 'pending'
--   and created_at <= (current_date + interval '1 day') at time zone 'Asia/Kolkata'
-- order by created_at;

-- ============================================================================
-- STOP HERE. Confirm the preview count looks right before running Part 1-4.
-- ============================================================================

-- ── PART 1 — Mark Billing Verified ───────────────────────────────────────────
-- Mirrors exactly what verify_order_to_delivery() sets on `orders`. The note
-- is set unconditionally (not coalesced) so Parts 2-4 below can reliably find
-- exactly these rows and touch nothing else.
update public.orders
set billing_status = 'verified',
    billing_verified_at = now(),
    billing_notes = 'Bulk-verified: real order confirmed complete during testing period.'
where billing_status = 'pending'
  and created_at <= (current_date + interval '1 day') at time zone 'Asia/Kolkata';

-- ── PART 2 — Create delivery records ─────────────────────────────────────────
-- Mirrors exactly what verify_order_to_delivery() inserts into `deliveries`,
-- for every order we just verified that doesn't already have one. The QC
-- push-notification trigger is disabled for this one bulk step ONLY, so QC
-- devices are not flooded with alerts for work that's already long done —
-- it is re-enabled immediately after.
alter table public.deliveries disable trigger trg_notify_qc_on_delivery;

insert into public.deliveries (order_id, shop_name, route, sales_rep_name, status, qc_status)
select
  o.id,
  o.shop_name,
  coalesce(o.route, ''),
  coalesce(p.full_name, ''),
  'pending',
  'qc_pending'
from public.orders o
left join public.profiles p on p.id = o.sales_rep_id
where o.billing_status = 'verified'
  and o.billing_notes = 'Bulk-verified: real order confirmed complete during testing period.'
  and not exists (select 1 from public.deliveries d where d.order_id = o.id);

alter table public.deliveries enable trigger trg_notify_qc_on_delivery;

-- ── PART 3 — Mark Quality Check Verified ─────────────────────────────────────
update public.deliveries d
set qc_status = 'qc_verified',
    packed_by = 'Bulk Update',
    qc_verified_at = now()
from public.orders o
where d.order_id = o.id
  and o.billing_notes = 'Bulk-verified: real order confirmed complete during testing period.'
  and d.qc_status = 'qc_pending';

-- ── PART 4 — Mark Delivered ───────────────────────────────────────────────────
update public.deliveries d
set status = 'delivered',
    completion_note = coalesce(completion_note, 'Bulk-verified: real delivery confirmed complete during testing period.'),
    completed_at = now()
from public.orders o
where d.order_id = o.id
  and o.billing_notes = 'Bulk-verified: real order confirmed complete during testing period.'
  and d.status = 'pending';

-- ── VERIFY — should return 0 rows if everything above worked correctly ──────
select o.id, o.shop_name, o.billing_status, d.qc_status, d.status
from public.orders o
join public.deliveries d on d.order_id = o.id
where o.billing_notes = 'Bulk-verified: real order confirmed complete during testing period.'
  and (o.billing_status <> 'verified' or d.qc_status <> 'qc_verified' or d.status <> 'delivered');

-- Done. Orders placed up to and including today have been marked Verified,
-- QC-Verified, and Delivered. Anything created after today, or already
-- mid-workflow, was left untouched.
