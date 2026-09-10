-- ===========================================================================
-- 67_product_qt_flag.sql
--
-- Adds a QT ("Without Tax") flag to products. QT products are ordered exactly
-- like normal products; the flag exists so the Billing Team can instantly see,
-- in the order's product list, that a product must be billed WITHOUT tax.
--
-- Backward compatible: defaults to false, so every existing product stays a
-- normal taxable product and every existing order is unaffected. The flag is
-- populated by the Admin's Master Excel "Merge" upload (new "QT" column). It is
-- a display/identification aid — it does NOT itself change any tax calculation.
--
-- Idempotent / safe to re-run. Run in Supabase -> SQL Editor.
-- ===========================================================================

alter table products add column if not exists is_qt boolean not null default false;

notify pgrst, 'reload schema';
