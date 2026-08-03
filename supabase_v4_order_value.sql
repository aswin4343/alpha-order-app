-- ============================================================================
-- Alpha Trade Links V4 — add order value column (for performance reports)
-- Stores a rupee total per order (computed from priced products at save time).
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

alter table public.orders
  add column if not exists total_value numeric not null default 0;

-- Done.
