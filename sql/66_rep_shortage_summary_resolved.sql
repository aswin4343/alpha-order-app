-- ===========================================================================
-- 66_rep_shortage_summary_resolved.sql
--
-- Updates rep_shortage_summary (migration 65) so it reports CURRENT UNRESOLVED
-- shortage only — subtracting quantities already fulfilled through the existing
-- reschedule workflow — exactly matching the Billing report change in
-- loadShortageSalesLossReport / resolvedQtyByOriginItemId (cloudSync.js).
--
-- ONE SOURCE OF TRUTH: the shortage-detection rule is unchanged and identical to
-- the Billing report. The only addition is resolution:
--
--   A reschedule creates a NEW order_item pointing back to the original
--   stock-out line via rescheduled_from_item_id (migration 53). That new line
--   COUNTS as fulfillment only when:
--     * its own order is billing_status = 'verified'   (pending ≠ resolved)
--     * the delivered portion = qty − (its own shortage_qty)   (> 0)
--   resolved_qty(original) = Σ delivered portions pointing back to it
--   remaining_shortage     = max(0, shortage_qty − resolved_qty)
--
--   Lines whose remaining is 0 drop out of the summary; partially resolved
--   lines contribute only the remainder (qty AND lost-sales value). Nothing is
--   deleted — original short rows and their reschedule links stay intact for
--   history/audit; only what the summary DERIVES changes.
--
-- Security model is unchanged from 65: SECURITY DEFINER, rep = auth.uid(), no
-- rep-id parameter. Purely a recompute. Idempotent / safe to re-run.
-- Run in Supabase -> SQL Editor.
-- ===========================================================================

create or replace function public.rep_shortage_summary(
  p_single_day boolean,
  p_date       text,
  p_from       text,
  p_to         text,
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
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;

  return query
  with shortage_lines as (
    select
      oi.id           as origin_item_id,
      oi.product_name as product_name,
      -- identical shortage-qty rule to the Billing report (unchanged)
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
    where o.sales_rep_id = v_caller
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
    select origin_item_id, product_name, shortage_qty, unit_price
    from shortage_lines
    where shortage_qty > 0
  ),
  -- Delivered (verified, non-short) rescheduled qty pointing back to each origin
  resolved as (
    select
      r.rescheduled_from_item_id as origin_item_id,
      sum(
        greatest(
          coalesce(r.qty, 0)
          - case
              when r.removed is true and r.change_reason = 'Stock Out'
                then coalesce(r.qty, 0)
              when coalesce(r.removed, false) = false
                and r.change_type = 'qty'
                and r.original_qty is not null
                and r.original_qty > r.qty
                and r.change_reason ~* 'stock'
                then r.original_qty - r.qty
              else 0
            end,
          0
        )
      ) as resolved_qty
    from order_items r
    join orders ro on ro.id = r.order_id
    where r.rescheduled_from_item_id is not null
      and ro.billing_status = 'verified'
      and r.rescheduled_from_item_id in (select origin_item_id from positive)
    group by r.rescheduled_from_item_id
  ),
  remaining as (
    select
      p.product_name,
      greatest(p.shortage_qty - coalesce(rs.resolved_qty, 0), 0) as remaining_qty,
      p.unit_price
    from positive p
    left join resolved rs on rs.origin_item_id = p.origin_item_id
  ),
  active as (
    select product_name, remaining_qty, unit_price
    from remaining
    where remaining_qty > 0     -- fully resolved lines drop out
  )
  select
    count(*)::integer                                                          as total_items,
    coalesce(sum(remaining_qty), 0)::numeric                                   as total_qty,
    count(distinct product_name)::integer                                      as unique_products,
    coalesce(sum(round((remaining_qty * unit_price)::numeric, 2)), 0)::numeric as total_lost_value
  from active;
end;
$$;

revoke all on function public.rep_shortage_summary(boolean, text, text, text, text) from public;
grant execute on function public.rep_shortage_summary(boolean, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY (as a signed-in rep):
--   select * from rep_shortage_summary(true, '2025-09-08', null, null, null);
-- A rep whose only shortage has been fully rescheduled-and-verified must now
-- return 0,0,0,0. A partially resolved shortage returns the remaining figures.
-- ---------------------------------------------------------------------------
