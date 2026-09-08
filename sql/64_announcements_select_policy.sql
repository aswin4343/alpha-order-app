-- ===========================================================================
-- 64_announcements_select_policy.sql
--
-- ROOT CAUSE of "Billing never gets the pop-up, even though the announcement
-- row and its recipient row both genuinely exist".
--
-- loadMyAnnouncements() reads via a PostgREST embedded join:
--
--   supabase.from('announcement_recipients')
--     .select('id, read_at, announcements(id, title, body, ...)')
--
-- This requires SELECT permission on BOTH announcement_recipients (which
-- migration 61 already granted, scoped to rep_id = auth.uid()) AND
-- announcements itself. No migration ever added a SELECT policy on the
-- parent `announcements` table — every earlier migration only ever touched
-- INSERT policies on it. With RLS enabled and zero SELECT policies, the
-- default is deny-all, so PostgREST's embedded join for `announcements`
-- comes back null for every row, for every user, every time.
--
-- The failure was invisible everywhere else in the chain: the insert (via
-- the create_addon_announcement RPC) succeeds and returns a real id, the
-- realtime INSERT event on announcement_recipients fires correctly (that
-- table's own RLS was already fine), and the popup's own re-fetch runs
-- without error — it just silently returns zero usable rows, because
-- loadMyAnnouncements() itself does `.filter((r) => r.announcements)`,
-- which quietly drops every row where the embedded join is null. No
-- exception anywhere, so every earlier diagnostic that checked "did the
-- insert succeed" came back clean while the real gap was a step later.
--
-- FIX: the narrowest possible SELECT policy — a user may see an
-- announcement if and only if they are a target recipient of it, via the
-- same announcement_recipients relationship the rest of this feature is
-- already built on. Not `using (true)`, not role-based, not audience-based
-- — scoped to the actual per-user targeting relationship that already
-- exists.
-- ===========================================================================

drop policy if exists announcements_select_via_recipient on announcements;
create policy announcements_select_via_recipient on announcements
  for select
  using (
    exists (
      select 1 from announcement_recipients ar
      where ar.announcement_id = announcements.id
        and ar.rep_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY — confirms the fix without needing a live add-on test. Run this
-- as the billing user's own session (or check via the app directly): it
-- should now return the existing addon/product_update announcements that
-- were always in the table but invisible until now.
--
--   select policyname, cmd from pg_policies
--   where tablename = 'announcements' and cmd = 'SELECT';
--   -- expect exactly one row: announcements_select_via_recipient
-- ---------------------------------------------------------------------------
