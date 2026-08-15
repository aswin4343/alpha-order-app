-- ============================================================================
-- Alpha Trade Links — Merge duplicate customers (same shop name, different
-- route), created before the sync/duplicate-prevention fixes (v14b/v14c).
--
-- KEEPS the customer row with the MOST RECENT route change (i.e. the one
-- whose route was set by the permanent-route-change feature most recently —
-- approximated here as the row with the most recent created_at, since that's
-- typically the newest/duplicate one created BY the bug. See PART 0 to
-- confirm which row should really survive before running Parts 1-3).
--
-- Run PART 0 first and READ the results. This is real customer/order data —
-- if anything looks wrong, STOP and tell Claude before running Parts 1-3.
-- ============================================================================

-- ── PART 0 — PREVIEW ONLY (changes nothing) ──────────────────────────────────
-- Every shop name with more than one customer row (the duplicates).
select
  shop_name,
  count(*) as duplicate_count,
  array_agg(id order by created_at) as customer_ids,
  array_agg(route order by created_at) as routes,
  array_agg(created_at order by created_at) as created_dates
from public.customers
group by shop_name
having count(*) > 1
order by shop_name;

-- ============================================================================
-- STOP HERE. Look at the routes for each duplicate shop above.
-- The LAST route in each `routes` array (newest created_at) is what this
-- script will treat as "the real current route" and keep. If that's wrong
-- for any shop (e.g. the newest row is actually the stale one), tell Claude
-- before running Part 1-3 — this script can be adjusted per-shop.
-- ============================================================================

-- ── PART 1 — Reassign orders/visits from OLDER duplicate rows to the NEWEST
--    row for that shop name, then delete the now-unused older rows ──────────
do $$
declare
  dup record;
  ids uuid[];
  keep_id uuid;
  old_id uuid;
begin
  for dup in
    select shop_name, array_agg(id order by created_at desc) as ids_newest_first
    from public.customers
    group by shop_name
    having count(*) > 1
  loop
    ids := dup.ids_newest_first;
    keep_id := ids[1]; -- newest row = the one we keep

    -- Reassign every OTHER (older) row's orders/visits to the kept row.
    foreach old_id in array ids[2:array_length(ids,1)]
    loop
      update public.orders set customer_id = keep_id where customer_id = old_id;
      update public.visits set customer_id = keep_id where customer_id = old_id;
      delete from public.customers where id = old_id;
    end loop;
  end loop;
end $$;

-- ── VERIFY — should return 0 rows if everything merged correctly ────────────
select shop_name, count(*) as remaining_duplicates
from public.customers
group by shop_name
having count(*) > 1;

-- Done. Every shop now has exactly one customer row, using its most recently
-- created route. No orders or visits were deleted — only their customer_id
-- link was updated to point at the surviving row. Historical order/visit
-- ROUTE values (stored directly on those rows, not via the customer) are
-- completely unaffected by this merge.
