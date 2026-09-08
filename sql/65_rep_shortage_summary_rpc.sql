-- ===========================================================================
-- 65_rep_shortage_summary_rpc.sql
--
-- Sales Rep-specific Product Shortage Summary — the four KPI metrics the
-- Billing Team's Product Shortage Sales Loss Report already shows (Shortage
-- Items, Shortage Qty, Unique Products Short, Lost Sales Value), but scoped to
-- the CALLING rep's own orders only.
--
-- WHY AN RPC (not just a client-side .eq('sales_rep_id', ...) filter):
-- the orders_read RLS policy was widened long ago (supabase_phase3b.sql) to
-- "any authenticated user may read", so Billing/QC/Admin can see every order.
-- That means table RLS alone does NOT stop one rep from reading another rep's
-- orders — a filter added on the client (`sales_rep_id = <id from JS>`) is not
-- a security boundary, because the client controls that id. This RPC closes
-- that gap the same way migrations 62/63 did for their features: it is
-- SECURITY DEFINER and derives the rep from auth.uid() SERVER-SIDE, ignoring
-- any caller-supplied identity entirely. There is no rep-id parameter to
-- tamper with, so a rep can never retrieve another rep's shortage figures.
--
-- ONE SOURCE OF TRUTH: the shortage detection below is the exact same rule the
-- Billing report uses (loadShortageSalesLossReport / shortageQtyForItem in
-- cloudSync.js) —
--   * a line REMOVED with change_reason = 'Stock Out'  -> its whole qty
--   * a line REDUCED (change_type='qty', original_qty > qty) whose
--     change_reason contains 'stock' (case-insensitive) -> the reduced amount
-- and Lost Sales Value = shortage_qty * unit_price, over VERIFIED, non-hidden
-- orders only. No second definition of "shortage" is introduced.
--
-- DATE / ROUTE SCOPING mirrors this dashboard's existing period + route logic
-- (loadPerformanceForDate): p_single_day = true means an equality check on the
-- plain YYYY-MM-DD order_date string; otherwise an inclusive order_date string
-- range. p_route null/'' = all of the rep's routes.
--
-- Purely additive. Does NOT touch the Billing report, its data, or any policy.
-- Run in Supabase -> SQL Editor. Idempotent / safe to re-run.
-- ===========================================================================

create or replace function public.rep_shortage_summary(
  p_single_day boolean,
  p_date       text,           -- used when p_single_day = true (YYYY-MM-DD)
  p_from       text,           -- used when p_single_day = false (YYYY-MM-DD)
  p_to         text,           -- used when p_single_day = false (YYYY-MM-DD)
  p_route      text default null
)
returns table (
  total_items      integer,
  total_qty        numeric,
  unique_products  integer,
  total_lost_value numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  -- Must be signed in. The rep is ALWAYS the caller — never a parameter.
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;

  return query
  with shortage_lines as (
    select
      oi.product_name as product_name,
      -- identical shortage-qty rule to the Billing report
      case
        when oi.removed is true and oi.change_reason = 'Stock Out'
          then coalesce(oi.qty, 0)
        when coalesce(oi.removed, false) = false
          and oi.change_type = 'qty'
          and oi.original_qty is not null
          and oi.original_qty > oi.qty
          and oi.change_reason ~* 'stock'
          then oi.original_qty - oi.qty
        else 0
      end as shortage_qty,
      coalesce(oi.unit_price, 0) as unit_price
    from orders o
    join order_items oi on oi.order_id = o.id
    where o.sales_rep_id = v_caller          -- security boundary (server-side)
      and o.billing_status = 'verified'
      and coalesce(o.hidden, false) = false
      and (
        (p_single_day and o.order_date = p_date)
        or
        (not p_single_day and o.order_date >= p_from and o.order_date <= p_to)
      )
      and (p_route is null or p_route = '' or o.route = p_route)
  ),
  positive as (
    select product_name, shortage_qty, unit_price
    from shortage_lines
    where shortage_qty > 0
  )
  select
    count(*)::integer                                                     as total_items,
    coalesce(sum(shortage_qty), 0)::numeric                               as total_qty,
    count(distinct product_name)::integer                                 as unique_products,
    coalesce(sum(round((shortage_qty * unit_price)::numeric, 2)), 0)::numeric as total_lost_value
  from positive;
end;
$$;

-- Only signed-in users may call it; the body restricts the data to the caller.
revoke all on function public.rep_shortage_summary(boolean, text, text, text, text) from public;
grant execute on function public.rep_shortage_summary(boolean, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY (run as a signed-in rep session):
--
--   -- today, all routes
--   select * from rep_shortage_summary(true, '2025-09-08', null, null, null);
--
--   -- a month range, one route
--   select * from rep_shortage_summary(false, null, '2025-09-01', '2025-09-30', 'EXP');
--
-- Both must return exactly one row of four numbers, counting ONLY the calling
-- rep's own verified-order shortages. A rep cannot pass another rep's id
-- because there is no id parameter — auth.uid() is authoritative.
-- ---------------------------------------------------------------------------
