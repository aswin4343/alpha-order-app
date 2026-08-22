-- ===========================================================================
-- 43_inventory_phase1.sql  —  Purchase Manager / Inventory foundation
--
-- THREE tables, kept separate from product master data so the system can always
-- distinguish "stock is actually 0" from "stock was never entered":
--   product_inventory      — one authoritative row per initialized product
--   inventory_transactions — immutable audit of every stock movement
--   purchases              — purchase/receipt history
--
-- A product has NO inventory row until the Purchase Manager initializes it.
-- No row  => "Stock Not Updated" (never red/orange/green, never treated as 0).
-- ===========================================================================

-- 1. Central inventory — ONE row per initialized product (product_id unique).
create table if not exists product_inventory (
  product_id text primary key,             -- matches products.id
  current_stock numeric not null default 0,
  minimum_stock numeric not null default 0,
  inventory_initialized boolean not null default true,
  last_stock_update timestamptz not null default now(),
  last_purchase_date timestamptz,
  last_purchase_qty numeric,
  created_at timestamptz not null default now()
);

-- 2. Immutable stock movement history.
create table if not exists inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  product_id text not null,
  product_name text,
  txn_type text not null,          -- 'INITIAL' | 'RECEIVED' | 'SALE' | 'SALE_RETURN' | 'ADJUSTMENT' | 'DAMAGED' | 'CORRECTION'
  qty numeric not null,            -- signed: + adds stock, - removes
  previous_stock numeric,
  updated_stock numeric,
  reference text,                  -- order id, purchase ref, note, etc.
  user_name text,
  user_id uuid
);
create index if not exists inv_txn_product_idx on inventory_transactions (product_id, created_at desc);

-- 3. Purchase / receipt history.
create table if not exists purchases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  purchase_date date not null default current_date,
  product_id text not null,
  product_name text,
  brand text,
  qty numeric not null,
  purchase_price numeric,          -- per-unit, optional
  total_value numeric,             -- qty * purchase_price, optional
  supplier text,
  reference text,
  added_by text,
  added_by_id uuid,
  status text default 'received'
);
create index if not exists purchases_product_idx on purchases (product_id, created_at desc);

-- ---------------------------------------------------------------------------
-- ATOMIC stock apply function. All stock changes go through this so the update
-- and the audit row are one transaction, and concurrent deductions can never
-- drive stock negative (row is locked for the duration).
--
--   p_allow_negative = false (default) -> a deduction that would go below 0 is
--   rejected (returns the current stock unchanged with applied=false).
--   Initialization (INITIAL) creates the row if missing.
-- ---------------------------------------------------------------------------
create or replace function apply_stock_change(
  p_product_id text,
  p_product_name text,
  p_txn_type text,
  p_qty numeric,                  -- signed
  p_reference text default null,
  p_user_name text default null,
  p_user_id uuid default null,
  p_min_stock numeric default null,      -- only used on INITIAL / to set minimum
  p_allow_negative boolean default false
) returns json
language plpgsql
as $$
declare
  v_prev numeric;
  v_new numeric;
  v_exists boolean;
begin
  select true, current_stock into v_exists, v_prev
  from product_inventory where product_id = p_product_id
  for update;

  if not found then
    -- No inventory row yet. Only INITIAL (or an explicit received/adjust that
    -- creates it) may create one; everything else is a no-op so uninitialized
    -- products are never implicitly set to 0.
    if p_txn_type = 'INITIAL' or p_txn_type = 'RECEIVED' then
      v_prev := 0;
      v_new := 0 + p_qty;
      insert into product_inventory (product_id, current_stock, minimum_stock, inventory_initialized, last_stock_update)
      values (p_product_id, v_new, coalesce(p_min_stock, 0), true, now());
    else
      return json_build_object('applied', false, 'reason', 'not_initialized');
    end if;
  else
    v_new := v_prev + p_qty;
    if v_new < 0 and not p_allow_negative then
      return json_build_object('applied', false, 'reason', 'insufficient_stock', 'current_stock', v_prev);
    end if;
    update product_inventory
      set current_stock = v_new,
          last_stock_update = now(),
          minimum_stock = coalesce(p_min_stock, minimum_stock),
          last_purchase_date = case when p_txn_type='RECEIVED' then now() else last_purchase_date end,
          last_purchase_qty  = case when p_txn_type='RECEIVED' then p_qty else last_purchase_qty end
      where product_id = p_product_id;
  end if;

  insert into inventory_transactions
    (product_id, product_name, txn_type, qty, previous_stock, updated_stock, reference, user_name, user_id)
  values
    (p_product_id, p_product_name, p_txn_type, p_qty, v_prev, v_new, p_reference, p_user_name, p_user_id);

  return json_build_object('applied', true, 'previous_stock', v_prev, 'current_stock', v_new);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS. Authenticated users can read inventory (rep cards need it); writes go
-- through the function above (security definer not required since RLS allows
-- authenticated writes here — tighten later if you add stricter role checks).
-- ---------------------------------------------------------------------------
alter table product_inventory enable row level security;
alter table inventory_transactions enable row level security;
alter table purchases enable row level security;

drop policy if exists inv_read on product_inventory;
create policy inv_read on product_inventory for select using (auth.uid() is not null);
drop policy if exists inv_write on product_inventory;
create policy inv_write on product_inventory for all using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists inv_txn_read on inventory_transactions;
create policy inv_txn_read on inventory_transactions for select using (auth.uid() is not null);
drop policy if exists inv_txn_write on inventory_transactions;
create policy inv_txn_write on inventory_transactions for insert with check (auth.uid() is not null);

drop policy if exists purchases_read on purchases;
create policy purchases_read on purchases for select using (auth.uid() is not null);
drop policy if exists purchases_write on purchases;
create policy purchases_write on purchases for all using (auth.uid() is not null) with check (auth.uid() is not null);

-- Realtime: let the Sales dashboard subscribe to inventory changes (Phase 2).
alter publication supabase_realtime add table product_inventory;

notify pgrst, 'reload schema';

-- NOTE: the Purchase Manager role is just a value in profiles.role. Create the
-- login in Supabase Auth, then set that user's profiles.role = 'purchase_manager'.
