-- ============================================================================
-- Alpha Trade Links — Billing edit → push notification to the original
-- Sales Rep (external, device-level, reusing the existing send-qc-push
-- Edge Function infrastructure — no second notification system).
--
-- Fires when Billing successfully edits an order's items (qty changed,
-- product removed, product replaced). Targets ONLY the rep who originally
-- placed that order (orders.sales_rep_id), via push_subscriptions.user_id —
-- never a role-wide broadcast.
--
-- Consolidation: Billing's edit actions each save individually (there is no
-- single "commit all changes" step in the UI), so this uses a short
-- (20-second) rate limit PER ORDER — the first edit in a window sends the
-- push; further edits to the same order within 20s update the audit trail
-- but do not re-send, so a burst of quick edits produces one notification,
-- not several, matching the "prefer one consolidated notification" rule.
--
-- Run in Supabase → SQL Editor. Purely additive.
-- ============================================================================

-- 1. Audit trail table --------------------------------------------------------
-- Every meaningful Billing-side change to an order's items, independent of
-- whether a push was actually sent for it (rate-limited edits still get
-- audited here, just don't trigger a second push).
create table if not exists public.billing_edit_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  order_item_id uuid references public.order_items(id) on delete set null,
  sales_rep_id uuid references public.profiles(id),
  shop_name text,
  change_type text,           -- 'qty' | 'removed' | 'replaced'
  product_name text,
  old_value text,
  new_value text,
  billing_user_id uuid references public.profiles(id),
  billing_user_name text,
  created_at timestamptz not null default now(),
  push_sent boolean not null default false
);

create index if not exists billing_edit_events_order_idx on public.billing_edit_events(order_id, created_at desc);

alter table public.billing_edit_events enable row level security;
drop policy if exists billing_edit_events_read on public.billing_edit_events;
create policy billing_edit_events_read on public.billing_edit_events
  for select using ( public.is_admin() or public.is_billing() or sales_rep_id = auth.uid() );
drop policy if exists billing_edit_events_insert on public.billing_edit_events;
create policy billing_edit_events_insert on public.billing_edit_events
  for insert with check ( public.is_billing() );

-- 2. Trigger: fires on order_items UPDATE, only when it's a genuine Billing
--    edit (change_type was just set) ----------------------------------------
create or replace function public.notify_rep_on_billing_edit()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  s record;
  o record;
  billing_name text;
  summary text;
  recent_count int;
  should_push boolean := true;
  event_id uuid;
begin
  -- Only fire for genuine edits (change_type newly set/changed this update),
  -- never on the initial insert of a fresh order line.
  if new.change_type is null then return new; end if;
  if old.change_type is not distinct from new.change_type
     and old.qty is not distinct from new.qty
     and old.product_name is not distinct from new.product_name
     and old.removed is not distinct from new.removed then
    return new; -- nothing actually changed
  end if;

  select * into o from public.orders where id = new.order_id;
  if o.id is null then return new; end if;

  select full_name into billing_name from public.profiles where id = auth.uid();

  -- Build a human-readable summary for this specific change.
  if new.change_type = 'removed' then
    summary := format('%s was removed from the order for %s.', coalesce(new.original_product_name, new.product_name), o.shop_name);
  elsif new.change_type = 'replaced' then
    summary := format('%s was replaced with %s in the order for %s.', coalesce(new.original_product_name, 'a product'), new.product_name, o.shop_name);
  elsif new.change_type = 'qty' then
    summary := format('Quantity for %s was changed from %s to %s for %s.', new.product_name, coalesce(new.original_qty::text, '?'), new.qty, o.shop_name);
  else
    summary := format('%s''s order was updated by Billing.', o.shop_name);
  end if;

  -- Audit trail — always recorded, regardless of whether we end up pushing.
  insert into public.billing_edit_events
    (order_id, order_item_id, sales_rep_id, shop_name, change_type, product_name, old_value, new_value, billing_user_id, billing_user_name)
  values
    (o.id, new.id, o.sales_rep_id, o.shop_name, new.change_type, new.product_name,
     case new.change_type when 'qty' then new.original_qty::text when 'replaced' then new.original_product_name else null end,
     case new.change_type when 'qty' then new.qty::text when 'replaced' then new.product_name else null end,
     auth.uid(), coalesce(billing_name, 'Billing Team'))
  returning id into event_id;

  -- Rate limit: has a push already gone out for THIS order in the last 20s?
  select count(*) into recent_count
  from public.billing_edit_events
  where order_id = o.id and push_sent = true and created_at > now() - interval '20 seconds' and id <> event_id;
  if recent_count > 0 then should_push := false; end if;

  if should_push and o.sales_rep_id is not null then
    select * into s from public.app_settings where id = 1;
    if s.qc_push_function_url is not null and length(s.qc_push_function_url) > 0 then
      perform net.http_post(
        url := s.qc_push_function_url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-qc-secret', coalesce(s.qc_push_secret, '')),
        body := jsonb_build_object(
          'kind', 'billing_edit',
          'order_id', o.id,
          'shop_name', o.shop_name,
          'sales_rep_id', o.sales_rep_id,
          'change_summary', summary
        )
      );
      update public.billing_edit_events set push_sent = true where id = event_id;
    end if;
  end if;

  return new;
exception when others then
  -- Never let a notification failure block Billing from saving an edit.
  raise warning 'notify_rep_on_billing_edit failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_notify_rep_on_billing_edit on public.order_items;
create trigger trg_notify_rep_on_billing_edit
  after update on public.order_items
  for each row execute function public.notify_rep_on_billing_edit();

-- Done. Reuses the same send-qc-push Edge Function already deployed for QC
-- and product-update announcements — just needs redeploying so it picks up
-- the new 'billing_edit' kind (see SETUP doc). No new secrets/keys needed.
