-- ============================================================================
-- Alpha Trade Links V4 — track uploaded product file name + date
-- Lets Sales Admin see which file is the current live catalogue.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

alter table public.catalogue_meta
  add column if not exists file_name text,
  add column if not exists uploaded_at timestamptz;

-- Done.
