-- =============================================================================
-- 74_price_revisions_shop_approvals.sql                       (Alpha Flow v227)
--
-- Product price revisions + shop-specific persistent custom-price approvals.
--
-- BUSINESS RULE
--   One Product + One Shop + One Master Price Revision + One Approved Price
--   = One reusable approval permission.
--
-- WHAT THIS DOES (all additive — nothing is dropped, no existing row deleted):
--   1. product_price_revisions  — one row per actual master price change
--                                 (retail or wholesale). Permanent history.
--   2. shop_price_approvals     — one row per (product, customer, revision,
--                                 approved price). Permanent history.
--   3. products.current_price_revision_id, order_items.product_id,
--      order_items.price_revision_id                         (new, nullable)
--   4. Trigger on products: the DATABASE decides when a price revision happens.
--      Only a real retail/wholesale change (to 2 decimals) creates a revision;
--      re-uploading the same file, or changing MRP / GST / HSN / name /
--      packaging / scheme, never does. Client-sent price_version is ignored.
--   5. Trigger on order_items (before insert/update): stamps the server's
--      current revision on every line, and — for sales reps — forces
--      approval_status='pending' on any line priced below the customer's
--      floor that has no valid approval for THIS shop at THIS revision at
--      THIS exact price. The app cannot bypass this.
--   6. Trigger on order_items (after update): whenever an Admin approves a
--      line (item-level or whole-bill), the approval is recorded permanently
--      in shop_price_approvals. Every approval path is covered automatically.
--   7. import_products_catalogue(mode, rows, file_name): the Excel upload
--      (Replace All and Merge) runs as ONE transaction. Products are matched
--      by name on the server; ID collisions are impossible.
--   8. Baseline revision for every existing product (revision_number =
--      its current price_version, so existing Last Price versions still line up).
--
-- EXISTING APPROVALS: deliberately NOT migrated into shop_price_approvals.
--   Historical approvals do not carry a trustworthy price revision (see audit),
--   so — per the requirement — each shop/product needs one fresh approval
--   after this migration. History tables are untouched and stay auditable.
--   customer_price_approvals (migration 73, if present) is left as-is and is
--   no longer read or written by the app.
--
-- SAFE TO RE-RUN: every statement is idempotent.
-- ROLLBACK: 74_rollback.sql (removes triggers/functions; keeps all data).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Preconditions — abort with a clear message instead of half-applying.
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_type text;
begin
  select string_agg(v.t || '.' || v.c, ', ' order by v.t, v.c) into v_missing
  from (values
    ('products','id'),('products','name'),('products','slabs'),('products','base'),
    ('products','mrp'),('products','retail'),('products','wholesale'),('products','net'),
    ('products','gst'),('products','hsn'),('products','qty_in_box'),('products','outer_qty'),
    ('products','box'),('products','is_qt'),('products','sell_by_piece'),
    ('products','sell_by_outer'),('products','sell_by_box'),('products','sort_order'),
    ('products','price_version'),('products','price_changed_at'),('products','price_changed_by'),
    ('products','price_increased'),('products','previous_retail'),('products','previous_wholesale'),
    ('products','wholesale_threshold'),
    ('products','last_approved_price'),('products','last_approved_version'),
    ('products','last_approved_at'),('products','last_approved_by'),
    ('order_items','id'),('order_items','order_id'),('order_items','product_name'),
    ('order_items','unit_price'),('order_items','normal_price'),('order_items','is_special_price'),
    ('order_items','approval_status'),('order_items','approved_price'),('order_items','approved_by'),
    ('order_items','entered_unit'),('order_items','approved_price_version'),('order_items','removed'),
    ('orders','id'),('orders','customer_id'),
    ('customers','id'),('customers','ledger_category'),
    ('profiles','id'),('profiles','role'),
    ('app_settings','id'),('app_settings','price_approval_enabled'),
    ('catalogue_meta','id'),('catalogue_meta','version'),('catalogue_meta','product_count'),
    ('catalogue_meta','file_name'),('catalogue_meta','uploaded_at'),('catalogue_meta','updated_at')
  ) as v(t, c)
  where not exists (
    select 1 from information_schema.columns ic
    where ic.table_schema = 'public' and ic.table_name = v.t and ic.column_name = v.c
  );
  if v_missing is not null then
    raise exception 'Migration 74 aborted — these columns do not exist in the live database: %. Send this message to the developer.', v_missing;
  end if;

  select data_type into v_type from information_schema.columns
   where table_schema='public' and table_name='customers' and column_name='id';
  if v_type <> 'uuid' then
    raise exception 'Migration 74 aborted — customers.id is %, expected uuid.', v_type;
  end if;

  select data_type into v_type from information_schema.columns
   where table_schema='public' and table_name='products' and column_name='id';
  if v_type not in ('text','character varying') then
    raise exception 'Migration 74 aborted — products.id is %, expected text.', v_type;
  end if;

  select data_type into v_type from information_schema.columns
   where table_schema='public' and table_name='order_items' and column_name='product_id';
  if v_type is not null and v_type not in ('text','character varying') then
    raise exception 'Migration 74 aborted — order_items.product_id already exists as %, expected text.', v_type;
  end if;
end $$;

-- Re-run safety: remove our triggers first so the backfill below never fires them.
drop trigger if exists products_price_revision        on public.products;
drop trigger if exists order_items_price_guard        on public.order_items;
drop trigger if exists order_items_record_approval    on public.order_items;

-- -----------------------------------------------------------------------------
-- 1. Price revision history
-- -----------------------------------------------------------------------------
create table if not exists public.product_price_revisions (
  id                       bigserial primary key,
  product_id               text        not null,   -- no FK: Replace All may delete a product; its history must survive
  product_name             text        not null,
  revision_number          integer     not null check (revision_number >= 1),
  retail_price             numeric(12,2),
  wholesale_price          numeric(12,2),
  mrp                      numeric(12,2),
  previous_retail_price    numeric(12,2),
  previous_wholesale_price numeric(12,2),
  source                   text        not null default 'excel'
                             check (source in ('baseline','excel','new_product','manual')),
  effective_at             timestamptz not null default now(),
  created_by               uuid,
  created_at               timestamptz not null default now(),
  constraint product_price_revisions_product_rev_uniq unique (product_id, revision_number)
);
create index if not exists product_price_revisions_product_idx
  on public.product_price_revisions (product_id, revision_number desc);

alter table public.products    add column if not exists current_price_revision_id bigint;
alter table public.order_items add column if not exists product_id        text;
alter table public.order_items add column if not exists price_revision_id bigint;
create index if not exists order_items_product_id_idx on public.order_items (product_id);

-- -----------------------------------------------------------------------------
-- 2. Shop-specific approvals
-- -----------------------------------------------------------------------------
create table if not exists public.shop_price_approvals (
  id                   bigserial primary key,
  product_id           text          not null,
  product_name         text          not null,
  customer_id          uuid          not null references public.customers(id) on delete restrict,
  price_revision_id    bigint        not null references public.product_price_revisions(id) on delete restrict,
  revision_number      integer       not null,
  approved_price       numeric(12,2) not null check (approved_price >= 0),
  requested_price      numeric(12,2),
  status               text          not null default 'approved' check (status in ('approved','revoked')),
  source_order_id      text,
  source_order_item_id text,
  approved_by          uuid,
  approved_by_name     text,
  approved_at          timestamptz   not null default now(),
  revoked_at           timestamptz,
  created_at           timestamptz   not null default now(),
  -- The approval identity. numeric(12,2) makes ₹28 / ₹28.00 / 28.001 one value.
  constraint shop_price_approvals_identity_uniq
    unique (product_id, customer_id, price_revision_id, approved_price)
);
create index if not exists shop_price_approvals_lookup_idx
  on public.shop_price_approvals (customer_id, product_id, price_revision_id)
  where status = 'approved';

-- -----------------------------------------------------------------------------
-- 3. Baseline revision for every existing product (only where none exists yet)
-- -----------------------------------------------------------------------------
insert into public.product_price_revisions
  (product_id, product_name, revision_number, retail_price, wholesale_price, mrp, source, effective_at)
select p.id,
       p.name,
       greatest(coalesce(round(p.price_version::numeric)::int, 1), 1),
       round(p.retail::numeric, 2),
       round(p.wholesale::numeric, 2),
       round(p.mrp::numeric, 2),
       'baseline',
       coalesce(p.price_changed_at, now())
from public.products p
where not exists (select 1 from public.product_price_revisions r where r.product_id = p.id);

update public.products p
set current_price_revision_id = r.id,
    price_version             = r.revision_number
from (
  select distinct on (product_id) id, product_id, revision_number
  from public.product_price_revisions
  order by product_id, revision_number desc
) r
where r.product_id = p.id
  and (p.current_price_revision_id is distinct from r.id
       or p.price_version is distinct from r.revision_number);

-- -----------------------------------------------------------------------------
-- 4. products trigger — the database owns price revisions
-- -----------------------------------------------------------------------------
create or replace function public.trg_products_price_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last      public.product_price_revisions%rowtype;
  v_has_last  boolean;
  v_retail    numeric := round(NEW.retail::numeric, 2);
  v_ws        numeric := round(NEW.wholesale::numeric, 2);
  v_prev_r    numeric;
  v_prev_w    numeric;
  v_next      integer;
  v_rev_id    bigint;
begin
  if TG_OP = 'UPDATE' then
    if v_retail is not distinct from round(OLD.retail::numeric, 2)
       and v_ws  is not distinct from round(OLD.wholesale::numeric, 2)
       and OLD.current_price_revision_id is not null then
      -- No applicable price change. Revision state is server-owned: ignore
      -- whatever the client sent for these columns.
      NEW.price_version             := OLD.price_version;
      NEW.current_price_revision_id := OLD.current_price_revision_id;
      NEW.price_changed_at          := OLD.price_changed_at;
      NEW.price_changed_by          := OLD.price_changed_by;
      NEW.previous_retail           := OLD.previous_retail;
      NEW.previous_wholesale        := OLD.previous_wholesale;
      NEW.price_increased           := OLD.price_increased;
      return NEW;
    end if;
  end if;

  select * into v_last
  from public.product_price_revisions
  where product_id = NEW.id
  order by revision_number desc
  limit 1;
  v_has_last := found;

  -- Same prices as the latest recorded revision (e.g. a row re-inserted
  -- unchanged): keep that revision, no new one.
  if v_has_last
     and v_last.retail_price    is not distinct from v_retail
     and v_last.wholesale_price is not distinct from v_ws then
    NEW.price_version             := v_last.revision_number;
    NEW.current_price_revision_id := v_last.id;
    if TG_OP = 'UPDATE' then
      NEW.price_changed_at   := OLD.price_changed_at;
      NEW.price_changed_by   := OLD.price_changed_by;
      NEW.previous_retail    := OLD.previous_retail;
      NEW.previous_wholesale := OLD.previous_wholesale;
      NEW.price_increased    := OLD.price_increased;
    end if;
    return NEW;
  end if;

  if TG_OP = 'UPDATE' then
    v_prev_r := round(OLD.retail::numeric, 2);
    v_prev_w := round(OLD.wholesale::numeric, 2);
  else
    v_prev_r := v_last.retail_price;
    v_prev_w := v_last.wholesale_price;
  end if;

  v_next := greatest(
              coalesce(v_last.revision_number, 0),
              case when TG_OP = 'UPDATE' then coalesce(round(OLD.price_version::numeric)::int, 0) else 0 end
            ) + 1;

  insert into public.product_price_revisions
    (product_id, product_name, revision_number, retail_price, wholesale_price, mrp,
     previous_retail_price, previous_wholesale_price, source, effective_at, created_by)
  values
    (NEW.id, NEW.name, v_next, v_retail, v_ws, round(NEW.mrp::numeric, 2),
     v_prev_r, v_prev_w,
     case when v_has_last or TG_OP = 'UPDATE' then 'excel' else 'new_product' end,
     now(), auth.uid())
  returning id into v_rev_id;

  NEW.price_version             := v_next;
  NEW.current_price_revision_id := v_rev_id;

  if v_has_last or TG_OP = 'UPDATE' then
    NEW.price_changed_at   := now();
    NEW.price_changed_by   := auth.uid();
    NEW.previous_retail    := v_prev_r;
    NEW.previous_wholesale := v_prev_w;
    NEW.price_increased    := coalesce(v_retail > v_prev_r, false) or coalesce(v_ws > v_prev_w, false);
  end if;

  -- The old global product-level approval must never carry across a revision.
  NEW.last_approved_price   := null;
  NEW.last_approved_version := null;
  NEW.last_approved_at      := null;
  NEW.last_approved_by      := null;
  return NEW;
end;
$$;

create trigger products_price_revision
  before insert or update on public.products
  for each row execute function public.trg_products_price_revision();

-- -----------------------------------------------------------------------------
-- 5. Shared check: is there a valid approval for this exact combination?
-- -----------------------------------------------------------------------------
create or replace function public.has_valid_shop_price_approval(
  p_product_id text, p_customer_id uuid, p_price numeric)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.shop_price_approvals a
    join public.products p on p.id = a.product_id
    where a.product_id        = p_product_id
      and a.customer_id       = p_customer_id
      and a.price_revision_id = p.current_price_revision_id
      and a.approved_price    = round(p_price, 2)
      and a.status            = 'approved'
  );
$$;

-- -----------------------------------------------------------------------------
-- 6. order_items guard — server-side enforcement for sales reps
-- -----------------------------------------------------------------------------
create or replace function public.trg_order_items_price_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prod     public.products%rowtype;
  v_customer uuid;
  v_ledger   text;
  v_enabled  boolean;
  v_role     text;
  v_floor    numeric;
  v_price    numeric;
begin
  -- Only a new line, a price change or a product swap is re-evaluated.
  -- Admin approve/reject, billing qty edits and removals pass straight through.
  if TG_OP = 'UPDATE'
     and NEW.unit_price   is not distinct from OLD.unit_price
     and NEW.product_name is not distinct from OLD.product_name
     and NEW.product_id   is not distinct from OLD.product_id then
    return NEW;
  end if;

  -- Resolve the product from its NAME (the catalogue identity everywhere in
  -- the app). A client-sent product_id is never trusted on its own: it is
  -- used only when the name is not in the catalogue.
  select * into v_prod
  from public.products
  where upper(btrim(name)) = upper(btrim(NEW.product_name))
  order by id
  limit 1;
  if not found and NEW.product_id is not null then
    select * into v_prod from public.products where id = NEW.product_id;
  end if;
  if v_prod.id is null then
    NEW.product_id := null;
    return NEW;      -- not a catalogue product: app behaviour unchanged
  end if;
  NEW.product_id := v_prod.id;

  -- Server truth: which revision this line was priced against.
  NEW.price_revision_id      := v_prod.current_price_revision_id;
  NEW.approved_price_version := v_prod.price_version;

  -- Enforcement applies to sales reps only (admin / billing edits are trusted).
  select role into v_role from public.profiles where id = auth.uid();
  if coalesce(v_role, '') <> 'salesperson' then return NEW; end if;

  select price_approval_enabled into v_enabled from public.app_settings where id = 1;
  if v_enabled is false then return NEW; end if;

  if NEW.unit_price is null or coalesce(NEW.removed, false) then return NEW; end if;
  if NEW.approval_status in ('pending', 'rejected') then return NEW; end if;

  select o.customer_id into v_customer from public.orders o where o.id = NEW.order_id;
  if v_customer is not null then
    select c.ledger_category into v_ledger from public.customers c where c.id = v_customer;
  end if;

  -- Customer's default price (same order as the app's defaultPriceValueFor).
  if upper(btrim(coalesce(v_ledger, ''))) = 'WHOLESALE-CUSTOMER' then
    v_floor := coalesce(v_prod.wholesale, v_prod.retail, v_prod.mrp);
  else
    v_floor := coalesce(v_prod.retail, v_prod.wholesale, v_prod.mrp);
  end if;
  v_floor := round(v_floor::numeric, 2);
  v_price := round(NEW.unit_price::numeric, 2);

  if v_floor is null or v_price >= v_floor then return NEW; end if;

  -- Existing rule: a Box sale at or above wholesale never needs approval.
  if upper(coalesce(NEW.entered_unit, '')) = 'BOX'
     and v_prod.wholesale is not null
     and v_price >= round(v_prod.wholesale::numeric, 2) then
    return NEW;
  end if;

  if v_customer is not null
     and public.has_valid_shop_price_approval(NEW.product_id, v_customer, v_price) then
    return NEW;   -- valid approval for this shop + revision + price
  end if;

  NEW.approval_status  := 'pending';
  NEW.is_special_price := true;
  return NEW;
end;
$$;

create trigger order_items_price_guard
  before insert or update on public.order_items
  for each row execute function public.trg_order_items_price_guard();

-- -----------------------------------------------------------------------------
-- 7. Record approvals permanently (covers item-level AND whole-bill approval)
-- -----------------------------------------------------------------------------
create or replace function public.trg_order_items_record_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer uuid;
  v_rev_no   integer;
  v_price    numeric;
begin
  -- Approved → record (or refresh) the shop approval.
  if NEW.approval_status = 'approved' and OLD.approval_status is distinct from 'approved' then
    -- A line without a server-stamped revision (created before migration 74)
    -- cannot prove which price revision it was approved against, so it does
    -- not become a reusable approval. Its own order is still approved.
    if NEW.product_id is null or NEW.price_revision_id is null then return null; end if;

    select o.customer_id into v_customer from public.orders o where o.id = NEW.order_id;
    if v_customer is null then return null; end if;

    select revision_number into v_rev_no
    from public.product_price_revisions where id = NEW.price_revision_id;
    if v_rev_no is null then return null; end if;

    v_price := round(coalesce(NEW.approved_price, NEW.unit_price)::numeric, 2);
    if v_price is null then return null; end if;

    insert into public.shop_price_approvals
      (product_id, product_name, customer_id, price_revision_id, revision_number,
       approved_price, requested_price, status, source_order_id, source_order_item_id,
       approved_by, approved_by_name, approved_at)
    values
      (NEW.product_id, NEW.product_name, v_customer, NEW.price_revision_id, v_rev_no,
       v_price, round(NEW.unit_price::numeric, 2), 'approved', NEW.order_id::text, NEW.id::text,
       auth.uid(), NEW.approved_by::text, now())
    on conflict (product_id, customer_id, price_revision_id, approved_price) do update
      set status           = 'approved',
          revoked_at       = null,
          approved_by      = excluded.approved_by,
          approved_by_name = excluded.approved_by_name,
          approved_at      = excluded.approved_at,
          source_order_id      = excluded.source_order_id,
          source_order_item_id = excluded.source_order_item_id;

  -- Previously approved line later rejected → revoke the approval it created.
  elsif OLD.approval_status = 'approved' and NEW.approval_status = 'rejected' then
    update public.shop_price_approvals
       set status = 'revoked', revoked_at = now()
     where source_order_item_id = NEW.id::text and status = 'approved';
  end if;
  return null;
end;
$$;

create trigger order_items_record_approval
  after update of approval_status on public.order_items
  for each row execute function public.trg_order_items_record_approval();

-- -----------------------------------------------------------------------------
-- 8. Atomic Excel import (Replace All + Merge)
--    p_rows: JSON array of product objects. Keys present are applied; in
--    'merge' mode absent keys are left untouched. Products are matched by
--    NAME (trimmed, case-insensitive) on the server.
-- -----------------------------------------------------------------------------
create or replace function public.import_products_catalogue(
  p_mode text, p_rows jsonb, p_file_name text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role        text;
  v_rev_before  bigint;
  v_updated     integer := 0;
  v_inserted    integer := 0;
  v_deleted     integer := 0;
  v_unmatched   text[]  := '{}';
  v_revised     jsonb;
  v_meta_ver    integer;
  v_count       integer;
begin
  if p_mode not in ('replace', 'merge') then
    raise exception 'import_products_catalogue: mode must be replace or merge';
  end if;
  select role into v_role from public.profiles where id = auth.uid();
  if coalesce(v_role, '') <> 'admin' then
    raise exception 'Only an Admin can upload the product catalogue';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'import_products_catalogue: no products in upload';
  end if;

  -- One import at a time; orders keep reading prices while it runs.
  lock table public.products in share row exclusive mode;

  select coalesce(max(id), 0) into v_rev_before from public.product_price_revisions;

  drop table if exists pg_temp._imp;
  create temp table _imp on commit drop as
  select e.ord::int                      as ord,
         e.r                             as r,
         btrim(e.r->>'name')             as name,
         upper(btrim(e.r->>'name'))      as key,
         nullif(btrim(e.r->>'id'), '')   as hint_id,
         null::text                      as resolved_id
  from jsonb_array_elements(p_rows) with ordinality as e(r, ord);

  if exists (select 1 from _imp where coalesce(name, '') = '') then
    raise exception 'import_products_catalogue: a product has no name';
  end if;
  if exists (select 1 from _imp group by key having count(*) > 1) then
    raise exception 'import_products_catalogue: duplicate product name in upload: %',
      (select string_agg(key, ', ') from (select key from _imp group by key having count(*) > 1 limit 5) d);
  end if;

  -- Resolve identity: 1) existing product with the same name keeps its id.
  update _imp i set resolved_id = m.id
  from (select distinct on (upper(btrim(name))) id, upper(btrim(name)) as key
        from public.products order by upper(btrim(name)), id) m
  where m.key = i.key;

  if p_mode = 'merge' then
    select coalesce(array_agg(name order by ord), '{}') into v_unmatched from _imp where resolved_id is null;
    delete from _imp where resolved_id is null;     -- merge never inserts
  else
    -- 2) new product: use the suggested id only if nobody owns it, else a
    --    name-derived id. Never overwrite a different product (v225 bug).
    update _imp i set resolved_id = i.hint_id
    where i.resolved_id is null and i.hint_id is not null
      and not exists (select 1 from public.products p where p.id = i.hint_id)
      and not exists (select 1 from _imp j where j.resolved_id = i.hint_id);
    update _imp i set resolved_id = 'p_' || substr(md5(i.key), 1, 16)
    where i.resolved_id is null;
    if exists (select 1 from _imp group by resolved_id having count(*) > 1) then
      raise exception 'import_products_catalogue: product id collision — upload aborted, nothing changed';
    end if;
  end if;

  -- Update matched products. Absent keys keep the current value.
  with src as (
    select i.resolved_id, i.ord, i.r, x.*
    from _imp i
    cross join lateral jsonb_populate_record(null::public.products, i.r) x
    where exists (select 1 from public.products p where p.id = i.resolved_id)
  )
  update public.products p set
    slabs         = case when s.r ? 'slabs'         then coalesce(s.slabs, p.slabs) else p.slabs end,
    net           = case when s.r ? 'net'           then coalesce(s.net, p.net)     else p.net end,
    base          = case when s.r ? 'base'          then s.base          else p.base end,
    mrp           = case when s.r ? 'mrp'           then s.mrp           else p.mrp end,
    retail        = case when s.r ? 'retail'        then s.retail        else p.retail end,
    wholesale     = case when s.r ? 'wholesale'     then s.wholesale     else p.wholesale end,
    gst           = case when s.r ? 'gst'           then s.gst           else p.gst end,
    hsn           = case when s.r ? 'hsn'           then s.hsn           else p.hsn end,
    qty_in_box    = case when s.r ? 'qty_in_box'    then s.qty_in_box    else p.qty_in_box end,
    outer_qty     = case when s.r ? 'outer_qty'     then s.outer_qty     else p.outer_qty end,
    box           = case when s.r ? 'box'           then s.box           else p.box end,
    is_qt         = case when s.r ? 'is_qt'         then coalesce(s.is_qt, false) else p.is_qt end,
    sell_by_piece = case when s.r ? 'sell_by_piece' then coalesce(s.sell_by_piece, true)  else p.sell_by_piece end,
    sell_by_outer = case when s.r ? 'sell_by_outer' then coalesce(s.sell_by_outer, false) else p.sell_by_outer end,
    sell_by_box   = case when s.r ? 'sell_by_box'   then coalesce(s.sell_by_box, false)   else p.sell_by_box end,
    wholesale_threshold = coalesce(p.wholesale_threshold,
                                   case when s.r ? 'qty_in_box' then s.qty_in_box else p.qty_in_box end),
    sort_order    = case when p_mode = 'replace' then s.ord - 1 else p.sort_order end
  from src s
  where p.id = s.resolved_id;
  get diagnostics v_updated = row_count;

  if p_mode = 'replace' then
    insert into public.products
      (id, name, slabs, base, mrp, retail, wholesale, net, gst, hsn,
       qty_in_box, outer_qty, box, is_qt, sell_by_piece, sell_by_outer, sell_by_box,
       sort_order, wholesale_threshold)
    select i.resolved_id, i.name, coalesce(x.slabs, '[]'), x.base, x.mrp, x.retail, x.wholesale,
           coalesce(x.net, '[]'), x.gst, x.hsn, x.qty_in_box, x.outer_qty, x.box,
           coalesce(x.is_qt, false), coalesce(x.sell_by_piece, true),
           coalesce(x.sell_by_outer, false), coalesce(x.sell_by_box, false),
           i.ord - 1, x.qty_in_box
    from _imp i
    cross join lateral jsonb_populate_record(null::public.products, i.r) x
    where not exists (select 1 from public.products p where p.id = i.resolved_id);
    get diagnostics v_inserted = row_count;

    delete from public.products p
    where not exists (select 1 from _imp i where i.resolved_id = p.id);
    get diagnostics v_deleted = row_count;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'product', r.product_name, 'revision', r.revision_number,
           'retail_from', r.previous_retail_price, 'retail_to', r.retail_price,
           'wholesale_from', r.previous_wholesale_price, 'wholesale_to', r.wholesale_price)
           order by r.product_name), '[]'::jsonb)
    into v_revised
  from public.product_price_revisions r
  where r.id > v_rev_before and r.source = 'excel';

  select count(*) into v_count from public.products;

  update public.catalogue_meta
     set version       = coalesce(version, 0) + 1,
         product_count = v_count,
         file_name     = case when p_mode = 'merge' and p_file_name is not null
                              then p_file_name || ' (merge)' else p_file_name end,
         uploaded_at   = now(),
         updated_at    = now()
   where id = 1
  returning version into v_meta_ver;

  return jsonb_build_object(
    'mode',          p_mode,
    'updated',       v_updated,
    'inserted',      v_inserted,
    'deleted',       v_deleted,
    'unmatched',     to_jsonb(v_unmatched),
    'price_changes', v_revised,
    'count',         v_count,
    'version',       v_meta_ver
  );
end;
$$;

revoke all     on function public.import_products_catalogue(text, jsonb, text) from public;
grant  execute on function public.import_products_catalogue(text, jsonb, text) to authenticated;
revoke all     on function public.has_valid_shop_price_approval(text, uuid, numeric) from public;
grant  execute on function public.has_valid_shop_price_approval(text, uuid, numeric) to authenticated;

-- -----------------------------------------------------------------------------
-- 9. Row Level Security — readable by signed-in users; written only by the
--    triggers above (security definer). Admins may revoke an approval.
-- -----------------------------------------------------------------------------
alter table public.product_price_revisions enable row level security;
alter table public.shop_price_approvals    enable row level security;

drop policy if exists product_price_revisions_read on public.product_price_revisions;
create policy product_price_revisions_read on public.product_price_revisions
  for select to authenticated using (true);

drop policy if exists shop_price_approvals_read on public.shop_price_approvals;
create policy shop_price_approvals_read on public.shop_price_approvals
  for select to authenticated using (true);

drop policy if exists shop_price_approvals_admin_revoke on public.shop_price_approvals;
create policy shop_price_approvals_admin_revoke on public.shop_price_approvals
  for update to authenticated
  using      (exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.role = 'admin'))
  with check (exists (select 1 from public.profiles pr where pr.id = auth.uid() and pr.role = 'admin'));

grant select on public.product_price_revisions to authenticated;
grant select, update (status, revoked_at) on public.shop_price_approvals to authenticated;

commit;

-- Make the new RPC visible to the app immediately.
notify pgrst, 'reload schema';
