-- ============================================================================
-- Alpha Trade Links — Admin read-only access to deliveries (for Admin
-- Dashboard Phase C2: QC and Delivery overview sections)
--
-- The `deliveries` table currently has policies for delivery_admin (full
-- access), qc_team (read), and reps (their own rows) — but NOT for the
-- general `admin` role. Without this, Admin's new read-only QC/Delivery
-- overview pages would load successfully but silently show all-zero counts,
-- since RLS would filter out every row.
--
-- This adds ONE read-only policy so is_admin() can SELECT from deliveries.
-- It does NOT grant admin any insert/update/delete rights on deliveries —
-- verifying, assigning, and packing stay exclusively with QC/Delivery staff,
-- matching the read-only-visibility design for this feature.
--
-- Run in Supabase → SQL Editor. Additive and safe — does not touch any
-- existing policy, table, or row.
-- ============================================================================

drop policy if exists deliveries_admin_read on public.deliveries;
create policy deliveries_admin_read on public.deliveries
  for select using ( public.is_admin() );

-- Done.
