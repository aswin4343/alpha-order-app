-- ===========================================================================
-- 49_purchase_alerts.sql  —  Feature 4, Half A
-- Purchase reorder alert STATE (fire once, reset on replenish) + PM toggle.
--
-- Threshold reuses the EXISTING product_inventory.minimum_stock (the spec's
-- "Stock Limit / Reorder Level") — no separate field, per the spec's own rule
-- to follow existing architecture.
--
-- Alert lifecycle per product:
--   stock crosses to <= minimum  -> alert_active = true, stamp triggered_at
--                                   (only if not already active => no spam)
--   stock replenished > minimum  -> alert_active = false, stamp reset_at
--                                   (so a FUTURE dip can alert again)
-- ===========================================================================

alter table product_inventory add column if not exists alert_active boolean not null default false;
alter table product_inventory add column if not exists alert_triggered_at timestamptz;
alter table product_inventory add column if not exists alert_reset_at timestamptz;

-- Toggle for purchase-stock push alerts (dashboard alerts are always on; this
-- only gates OS/browser push, per spec 2.6). Stored in the existing app_settings
-- key/value table if present, else a tiny dedicated table.
create table if not exists purchase_alert_settings (
  id int primary key default 1,
  push_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);
insert into purchase_alert_settings (id, push_enabled) values (1, true)
on conflict (id) do nothing;

alter table purchase_alert_settings enable row level security;
drop policy if exists pas_read on purchase_alert_settings;
create policy pas_read on purchase_alert_settings for select using (auth.uid() is not null);
drop policy if exists pas_write on purchase_alert_settings;
create policy pas_write on purchase_alert_settings for all using (auth.uid() is not null) with check (auth.uid() is not null);

-- ---------------------------------------------------------------------------
-- Update apply_stock_change to maintain alert state on every stock change.
-- Recreated with the SAME signature as before, plus alert bookkeeping at the
-- end. (Idempotent replace; existing callers unaffected.)
-- ---------------------------------------------------------------------------
create or replace function apply_stock_change(
  p_product_id text,
  p_product_name text,
  p_txn_type text,
  p_qty numeric,
  p_reference text default null,
  p_user_name text default null,
  p_user_id uuid default null,
  p_min_stock numeric default null,
  p_allow_negative boolean default false
) returns json
language plpgsql
as $$
declare
  v_prev numeric;
  v_new numeric;
  v_min numeric;
  v_was_active boolean;
begin
  select current_stock, minimum_stock, alert_active
    into v_prev, v_min, v_was_active
  from product_inventory where product_id = p_product_id
  for update;

  if not found then
    if p_txn_type = 'INITIAL' or p_txn_type = 'RECEIVED' then
      v_prev := 0;
      v_new := 0 + p_qty;
      v_min := coalesce(p_min_stock, 0);
      insert into product_inventory (product_id, current_stock, minimum_stock, inventory_initialized, last_stock_update)
      values (p_product_id, v_new, v_min, true, now());
    else
      return json_build_object('applied', false, 'reason', 'not_initialized');
    end if;
  else
    v_new := v_prev + p_qty;
    if v_new < 0 and not p_allow_negative then
      return json_build_object('applied', false, 'reason', 'insufficient_stock', 'current_stock', v_prev);
    end if;
    if p_min_stock is not null then v_min := p_min_stock; end if;
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

  -- Alert state bookkeeping (fire once / reset on replenish).
  if v_new <= v_min then
    -- At/below threshold: activate the alert only on the DOWNWARD crossing
    -- (was not active before) so repeated small sales don't re-spam.
    if not coalesce(v_was_active, false) then
      update product_inventory
        set alert_active = true, alert_triggered_at = now()
        where product_id = p_product_id;
    end if;
  else
    -- Above threshold: clear any active alert so a future dip can alert again.
    if coalesce(v_was_active, false) then
      update product_inventory
        set alert_active = false, alert_reset_at = now()
        where product_id = p_product_id;
    end if;
  end if;

  return json_build_object(
    'applied', true, 'previous_stock', v_prev, 'current_stock', v_new,
    'alert_crossed', (v_new <= v_min and not coalesce(v_was_active, false))
  );
end;
$$;

notify pgrst, 'reload schema';
