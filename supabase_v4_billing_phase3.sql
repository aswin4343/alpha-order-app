-- ============================================================================
-- Alpha Trade Links V4 — BILLING MODULE, Phase 3 (rep notifications + history)
--
-- Adds a notifications table and makes verify_order_to_delivery create a
-- notification for the sales rep whenever their order had billing edits.
-- Run in Supabase → SQL Editor. Safe — adds a table + updates a function.
-- ============================================================================

-- 1. Notifications table -----------------------------------------------------
create table if not exists public.order_notifications (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  sales_rep_id uuid references public.profiles(id),
  shop_name text,
  changes jsonb,              -- array of change lines
  changed_by text,           -- billing staff name
  created_at timestamptz not null default now(),
  read boolean not null default false
);

create index if not exists order_notif_rep_idx
  on public.order_notifications (sales_rep_id, read, created_at desc);

alter table public.order_notifications enable row level security;

-- Reps read + update (mark read) their OWN notifications.
drop policy if exists notif_rep_read on public.order_notifications;
create policy notif_rep_read on public.order_notifications
  for select using ( sales_rep_id = auth.uid() );

drop policy if exists notif_rep_update on public.order_notifications;
create policy notif_rep_update on public.order_notifications
  for update using ( sales_rep_id = auth.uid() ) with check ( sales_rep_id = auth.uid() );

-- Billing can insert notifications (also created by the verify function).
drop policy if exists notif_billing_insert on public.order_notifications;
create policy notif_billing_insert on public.order_notifications
  for insert with check ( public.is_billing() );

-- 2. Update verify to also create a notification when there were edits --------
create or replace function public.verify_order_to_delivery(p_order_id uuid, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  o record;
  rep_name text;
  billing_name text;
  change_lines jsonb := '[]'::jsonb;
  edited_count int := 0;
  it record;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'order not found'; end if;
  if o.billing_status = 'verified' then return; end if;

  select full_name into rep_name from public.profiles where id = o.sales_rep_id;
  select full_name into billing_name from public.profiles where id = auth.uid();

  -- Build a change summary from any edited items.
  for it in
    select * from public.order_items
    where order_id = p_order_id and change_type is not null
  loop
    edited_count := edited_count + 1;
    if it.change_type = 'removed' then
      change_lines := change_lines || to_jsonb(
        format('Removed: %s (%s)', coalesce(it.original_product_name, it.product_name), coalesce(it.change_reason,'')));
    elsif it.change_type = 'replaced' then
      change_lines := change_lines || to_jsonb(
        format('Replaced: %s → %s (%s)', coalesce(it.original_product_name, it.product_name), it.product_name, coalesce(it.change_reason,'')));
    elsif it.change_type = 'qty' then
      change_lines := change_lines || to_jsonb(
        format('%s: qty %s → %s', it.product_name, coalesce(it.original_qty, it.qty), it.qty));
    end if;
  end loop;

  -- Mark verified.
  update public.orders
     set billing_status = 'verified',
         billing_verified_by = auth.uid(),
         billing_verified_at = now(),
         billing_notes = coalesce(p_notes, billing_notes)
   where id = p_order_id;

  -- Create the delivery.
  insert into public.deliveries (order_id, shop_name, route, sales_rep_name, status)
  values (o.id, o.shop_name, coalesce(o.route,''), coalesce(rep_name,''), 'pending');

  -- Notify the rep ONLY if there were edits.
  if edited_count > 0 then
    insert into public.order_notifications (order_id, sales_rep_id, shop_name, changes, changed_by)
    values (o.id, o.sales_rep_id, o.shop_name, change_lines, coalesce(billing_name,'Billing Team'));
  end if;
end;
$$;

grant execute on function public.verify_order_to_delivery(uuid, text) to authenticated;

-- Done. Phase 3 ready.
