-- ============================================================================
-- Alpha Trade Links V4 — Phase 4A: Delivery Management foundation
-- Adds delivery roles, staff details, and order assignment.
-- Existing sales tables are UNTOUCHED (backward compatible).
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

-- 1. Extend profiles for delivery staff details (safe: new nullable columns).
alter table public.profiles
  add column if not exists mobile text,
  add column if not exists assigned_routes jsonb not null default '[]',
  add column if not exists active boolean not null default true;

-- Allow the two new roles. (role stays a free text field with a check.)
-- Drop any old check and recreate to include delivery roles.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin','salesperson','delivery_admin','delivery_rep'));

-- Helper: is the current user a delivery admin?
create or replace function public.is_delivery_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'delivery_admin'
  );
$$;

-- Helper: is the current user any delivery user?
create or replace function public.is_delivery()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('delivery_admin','delivery_rep')
  );
$$;

-- 2. Delivery assignments — one row per order that is in the delivery pipeline.
create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  shop_name text not null,
  route text default '',
  sales_rep_name text default '',
  assigned_to uuid references public.profiles(id),   -- delivery rep
  assigned_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending','assigned','in_progress','delivered','partial','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists deliveries_status_idx on public.deliveries(status);
create index if not exists deliveries_assigned_idx on public.deliveries(assigned_to);
create index if not exists deliveries_route_idx on public.deliveries(route);

-- 3. Auto-create a delivery row whenever a new ORDER is inserted.
-- This is the "orders automatically appear in Delivery Admin" flow.
create or replace function public.handle_new_order_delivery()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  rep_name text;
begin
  select full_name into rep_name from public.profiles where id = new.sales_rep_id;
  insert into public.deliveries (order_id, shop_name, route, sales_rep_name, status)
  values (new.id, new.shop_name, coalesce(new.route,''), coalesce(rep_name,''), 'pending');
  return new;
end;
$$;

drop trigger if exists on_order_created_delivery on public.orders;
create trigger on_order_created_delivery
  after insert on public.orders
  for each row execute function public.handle_new_order_delivery();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
alter table public.deliveries enable row level security;

-- Delivery admin: full access to all deliveries.
drop policy if exists deliveries_admin_all on public.deliveries;
create policy deliveries_admin_all on public.deliveries
  for all using ( public.is_delivery_admin() ) with check ( public.is_delivery_admin() );

-- Delivery rep: can READ only deliveries assigned to them.
drop policy if exists deliveries_rep_read on public.deliveries;
create policy deliveries_rep_read on public.deliveries
  for select using ( assigned_to = auth.uid() );

-- Delivery rep: can UPDATE only their own assigned deliveries (status changes).
drop policy if exists deliveries_rep_update on public.deliveries;
create policy deliveries_rep_update on public.deliveries
  for update using ( assigned_to = auth.uid() );

-- Sales admin can also read deliveries (oversight), reusing is_admin().
drop policy if exists deliveries_salesadmin_read on public.deliveries;
create policy deliveries_salesadmin_read on public.deliveries
  for select using ( public.is_admin() );

-- Delivery users need to READ order_items (to see what to deliver) and profiles.
-- order_items already readable by any authed user (Phase 3B). Profiles readable
-- by admin; add delivery_admin read of profiles for the staff/assign dropdowns.
drop policy if exists profiles_delivery_read on public.profiles;
create policy profiles_delivery_read on public.profiles
  for select using ( public.is_delivery() or id = auth.uid() or public.is_admin() );

-- Done. Phase 4A foundation ready.
