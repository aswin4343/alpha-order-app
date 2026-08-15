-- ============================================================================
-- Alpha Trade Links — "Bill Cancelled" (Delivery Rep) + Delivery Admin alert
--
-- Lets a Delivery Rep cancel a whole shop-day delivery group (all rows in
-- group.deliveryIds) with a typed reason, before it's delivered. Cancelled
-- deliveries stay in the table (visible to Delivery Admin as a record) —
-- nothing is hard-deleted. Delivery Admin is notified in-app.
--
-- Purely additive. Run in Supabase → SQL Editor.
-- ============================================================================

-- 1. Widen the status CHECK constraint to allow 'cancelled' -------------------
-- The live constraint currently only allows
-- ('pending','assigned','in_progress','delivered','partial','failed') —
-- 'cancelled' was referenced in project notes but never actually added here.
-- Must fix this FIRST or the cancel RPC below will fail on every attempt.
alter table public.deliveries drop constraint if exists deliveries_status_check;
alter table public.deliveries
  add constraint deliveries_status_check
  check (status in ('pending','assigned','in_progress','delivered','partial','failed','cancelled'));

-- 2. New columns on deliveries for the cancellation reason + who/when --------
alter table public.deliveries
  add column if not exists cancel_reason text,
  add column if not exists cancelled_by uuid references public.profiles(id),
  add column if not exists cancelled_at timestamptz;

-- 3. Delivery Admin notifications table ---------------------------------------
-- Separate from order_notifications (that table is rep-scoped, for billing
-- edits). This one is scoped to the delivery_admin role.
create table if not exists public.delivery_admin_notifications (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid references public.deliveries(id) on delete cascade,
  shop_name text,
  route text,
  reason text,
  cancelled_by_name text,
  created_at timestamptz not null default now(),
  read boolean not null default false
);

create index if not exists delivery_admin_notif_idx
  on public.delivery_admin_notifications (read, created_at desc);

alter table public.delivery_admin_notifications enable row level security;

-- Delivery Admin can read + mark read. (Simple role check, not per-user —
-- there's one shared Delivery Admin inbox, matching how the Delivery Admin
-- dashboard already works today.)
drop policy if exists delivery_admin_notif_read on public.delivery_admin_notifications;
create policy delivery_admin_notif_read on public.delivery_admin_notifications
  for select using ( public.is_delivery_admin() or public.is_admin() );

drop policy if exists delivery_admin_notif_update on public.delivery_admin_notifications;
create policy delivery_admin_notif_update on public.delivery_admin_notifications
  for update using ( public.is_delivery_admin() or public.is_admin() )
  with check ( public.is_delivery_admin() or public.is_admin() );

-- Any delivery rep can insert one (created as part of cancelling their own
-- delivery — see cancel_delivery_group below).
drop policy if exists delivery_admin_notif_insert on public.delivery_admin_notifications;
create policy delivery_admin_notif_insert on public.delivery_admin_notifications
  for insert with check ( auth.uid() is not null );

-- 4. RPC: cancel a whole delivery group + create the admin notification -------
-- Runs as one atomic operation so the cancellation and the notification are
-- never out of sync. A rep can only cancel deliveries currently assigned to
-- them (assigned_to = auth.uid()) and not already delivered/cancelled.
create or replace function public.cancel_delivery_group(
  p_delivery_ids uuid[],
  p_reason text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  d record;
  rep_name text;
  first_delivery_id uuid;
  first_shop text;
  first_route text;
  affected int := 0;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'A reason is required to cancel a bill.';
  end if;

  select full_name into rep_name from public.profiles where id = auth.uid();

  for d in
    select * from public.deliveries
    where id = any(p_delivery_ids)
      and assigned_to = auth.uid()
      and status not in ('delivered', 'cancelled')
  loop
    update public.deliveries
    set status = 'cancelled',
        cancel_reason = p_reason,
        cancelled_by = auth.uid(),
        cancelled_at = now(),
        updated_at = now()
    where id = d.id;
    affected := affected + 1;
    -- Use the first delivery ACTUALLY cancelled by this loop, not just array
    -- position 1 of the input — a sibling row could be ineligible (already
    -- delivered) while another in the same group is genuinely cancellable.
    if first_delivery_id is null then
      first_delivery_id := d.id;
      first_shop := d.shop_name;
      first_route := d.route;
    end if;
  end loop;

  if affected = 0 then
    raise exception 'No eligible deliveries found to cancel (already delivered, already cancelled, or not assigned to you).';
  end if;

  insert into public.delivery_admin_notifications (delivery_id, shop_name, route, reason, cancelled_by_name)
  values (first_delivery_id, first_shop, first_route, p_reason, coalesce(rep_name, 'A delivery rep'));
end;
$$;

-- Done.
