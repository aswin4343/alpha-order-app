-- ============================================================================
-- Alpha Trade Links — Sales Rep: delete own order (any time, while still
-- billing_status = 'pending' only)
--
-- A sales rep can soft-delete an order THEY created, at any time, as long as
-- Billing has not yet verified it. Once Billing verifies an order, deletion
-- is permanently disabled for that order — the numbers are considered real
-- and locked in at that point.
--
-- Design: reuses the existing `hidden` column (already filtered out of every
-- performance/analytics/report query across the whole app — orders_read
-- policy, Admin Dashboard, Sales Trend, Top Products, Excel reports, etc.)
-- so a deleted order automatically disappears everywhere with ZERO other
-- query changes needed. billing_status is separately set to 'deleted' as a
-- clear, permanent label — used ONLY by Billing's new "Deleted" tab, which
-- deliberately queries past the hidden=true filter to show it, read-only,
-- for audit history. Nothing is ever hard-deleted.
--
-- Purely additive. Run in Supabase → SQL Editor.
-- ============================================================================

-- 1. Audit columns ------------------------------------------------------------
alter table public.orders
  add column if not exists hidden boolean not null default false,   -- defensive: ensure this exists even if not already present
  add column if not exists deleted_by uuid references public.profiles(id),
  add column if not exists deleted_at timestamptz,
  add column if not exists delete_reason text;

-- 2. RPC: delete_own_order ----------------------------------------------------
-- Server-side enforcement: a rep can only delete an order that is (a) theirs,
-- and (b) still billing_status = 'pending'. Both checks happen here, not just
-- in the UI, so this can't be bypassed by tampering with the client.
create or replace function public.delete_own_order(
  p_order_id uuid,
  p_reason text default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  o record;
begin
  select * into o from public.orders where id = p_order_id;

  if o.id is null then
    raise exception 'Order not found.';
  end if;

  if o.sales_rep_id <> auth.uid() then
    raise exception 'You can only delete your own orders.';
  end if;

  if o.hidden then
    raise exception 'This order has already been deleted.';
  end if;

  if o.billing_status <> 'pending' then
    raise exception 'This order has already been verified by Billing and can no longer be deleted.';
  end if;

  update public.orders
  set hidden = true,
      billing_status = 'deleted',
      deleted_by = auth.uid(),
      deleted_at = now(),
      delete_reason = p_reason
  where id = p_order_id;
end;
$$;

-- 3. Close a gap: verify_order_to_delivery must never act on a deleted order --
-- The existing function only guarded against re-verifying an already-verified
-- order (idempotency). It never checked for billing_status = 'deleted', so a
-- deleted order could theoretically still be "verified" and pushed to
-- delivery via direct RPC access. This override adds exactly that one guard;
-- every other line is identical to the existing (phase 3) function.
create or replace function public.verify_order_to_delivery(p_order_id uuid, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  o record;
  rep_name text;
  billing_name text;
  change_lines jsonb := '[]'::jsonb;
  edited_count int := 0;
  it record;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'order not found'; end if;
  if o.billing_status = 'verified' then return; end if;
  if o.billing_status = 'deleted' or o.hidden then
    raise exception 'This order was deleted by the sales rep and can no longer be verified.';
  end if;

  select full_name into rep_name from public.profiles where id = o.sales_rep_id;
  select full_name into billing_name from public.profiles where id = auth.uid();

  -- Build a change summary from any edited items.
  for it in
    select * from public.order_items
    where order_id = p_order_id and change_type is not null
  loop
    edited_count := edited_count + 1;
    if it.change_type = 'removed' then
      change_lines := change_lines || to_jsonb(
        format('Removed: %s (%s)', coalesce(it.original_product_name, it.product_name), coalesce(it.change_reason,'')));
    elsif it.change_type = 'replaced' then
      change_lines := change_lines || to_jsonb(
        format('Replaced: %s → %s (%s)', coalesce(it.original_product_name, it.product_name), it.product_name, coalesce(it.change_reason,'')));
    elsif it.change_type = 'qty' then
      change_lines := change_lines || to_jsonb(
        format('%s: qty %s → %s', it.product_name, coalesce(it.original_qty, it.qty), it.qty));
    end if;
  end loop;

  -- Mark verified.
  update public.orders
     set billing_status = 'verified',
         billing_verified_by = auth.uid(),
         billing_verified_at = now(),
         billing_notes = coalesce(p_notes, billing_notes)
   where id = p_order_id;

  -- Create the delivery.
  insert into public.deliveries (order_id, shop_name, route, sales_rep_name, status)
  values (o.id, o.shop_name, coalesce(o.route,''), coalesce(rep_name,''), 'pending');

  -- Notify the rep ONLY if there were edits.
  if edited_count > 0 then
    insert into public.order_notifications (order_id, sales_rep_id, shop_name, changes, changed_by)
    values (o.id, o.sales_rep_id, o.shop_name, change_lines, coalesce(billing_name,'Billing Team'));
  end if;
end;
$$;

-- Done.
