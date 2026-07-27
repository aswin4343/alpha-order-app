-- ============================================================================
-- Alpha Trade Links V3 — Phase 3C Round 2: cloud products table
-- Moves the product catalogue into Supabase so the admin can manage it and
-- reps download it to their phones.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

create table if not exists public.products (
  id text primary key,                 -- keeps existing ids like 'p0','p123'
  name text not null,
  slabs jsonb not null default '[]',    -- scheme slabs [[buy,free],...]
  base numeric,                         -- scheme base rate
  mrp numeric,
  retail numeric,
  wholesale numeric,
  net jsonb not null default '[]',      -- net rates per slab
  sort_order int,                       -- preserves catalogue order
  updated_at timestamptz not null default now()
);

alter table public.products enable row level security;

-- All logged-in users may READ products (reps download them).
drop policy if exists products_read on public.products;
create policy products_read on public.products
  for select using ( auth.uid() is not null );

-- Only the admin may write (insert/update/delete) products.
drop policy if exists products_write on public.products;
create policy products_write on public.products
  for all using ( public.is_admin() ) with check ( public.is_admin() );

-- A metadata row so reps can cheaply check "has the catalogue changed?"
create table if not exists public.catalogue_meta (
  id int primary key default 1,
  version int not null default 1,
  product_count int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.catalogue_meta enable row level security;

drop policy if exists meta_read on public.catalogue_meta;
create policy meta_read on public.catalogue_meta
  for select using ( auth.uid() is not null );

drop policy if exists meta_write on public.catalogue_meta;
create policy meta_write on public.catalogue_meta
  for all using ( public.is_admin() ) with check ( public.is_admin() );

insert into public.catalogue_meta (id, version, product_count)
values (1, 1, 0)
on conflict (id) do nothing;

-- Done.
