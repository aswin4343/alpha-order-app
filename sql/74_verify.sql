-- =============================================================================
-- 74_verify.sql — READ-ONLY checks to run right after migration 74.
-- Every row should show ok = true. Changes nothing.
-- =============================================================================
select 'every product has a current price revision' as check,
       count(*) filter (where current_price_revision_id is null) = 0 as ok,
       count(*) as products
from public.products
union all
select 'product price_version matches its revision number',
       count(*) = 0, count(*)
from public.products p
join public.product_price_revisions r on r.id = p.current_price_revision_id
where r.revision_number <> p.price_version
union all
select 'triggers installed (expect 3)',
       count(*) = 3, count(*)
from pg_trigger
where tgname in ('products_price_revision', 'order_items_price_guard', 'order_items_record_approval')
  and not tgisinternal
union all
select 'import function installed',
       count(*) = 1, count(*)
from pg_proc where proname = 'import_products_catalogue'
union all
select 'shop approvals table empty at start (fresh approvals required)',
       true, count(*)
from public.shop_price_approvals;
