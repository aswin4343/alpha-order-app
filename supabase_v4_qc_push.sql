-- ============================================================================
-- Alpha Trade Links V4 — QC External Push Notifications
--
-- When Billing successfully verifies a bill, verify_order_to_delivery() inserts
-- a row into public.deliveries. THAT insert is the "verification completed"
-- event. This file:
--   1. stores each QC device's Web Push subscription,
--   2. on delivery insert, calls the `send-qc-push` Edge Function (via pg_net)
--      which sends the actual push to every subscribed QC device.
--
-- Requires: the `send-qc-push` Edge Function deployed (see SETUP doc), and the
-- pg_net extension (standard on Supabase). Run in Supabase → SQL Editor.
-- ============================================================================

-- 0. Extensions ---------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

-- 1. Push subscriptions -------------------------------------------------------
-- One row per QC device/browser. `subscription` holds the full PushSubscription
-- JSON (endpoint + keys) produced by the browser.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  role text,                                   -- snapshot of the user's role
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subs_user_idx on public.push_subscriptions(user_id);
create index if not exists push_subs_role_idx on public.push_subscriptions(role);

alter table public.push_subscriptions enable row level security;

-- A user manages ONLY their own subscriptions.
drop policy if exists push_self_all on public.push_subscriptions;
create policy push_self_all on public.push_subscriptions
  for all using ( user_id = auth.uid() ) with check ( user_id = auth.uid() );

-- 2. Settings row holding the Edge Function URL + a shared secret -------------
-- We keep these in a tiny table so the trigger can read them. Populate via the
-- SETUP doc (one UPDATE). The service_role key is NOT stored here — the Edge
-- Function uses its own env. We only pass a shared secret to authorize the call.
create table if not exists public.app_settings (
  id int primary key default 1,
  qc_push_function_url text,
  qc_push_secret text,
  single_row boolean not null default true,
  constraint app_settings_singleton check (id = 1)
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

-- Only admin can see/change settings.
alter table public.app_settings enable row level security;
drop policy if exists app_settings_admin on public.app_settings;
create policy app_settings_admin on public.app_settings
  for all using ( public.is_admin() ) with check ( public.is_admin() );

-- 3. Trigger: on delivery insert, ping the Edge Function ----------------------
-- Fires AFTER INSERT on deliveries (i.e. right after billing verification).
-- Uses pg_net.http_post to call the function asynchronously; failures here must
-- NEVER block the billing verification, so everything is wrapped defensively.
create or replace function public.notify_qc_on_delivery()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  s record;
  bill_no text;
  verified_by_name text;
begin
  select * into s from public.app_settings where id = 1;
  if s.qc_push_function_url is null or length(s.qc_push_function_url) = 0 then
    return new; -- not configured yet; do nothing
  end if;

  -- Human-friendly bill number: short form of the order id.
  bill_no := coalesce(substr(new.order_id::text, 1, 8), '');

  -- Who verified it (the billing user who just ran verify).
  select full_name into verified_by_name from public.profiles where id = auth.uid();

  perform net.http_post(
    url := s.qc_push_function_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-qc-secret', coalesce(s.qc_push_secret, '')
    ),
    body := jsonb_build_object(
      'delivery_id', new.id,
      'order_id', new.order_id,
      'shop_name', coalesce(new.shop_name, ''),
      'route', coalesce(new.route, ''),
      'bill_no', bill_no,
      'verified_by', coalesce(verified_by_name, 'Billing Team')
    )
  );
  return new;
exception when others then
  -- Absolutely never break the billing flow because of a push failure.
  raise warning 'notify_qc_on_delivery failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_notify_qc_on_delivery on public.deliveries;
create trigger trg_notify_qc_on_delivery
  after insert on public.deliveries
  for each row execute function public.notify_qc_on_delivery();

-- Done. (Deploy the Edge Function + set app_settings — see SETUP doc.)
