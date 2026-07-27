-- ============================================================================
-- Alpha Trade Links V3 — fix "New Shops" counting
-- Adds a flag so only shops genuinely created via the New Customer form count
-- as "new shops" — not existing shops that merely got their first cloud order.
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

-- Add the flag (defaults to false = not a rep-created new shop).
alter table public.customers
  add column if not exists is_rep_created boolean not null default false;

-- Any existing rows so far were NOT created through the form on purpose,
-- so leave them false. (They came from first-order syncs of existing shops.)

-- Done.
