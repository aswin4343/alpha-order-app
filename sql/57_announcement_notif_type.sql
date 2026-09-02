-- ===========================================================================
-- 57_announcement_notif_type.sql
--
-- ROOT CAUSE FIX for "billing team never gets the add-on popup".
--
-- The app writes two things to `announcements` that the table did not accept:
--
--   1. notif_type — tags an announcement as 'addon' or 'product_update' so
--      the popup can show the right action ("View Bill" vs "View Changes").
--      The column was never created, so every insert carrying it was
--      rejected.
--   2. audience = 'billing' — used when an announcement targets the billing
--      team. If a CHECK constraint restricted audience to the older values,
--      that insert was rejected too.
--
-- Because the add-on notification is deliberately fire-and-forget (a failed
-- notification must never fail an order that saved correctly), the rejection
-- was caught and logged rather than surfaced — the order saved fine and the
-- notification silently vanished.
--
-- Both changes are additive and safe: existing announcements keep working and
-- get notif_type = null, which the popup already treats as a normal
-- announcement.
-- ===========================================================================

-- 1. The missing column.
alter table announcements add column if not exists notif_type text;

-- 2. Allow audience = 'billing'. The original constraint's name is unknown
--    and may differ between environments, so find any CHECK constraint on
--    `announcements` that references `audience`, drop it, and recreate a
--    permissive one. If no such constraint existed, nothing is dropped and
--    only the new constraint is added.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'announcements'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%audience%'
  loop
    execute format('alter table announcements drop constraint %I', c.conname);
  end loop;

  -- Recreate with the full set of values the app actually uses.
  begin
    alter table announcements
      add constraint announcements_audience_check
      check (audience in ('all', 'selected', 'billing'));
  exception when duplicate_object then
    null;
  end;
end $$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY (run after the migration):
--
--   select column_name from information_schema.columns
--   where table_name = 'announcements' and column_name = 'notif_type';
--   -- expect one row
--
-- Then have a rep add a product to an already-placed order and check:
--
--   select id, title, audience, notif_type, created_at
--   from announcements order by created_at desc limit 5;
--   -- expect a 'New Product Added' row with notif_type = 'addon'
-- ---------------------------------------------------------------------------
