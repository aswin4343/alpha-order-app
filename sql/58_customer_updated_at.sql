-- ===========================================================================
-- 58_customer_updated_at.sql
--
-- ROOT CAUSE FIX for "customer default route reverts after refresh".
--
-- The customers table can contain more than one row for the same shop_name
-- (historic duplicates). The app's customer sync treats shop_name as the
-- identity key, so it processes every matching cloud row and the LAST one it
-- touches wins. Rows were fetched ordered by created_at DESC, meaning the
-- OLDEST duplicate was applied last — and its stale route overwrote the newly
-- saved one on the device. The update itself was always correct; it was being
-- undone on the next sync.
--
-- created_at cannot break the tie, because the row that was updated may well
-- be the older one. The sync needs to know which row changed most recently,
-- so this adds updated_at and keeps it current on write.
--
-- Additive and non-destructive: no rows are merged or deleted, and existing
-- data is backfilled from created_at so ordering is sensible immediately.
-- ===========================================================================

alter table customers add column if not exists updated_at timestamptz;

-- Backfill so existing rows order sensibly straight away.
update customers set updated_at = created_at where updated_at is null;

-- Keep it accurate for every future write, regardless of which code path
-- performs the update.
create or replace function set_customer_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists customers_set_updated_at on customers;
create trigger customers_set_updated_at
  before update on customers
  for each row execute function set_customer_updated_at();

create index if not exists customers_shop_name_updated_idx
  on customers (shop_name, updated_at desc);

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- DIAGNOSTIC — find shops that have duplicate rows. These are what made the
-- route appear to revert. Nothing here changes data; it just shows you which
-- customers are affected so you can decide whether to merge them manually.
--
--   select shop_name, count(*) as rows, array_agg(route) as routes
--   from customers
--   group by shop_name
--   having count(*) > 1
--   order by count(*) desc;
-- ---------------------------------------------------------------------------
