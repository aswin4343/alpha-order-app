-- ===========================================================================
-- 46_inventory_deduction_fix.sql
-- Fix: deduct_order_stock previously set stock_deducted = true even when NOTHING
-- was deducted (e.g. the product wasn't initialized yet at verify time). That
-- permanently blocked deduction once stock was later entered.
--
-- New behaviour: only mark the order deducted when at least one line actually
-- deducted from an initialized product. If nothing was applied, leave
-- stock_deducted = false so a later run (after stock is entered) can deduct.
-- ===========================================================================

create or replace function deduct_order_stock(p_order_id uuid)
returns json
language plpgsql
as $$
declare
  v_already boolean;
  v_item record;
  v_product_id text;
  v_res json;
  v_applied int := 0;   -- lines that actually reduced stock
  v_matched int := 0;   -- lines whose product exists AND is initialized
  v_skipped int := 0;   -- lines with no matching product
begin
  select stock_deducted into v_already from orders where id = p_order_id for update;
  if not found then
    return json_build_object('ok', false, 'reason', 'order_not_found');
  end if;
  if v_already then
    return json_build_object('ok', true, 'already_deducted', true);
  end if;

  for v_item in
    select product_name, qty
    from order_items
    where order_id = p_order_id and coalesce(removed, false) = false and coalesce(qty,0) > 0
  loop
    select id into v_product_id
    from products
    where upper(trim(name)) = upper(trim(v_item.product_name))
    limit 1;

    if v_product_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_res := apply_stock_change(
      v_product_id, v_item.product_name, 'SALE',
      -1 * v_item.qty, 'Order ' || left(p_order_id::text, 8),
      'Billing verify', null, null, false
    );
    if (v_res->>'applied')::boolean then
      v_applied := v_applied + 1;
      v_matched := v_matched + 1;
    end if;
  end loop;

  -- Only mark the order as deducted if SOMETHING was actually applied. This
  -- lets an order that was verified before its products had stock get deducted
  -- later (via reconcile or a re-run) once the Purchase Manager enters stock.
  if v_applied > 0 then
    update orders set stock_deducted = true where id = p_order_id;
  end if;

  return json_build_object('ok', true, 'applied', v_applied, 'unmatched', v_skipped, 'marked', v_applied > 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconcile: deduct stock for any VERIFIED order not yet deducted. Run this
-- once now to fix the test order(s) that got stuck, and any future stragglers.
-- Safe to run repeatedly (idempotent per order via stock_deducted).
-- ---------------------------------------------------------------------------
create or replace function reconcile_verified_stock()
returns json
language plpgsql
as $$
declare
  v_order record;
  v_count int := 0;
begin
  for v_order in
    select id from orders
    where billing_status = 'verified' and coalesce(stock_deducted, false) = false
    order by billing_verified_at asc nulls last
  loop
    perform deduct_order_stock(v_order.id);
    v_count := v_count + 1;
  end loop;
  return json_build_object('ok', true, 'orders_processed', v_count);
end;
$$;

notify pgrst, 'reload schema';
