-- ============================================================================
-- Alpha Trade Links V4 — QC MODULE, Phase 1 (foundation + pipeline)
--
-- Inserts a Quality Control step between Billing and Delivery:
--   Sales → Billing → Delivery Admin (QC Pending) → QC verifies → Ready for Delivery
--
-- Soft gate: Delivery Admin can still dispatch an un-QC'd order at their risk.
-- Run in Supabase → SQL Editor.
-- ============================================================================

-- 1. Allow the 'qc_team' role.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin','salesperson','delivery_admin','delivery_rep','billing_team','qc_team'));

create or replace function public.is_qc()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'qc_team');
$$;

-- 2. QC fields on deliveries.
alter table public.deliveries
  add column if not exists qc_status text not null default 'qc_pending', -- qc_pending | qc_verified | qc_returned
  add column if not exists packed_by text,
  add column if not exists qc_verified_by uuid references public.profiles(id),
  add column if not exists qc_verified_at timestamptz,
  add column if not exists qc_checklist jsonb;

create index if not exists deliveries_qc_status_idx on public.deliveries(qc_status);

-- Existing deliveries: treat as already QC-verified so current flow is unaffected.
update public.deliveries
set qc_status = 'qc_verified'
where qc_status = 'qc_pending'
  and created_at < now() - interval '1 minute';

-- 3. QC verify RPC — marks QC verified (requires packed_by) → Ready for Delivery.
create or replace function public.qc_verify_delivery(
  p_delivery_id uuid,
  p_packed_by text,
  p_checklist jsonb default null
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_packed_by is null or length(trim(p_packed_by)) = 0 then
    raise exception 'packed_by is required';
  end if;
  update public.deliveries
     set qc_status = 'qc_verified',
         packed_by = p_packed_by,
         qc_verified_by = auth.uid(),
         qc_verified_at = now(),
         qc_checklist = coalesce(p_checklist, qc_checklist)
   where id = p_delivery_id;
end;
$$;
grant execute on function public.qc_verify_delivery(uuid, text, jsonb) to authenticated;

-- 4. RLS: QC can read + update deliveries and read order_items/orders.
alter table public.deliveries enable row level security;

drop policy if exists deliveries_qc_read on public.deliveries;
create policy deliveries_qc_read on public.deliveries
  for select using ( public.is_qc() );

drop policy if exists deliveries_qc_update on public.deliveries;
create policy deliveries_qc_update on public.deliveries
  for update using ( public.is_qc() ) with check ( public.is_qc() );

drop policy if exists orders_qc_read on public.orders;
create policy orders_qc_read on public.orders
  for select using ( public.is_qc() );

drop policy if exists order_items_qc_read on public.order_items;
create policy order_items_qc_read on public.order_items
  for select using ( public.is_qc() );

drop policy if exists profiles_qc_read on public.profiles;
create policy profiles_qc_read on public.profiles
  for select using ( public.is_qc() );

drop policy if exists delivery_items_qc_read on public.delivery_items;
create policy delivery_items_qc_read on public.delivery_items
  for select using ( public.is_qc() );

-- Done. Phase 1 ready.
