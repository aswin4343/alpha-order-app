-- ============================================================================
-- Alpha Trade Links V4 — QC per-product verification (auto-save + resume)
--
-- Adds per-product QC state on delivery_items so QC can verify product-by-
-- product, auto-saved to the DB, and resume on any device. Adds 'in_progress'
-- QC status handling. Run in Supabase → SQL Editor. Safe — adds columns/policy.
-- ============================================================================

-- 1. Per-product QC state on delivery_items.
alter table public.delivery_items
  add column if not exists qc_state text not null default 'pending', -- pending | verified | error
  add column if not exists qc_error_type text,
  add column if not exists qc_remarks text,
  add column if not exists qc_packed_by text,
  add column if not exists qc_checked_by uuid references public.profiles(id),
  add column if not exists qc_checked_at timestamptz;

create index if not exists delivery_items_qc_state_idx on public.delivery_items(qc_state);

-- 2. QC can UPDATE delivery_items (to save per-product state).
alter table public.delivery_items enable row level security;

drop policy if exists delivery_items_qc_update on public.delivery_items;
create policy delivery_items_qc_update on public.delivery_items
  for update using ( public.is_qc() ) with check ( public.is_qc() );

drop policy if exists delivery_items_qc_insert on public.delivery_items;
create policy delivery_items_qc_insert on public.delivery_items
  for insert with check ( public.is_qc() );

-- 3. Helper to set a delivery to 'in_progress' when QC starts touching it.
create or replace function public.qc_mark_in_progress(p_delivery_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.deliveries
     set qc_status = 'in_progress'
   where id = p_delivery_id
     and qc_status = 'qc_pending';
end;
$$;
grant execute on function public.qc_mark_in_progress(uuid) to authenticated;

-- Done.
