-- ============================================================================
-- Alpha Trade Links V4 — Part 2: Delivery attendance (Punch In / Out)
-- Records each delivery person's working sessions (name + times + duration).
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

create table if not exists public.delivery_punches (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid references public.profiles(id),      -- the login account (vehicle)
  person_name text not null,                       -- name entered at punch-in
  punch_in timestamptz not null default now(),
  punch_out timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists punches_rep_idx on public.delivery_punches(rep_id);
create index if not exists punches_in_idx on public.delivery_punches(punch_in);

alter table public.delivery_punches enable row level security;

-- Delivery admin + sales admin: read all.
drop policy if exists punch_admin_read on public.delivery_punches;
create policy punch_admin_read on public.delivery_punches
  for select using ( public.is_delivery_admin() or public.is_admin() );

-- Delivery rep: read their own.
drop policy if exists punch_rep_read on public.delivery_punches;
create policy punch_rep_read on public.delivery_punches
  for select using ( rep_id = auth.uid() );

-- Delivery rep: insert/update their own punches.
drop policy if exists punch_rep_insert on public.delivery_punches;
create policy punch_rep_insert on public.delivery_punches
  for insert with check ( rep_id = auth.uid() );

drop policy if exists punch_rep_update on public.delivery_punches;
create policy punch_rep_update on public.delivery_punches
  for update using ( rep_id = auth.uid() );

-- Done.
