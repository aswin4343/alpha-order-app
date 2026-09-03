-- ===========================================================================
-- 61_announcement_insert_permission.sql
--
-- THE REASON THE BILLING TEAM NEVER GETS THE ADD-ON POPUP.
--
-- The `announcements` table was built as an ADMIN feature: the admin writes an
-- announcement, everyone else reads it. Every existing writer is an admin
-- (ProductAdminPage).
--
-- Two newer notifications are created by NON-admins:
--   • Sales rep adds a product to an existing order  -> alert to Billing
--   • Billing removes a product from an order        -> alert to that rep
--
-- Both are inserted by the acting user's own session. If the INSERT policy is
-- admin-only, those inserts are blocked and NO announcement row is created —
-- so no bell item and no popup ever appear. Row-level security does not
-- necessarily raise a loud error here; it can simply affect zero rows, which
-- is why this failed silently for so long.
--
-- This migration ONLY WIDENS access. It adds policies and never drops or
-- narrows an existing one, so admin behaviour is unchanged.
--
-- NOTE: 57_announcement_notif_type.sql is still worth running — it adds
-- notif_type (which decides whether the popup button reads "View Bill",
-- "View Order" or "View Changes") and widens the audience CHECK constraint to
-- accept 'billing'. The app now falls back without it, but with reduced
-- functionality.
-- ===========================================================================

-- STEP 1 — Inspect what exists today. If there is no INSERT policy a
-- salesperson or billing user could satisfy, that confirms the diagnosis:
--
--   select policyname, cmd, qual, with_check
--   from pg_policies
--   where tablename in ('announcements', 'announcement_recipients');

-- STEP 2 — Allow any signed-in user to create an announcement.
-- Announcements are already readable by their recipients; this simply lets the
-- app raise a notification from the action that caused it, rather than
-- requiring an admin session.
drop policy if exists announcements_insert_authenticated on announcements;
create policy announcements_insert_authenticated on announcements
  for insert
  with check (auth.uid() is not null);

-- STEP 3 — And to create the recipient rows that direct it at specific users.
-- Without this the announcement is created but reaches nobody, which looks
-- identical to the notification never firing.
drop policy if exists announcement_recipients_insert_authenticated on announcement_recipients;
create policy announcement_recipients_insert_authenticated on announcement_recipients
  for insert
  with check (auth.uid() is not null);

-- STEP 4 — Recipients must be able to read and acknowledge their own rows,
-- otherwise the popup has nothing to load and "OK" cannot mark it read.
drop policy if exists announcement_recipients_select_own on announcement_recipients;
create policy announcement_recipients_select_own on announcement_recipients
  for select
  using (rep_id = auth.uid());

drop policy if exists announcement_recipients_update_own on announcement_recipients;
create policy announcement_recipients_update_own on announcement_recipients
  for update
  using (rep_id = auth.uid())
  with check (rep_id = auth.uid());

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY — have a rep add a product to an already-placed order, then run:
--
--   select a.id, a.title, a.audience, a.created_at,
--          (select count(*) from announcement_recipients r
--            where r.announcement_id = a.id) as recipients
--   from announcements a
--   order by a.created_at desc limit 5;
--
-- Expect a 'New Product Added' row with recipients > 0. If the row exists but
-- recipients = 0, STEP 3 did not take effect. If there is no row at all,
-- STEP 2 did not take effect.
-- ---------------------------------------------------------------------------
