-- ===========================================================================
-- 44_inventory_realtime.sql  —  Phase 2
-- Ensure the sales-rep dashboard can subscribe to live stock changes.
-- Idempotent: safe to run even if 43 already added the table to the publication.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'product_inventory'
  ) then
    alter publication supabase_realtime add table product_inventory;
  end if;
end $$;

notify pgrst, 'reload schema';
