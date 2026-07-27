-- ============================================================================
-- Alpha Trade Links V3 — Phase 3A database setup
-- Run this in Supabase → SQL Editor → New query → paste all → Run.
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE where possible.
-- ============================================================================

-- ---------- 1. PROFILES (links an auth user to a role + display name) -------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role text not null default 'salesperson' check (role in ('admin','salesperson')),
  route text default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- 2. CUSTOMERS (cloud copy — NO personal info) --------------------
-- Privacy rule: only shop name + route live in the cloud.
-- Phone / GST / address stay on the salesperson's device only.
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  shop_name text not null,
  route text default '',
  category text default '',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- ---------- 3. ORDERS (header) ----------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  shop_name text not null,           -- denormalised for quick display
  route text default '',
  brand text default '',
  sales_rep_id uuid references public.profiles(id),
  total_products int not null default 0,
  total_quantity int not null default 0,
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now()
);

-- ---------- 4. ORDER ITEMS (lines) ------------------------------------------
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  product_name text not null,
  qty int not null,
  unit text default 'Piece',
  is_addon boolean not null default false   -- supports the ADD-ONS feature
);

-- ---------- 5. VISITS (no-order shop visits) --------------------------------
create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id),
  shop_name text not null,
  route text default '',
  sales_rep_id uuid references public.profiles(id),
  visit_status text not null,
  custom_remark text default '',
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- ROW LEVEL SECURITY
-- Salespeople see only their own rows. Admin sees everything.
-- ============================================================================
alter table public.profiles    enable row level security;
alter table public.customers   enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
alter table public.visits      enable row level security;

-- helper: is the current user an admin?
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- ---- PROFILES ----
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using ( id = auth.uid() or public.is_admin() );

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update using ( id = auth.uid() or public.is_admin() );

-- ---- CUSTOMERS ----  (all reps can read the shared shop list; write own)
drop policy if exists customers_read on public.customers;
create policy customers_read on public.customers
  for select using ( auth.uid() is not null );

drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers
  for insert with check ( auth.uid() is not null );

-- ---- ORDERS ----  (rep sees own; admin sees all)
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders
  for select using ( sales_rep_id = auth.uid() or public.is_admin() );

drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders
  for insert with check ( sales_rep_id = auth.uid() );

drop policy if exists orders_update on public.orders;
create policy orders_update on public.orders
  for update using ( sales_rep_id = auth.uid() or public.is_admin() );

-- ---- ORDER ITEMS ----  (visible if you can see the parent order)
drop policy if exists order_items_read on public.order_items;
create policy order_items_read on public.order_items
  for select using (
    exists (select 1 from public.orders o
            where o.id = order_id
              and (o.sales_rep_id = auth.uid() or public.is_admin()))
  );

drop policy if exists order_items_insert on public.order_items;
create policy order_items_insert on public.order_items
  for insert with check (
    exists (select 1 from public.orders o
            where o.id = order_id and o.sales_rep_id = auth.uid())
  );

-- ---- VISITS ----
drop policy if exists visits_read on public.visits;
create policy visits_read on public.visits
  for select using ( sales_rep_id = auth.uid() or public.is_admin() );

drop policy if exists visits_insert on public.visits;
create policy visits_insert on public.visits
  for insert with check ( sales_rep_id = auth.uid() );

-- ============================================================================
-- AUTO-CREATE a profile row whenever a new auth user is created.
-- Role + name are read from the user's metadata set at creation time.
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role, route)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'role', 'salesperson'),
    coalesce(new.raw_user_meta_data->>'route', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Done. Phase 3A schema + security ready.
