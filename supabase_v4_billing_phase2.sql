-- ============================================================================
-- Alpha Trade Links V4 — BILLING MODULE, Phase 2 (product verification & edit)
--
-- Adds fields so Billing can verify/edit each product, and permissions to do so.
-- Run in Supabase → SQL Editor. Safe — adds columns/policies, no data loss.
-- ============================================================================

-- 1. Fields on order_items for billing verification & edits ------------------
alter table public.order_items
  add column if not exists available boolean not null default true, -- verified/available
  add column if not exists original_qty numeric,          -- qty before any billing edit
  add column if not exists change_type text,               -- null | 'qty' | 'removed' | 'replaced'
  add column if not exists change_reason text,             -- reason for remove/replace/qty change
  add column if not exists original_product_name text,     -- product name before a replace
  add column if not exists removed boolean not null default false, -- true = excluded from delivery
  add column if not exists edited_by uuid references public.profiles(id),
  add column if not exists edited_at timestamptz;

-- 2. Billing can UPDATE and DELETE order_items -------------------------------
alter table public.order_items enable row level security;

drop policy if exists order_items_billing_update on public.order_items;
create policy order_items_billing_update on public.order_items
  for update using ( public.is_billing() ) with check ( public.is_billing() );

drop policy if exists order_items_billing_delete on public.order_items;
create policy order_items_billing_delete on public.order_items
  for delete using ( public.is_billing() );

drop policy if exists order_items_billing_insert on public.order_items;
create policy order_items_billing_insert on public.order_items
  for insert with check ( public.is_billing() );

-- 3. Billing needs to read products (catalogue) for the replace search -------
--    (products table is usually public-read already; this is a safety net.)
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='products') then
    execute 'alter table public.products enable row level security';
    execute 'drop policy if exists products_billing_read on public.products';
    execute 'create policy products_billing_read on public.products
               for select using ( public.is_billing() )';
  end if;
end $$;

-- Done. Phase 2 ready.
