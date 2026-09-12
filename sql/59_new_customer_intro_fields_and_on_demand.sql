-- ===========================================================================
-- 59_new_customer_intro_fields_and_on_demand.sql
--
-- Two safe additive changes:
--
-- 1. Add intro_area, intro_category, intro_ledger_category columns to
--    orders so the complete New Customer form data is persisted at order
--    time and available to the Billing Team's NEW modal.
--    All existing orders are unaffected (columns default to null).
--
-- 2. No schema change is needed for ON-DEMAND — it is stored as the route
--    value 'ON-DEMAND' exactly like 'STORE-COUNTER'. This file just
--    documents that and serves as a migration marker.
--
-- Safe to re-run: uses "add column if not exists".
-- ===========================================================================

alter table public.orders
  add column if not exists intro_area             text,
  add column if not exists intro_category         text,
  add column if not exists intro_ledger_category  text;

notify pgrst, 'reload schema';
