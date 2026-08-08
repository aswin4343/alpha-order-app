-- ============================================================================
-- Alpha Trade Links V4 — Announcement auto-expiry (3-day)
--
-- Adds an optional expiry timestamp to announcements. Admin-generated product
-- update announcements expire 3 days after creation; existing / manually sent
-- announcements have expires_at = NULL and NEVER expire (backward compatible).
--
-- Run in Supabase → SQL Editor. Safe — only adds a nullable column + index and
-- refreshes the rep read policy to hide expired rows.
-- ============================================================================

-- 1. Nullable expiry column. NULL = never expires (all existing rows).
alter table public.announcements
  add column if not exists expires_at timestamptz,
  add column if not exists notif_type text;  -- e.g. 'product_update' | null (manual)

create index if not exists announcements_expires_idx
  on public.announcements(expires_at);

-- 2. Refresh the rep READ policy so expired announcements disappear for reps.
--    (Admin still sees everything, including expired, for history.)
drop policy if exists ann_read on public.announcements;
create policy ann_read on public.announcements
  for select using (
    public.is_admin()
    or (
      (expires_at is null or expires_at > now())
      and (
        audience = 'all'
        or exists (
          select 1 from public.announcement_recipients r
          where r.announcement_id = id and r.rep_id = auth.uid()
        )
      )
    )
  );

-- Note: the app ALSO filters expired rows client-side (belt and suspenders),
-- so even a cached/edge-lagged policy will not surface expired popups.

-- Done.
