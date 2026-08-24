-- ===========================================================================
-- 47_ledger_category.sql  —  Ledger Category master + customer column
--
--  • ledger_categories : master list (extensible; seeded from the Excel's 3
--    distinct values, exact spellings preserved).
--  • customers.ledger_category : text value referencing a master name. Kept as
--    text (not a hard FK) to match the app's existing lightweight schema and to
--    avoid breaking inserts if the master is edited; the app validates against
--    the master list in the dropdown.
--
-- Existing customer data is untouched; the column is nullable so current rows
-- remain valid. A separate data-migration step (run from the app/CSV) maps the
-- 967 known customers by name.
-- ===========================================================================

create table if not exists ledger_categories (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  sort_order int default 0,
  created_at timestamptz not null default now()
);

insert into ledger_categories (name, sort_order) values
  ('RETAIL-CUSTOMER', 1),
  ('WHOLESALE-CUSTOMER', 2),
  ('ZEDGO - EXPRESS', 3)
on conflict (name) do nothing;

alter table customers add column if not exists ledger_category text;

-- Read access for authenticated users (reps + billing need the list/value).
alter table ledger_categories enable row level security;
drop policy if exists ledger_cat_read on ledger_categories;
create policy ledger_cat_read on ledger_categories for select using (auth.uid() is not null);
-- Only admins would edit the master in practice; keep insert open to authed for
-- now (mirrors the app's existing permissive customer policies) — tighten later.
drop policy if exists ledger_cat_write on ledger_categories;
create policy ledger_cat_write on ledger_categories for all using (auth.uid() is not null) with check (auth.uid() is not null);

notify pgrst, 'reload schema';
