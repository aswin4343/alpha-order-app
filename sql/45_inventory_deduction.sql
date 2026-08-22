-- ===========================================================================
-- 45_inventory_deduction.sql  —  Phase 3
-- Deduct stock atomically when an order is VERIFIED by Billing (confirmed sale).
--
--  • Only INITIALIZED products deduct (apply_stock_change no-ops otherwise, so
--    uninitialized products are never driven to a negative/zero).
--  • Idempotent: a per-order marker (orders.stock_deducted) prevents double
--    deduction if verify runs twice.
--  • order_items store product_name (not id), so we map name -> products.id.
--  • Runs inside one function call; each item deduction is atomic via
--    apply_stock_change (row lock), so concurrent verifies can't go negative.
-- ===========================================================================

alter table orders add column if not exists stock_deducted boolean not null default false;

create or replace function deduct_order_stock(p_order_id uuid)
returns json
language plpgsql
as $$
declare
  v_already boolean;
  v_item record;
  v_product_id text;
  v_deducted int := 0;
  v_skipped int := 0;
begin
  -- Guard: only deduct once per order.
  select stock_deducted into v_already from orders where id = p_order_id for update;
  if not found then
    return json_build_object('ok', false, 'reason', 'order_not_found');
  end if;
  if v_already then
    return json_build_object('ok', true, 'already_deducted', true);
  end if;

  -- Walk the order's live (non-removed) items.
  for v_item in
    select product_name, qty
    from order_items
    where order_id = p_order_id and coalesce(removed, false) = false and coalesce(qty,0) > 0
  loop
    -- Map product_name -> products.id (case/space-insensitive).
    select id into v_product_id
    from products
    where upper(trim(name)) = upper(trim(v_item.product_name))
    limit 1;

    if v_product_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Atomic deduction. apply_stock_change returns applied=false for
    -- uninitialized products (they simply don't track stock yet) — that's a
    -- skip, not an error, so a mixed order still verifies fine.
    perform apply_stock_change(
      v_product_id,
      v_item.product_name,
      'SALE',
      -1 * v_item.qty,           -- negative = deduct
      'Order ' || left(p_order_id::text, 8),
      'Billing verify',
      null,
      null,
      false                      -- do NOT allow negative
    );
    v_deducted := v_deducted + 1;
  end loop;

  update orders set stock_deducted = true where id = p_order_id;
  return json_build_object('ok', true, 'items_processed', v_deducted, 'unmatched', v_skipped);
end;
$$;

notify pgrst, 'reload schema';
