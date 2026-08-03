-- ============================================================================
-- Alpha Trade Links V4 — Part 5: lightweight driver tracking
-- Stores each delivery rep's last-known location + time. Updated on delivery
-- completion and app open. NOT continuous live tracking.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

alter table public.profiles
  add column if not exists last_latitude double precision,
  add column if not exists last_longitude double precision,
  add column if not exists last_seen_at timestamptz;

-- Allow a delivery rep to update their OWN last-known location.
drop policy if exists profiles_self_location on public.profiles;
create policy profiles_self_location on public.profiles
  for update using ( id = auth.uid() )
  with check ( id = auth.uid() );

-- Done.
