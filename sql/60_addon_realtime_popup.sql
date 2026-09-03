-- ===========================================================================
-- 60_addon_realtime_popup.sql
--
-- Makes the Billing Team's "New Product Added" popup appear IMMEDIATELY when
-- a Sales Rep adds a product to an existing bill, instead of waiting for the
-- next poll.
--
-- Two parts:
--   1. ref_order_id — links an announcement to the exact order it is about,
--      so the popup's "View Bill" opens that specific bill rather than
--      inferring it from the shop name.
--   2. Realtime — publishes announcement_recipients so the app can subscribe
--      to inserts for the signed-in user and react the moment one lands.
--
-- Both additive. Existing announcements get ref_order_id = null, which the
-- popup already handles (it simply falls back to the bill list).
--
-- PREREQUISITE: 57_announcement_notif_type.sql must be applied first — it
-- adds the notif_type column these notifications depend on. Without it the
-- add-on insert is rejected and no notification is created at all.
-- ===========================================================================

alter table announcements add column if not exists ref_order_id uuid;

-- Publish the recipients table for realtime. Each targeted user gets their own
-- row, so the client can subscribe filtered by rep_id and be woken only by
-- notifications actually addressed to them.
do $$
begin
  alter publication supabase_realtime add table announcement_recipients;
exception
  when duplicate_object then null;  -- already published, nothing to do
end $$;

-- Realtime respects row-level security, so recipients must be able to read
-- their own rows for the subscription to deliver anything. Additive only.
drop policy if exists announcement_recipients_select_own on announcement_recipients;
create policy announcement_recipients_select_own on announcement_recipients
  for select
  using (rep_id = auth.uid());

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY
--
--   -- column present?
--   select column_name from information_schema.columns
--   where table_name = 'announcements' and column_name = 'ref_order_id';
--
--   -- table published for realtime?
--   select tablename from pg_publication_tables
--   where pubname = 'supabase_realtime' and tablename = 'announcement_recipients';
--
-- Then have a rep add a product to an already-placed order and confirm a row
-- appears, with the order correctly linked:
--
--   select a.title, a.notif_type, a.ref_order_id, a.created_at
--   from announcements a order by a.created_at desc limit 5;
-- ---------------------------------------------------------------------------
