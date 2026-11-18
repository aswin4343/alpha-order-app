-- =============================================================================
-- 74_rollback.sql — undo the BEHAVIOUR of migration 74, keep all DATA.
--
-- Removes the triggers and functions (no more server-side revisions,
-- enforcement or approval recording). Keeps product_price_revisions,
-- shop_price_approvals and the new columns, so no audit history is lost and
-- migration 74 can simply be run again later.
--
-- After rollback the v227 app still works: Merge falls back to the legacy
-- client-side merge, Replace All is refused (it needs the atomic RPC),
-- approved-price chips simply stop appearing as new approvals are not recorded.
-- =============================================================================
begin;
drop trigger  if exists products_price_revision     on public.products;
drop trigger  if exists order_items_price_guard     on public.order_items;
drop trigger  if exists order_items_record_approval on public.order_items;
drop function if exists public.trg_products_price_revision();
drop function if exists public.trg_order_items_price_guard();
drop function if exists public.trg_order_items_record_approval();
drop function if exists public.import_products_catalogue(text, jsonb, text);
drop function if exists public.has_valid_shop_price_approval(text, uuid, numeric);
commit;
notify pgrst, 'reload schema';
