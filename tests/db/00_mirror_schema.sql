-- Local mirror of the Supabase objects that Alpha Flow's code reads/writes.
-- Column names come from cloudSync.js; types are deliberately mixed to prove
-- migration 74 does not depend on exact production types.
create extension if not exists pgcrypto;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;

create table public.profiles (id uuid primary key, full_name text, role text, route text);
create table public.customers (
  id uuid primary key default gen_random_uuid(), shop_name text not null, route text default '',
  category text, ledger_category text, is_active boolean default true,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table public.app_settings (id int primary key, price_approval_enabled boolean default true);
insert into public.app_settings values (1, true);
create table public.catalogue_meta (id int primary key, version int, product_count int, file_name text,
  uploaded_at timestamptz, updated_at timestamptz);
insert into public.catalogue_meta values (1, 7, 0, null, null, null);

create table public.products (
  id text primary key, name text not null, slabs jsonb default '[]', base double precision,
  mrp double precision, retail double precision, wholesale numeric, net jsonb default '[]',
  gst numeric, hsn text, qty_in_box numeric, outer_qty numeric, box numeric,
  is_qt boolean default false, sell_by_piece boolean default true, sell_by_outer boolean default false,
  sell_by_box boolean default false, sort_order int,
  price_version numeric default 1, price_changed_at timestamptz, price_changed_by uuid,
  price_increased boolean default false, previous_retail double precision, previous_wholesale numeric,
  wholesale_threshold numeric, last_approved_price numeric, last_approved_version numeric,
  last_approved_at timestamptz, last_approved_by uuid, created_at timestamptz not null default now());

create table public.product_inventory (product_id text primary key, stock numeric default 0, minimum_stock numeric);

create table public.orders (
  id uuid primary key default gen_random_uuid(), customer_id uuid, shop_name text, route text,
  sales_rep_id uuid, billing_status text default 'pending', bill_approval_required boolean default false,
  bill_approval_status text, hidden boolean default false, order_date date default current_date,
  created_at timestamptz default now(), billing_verified_at timestamptz);

create table public.order_items (
  id bigserial primary key, order_id uuid references public.orders(id) on delete cascade,
  product_name text, qty numeric, unit text default 'Piece', unit_price numeric, normal_price numeric,
  is_special_price boolean default false, approval_status text, approved_price numeric,
  approved_by text, approved_by_id uuid, approved_at timestamptz, rejection_reason text,
  entered_qty numeric, entered_unit text, approved_price_version numeric, removed boolean default false,
  price_type text);

create table public.price_approval_history (id bigserial primary key, order_item_id bigint, product_name text,
  shop_name text, decision text, approved_price numeric, approved_price_version numeric, decided_at timestamptz);

grant usage on schema public, auth to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;
