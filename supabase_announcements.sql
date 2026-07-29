-- ============================================================================
-- Alpha Trade Links V3 — Announcements (in-app notifications)
-- Admin broadcasts to all or selected reps; reps see history + read/unread.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

-- One row per announcement the admin sends.
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  high_priority boolean not null default false,
  audience text not null default 'all',        -- 'all' or 'selected'
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

-- Which reps a 'selected' announcement targets (also created for 'all', to make
-- read-tracking uniform). One row per (announcement, recipient).
create table if not exists public.announcement_recipients (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid references public.announcements(id) on delete cascade,
  rep_id uuid references public.profiles(id) on delete cascade,
  read_at timestamptz,
  unique (announcement_id, rep_id)
);

alter table public.announcements enable row level security;
alter table public.announcement_recipients enable row level security;

-- ANNOUNCEMENTS: admin writes; a rep can read an announcement if they are a
-- recipient of it (or if it's an 'all' announcement).
drop policy if exists ann_admin_write on public.announcements;
create policy ann_admin_write on public.announcements
  for all using ( public.is_admin() ) with check ( public.is_admin() );

drop policy if exists ann_read on public.announcements;
create policy ann_read on public.announcements
  for select using (
    public.is_admin()
    or audience = 'all'
    or exists (
      select 1 from public.announcement_recipients r
      where r.announcement_id = id and r.rep_id = auth.uid()
    )
  );

-- RECIPIENTS: admin manages; a rep can see and update (mark read) only their own.
drop policy if exists rcpt_admin_all on public.announcement_recipients;
create policy rcpt_admin_all on public.announcement_recipients
  for all using ( public.is_admin() ) with check ( public.is_admin() );

drop policy if exists rcpt_self_read on public.announcement_recipients;
create policy rcpt_self_read on public.announcement_recipients
  for select using ( rep_id = auth.uid() or public.is_admin() );

drop policy if exists rcpt_self_update on public.announcement_recipients;
create policy rcpt_self_update on public.announcement_recipients
  for update using ( rep_id = auth.uid() );

-- Done.
