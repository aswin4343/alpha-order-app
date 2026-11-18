-- Mandatory scenario tests for migration 74, run against the local mirror.
\set ON_ERROR_STOP 1
\set QUIET 1
\pset footer off

\set admin   '00000000-0000-0000-0000-00000000000a'
\set rep1    '00000000-0000-0000-0000-0000000000r1'
\set rep2    '00000000-0000-0000-0000-0000000000r2'
\set billing '00000000-0000-0000-0000-0000000000b1'
-- (uuids must be hex)
\set rep1    '00000000-0000-0000-0000-0000000000e1'
\set rep2    '00000000-0000-0000-0000-0000000000e2'

create table if not exists test_results (n serial, name text, pass boolean, detail text);
truncate test_results restart identity;
grant all on test_results to authenticated; grant usage on sequence test_results_n_seq to authenticated;
create or replace function t_check(p_name text, p_pass boolean, p_detail text default null) returns void
language sql as $$ insert into test_results(name, pass, detail) values (p_name, coalesce(p_pass,false), p_detail) $$;

insert into profiles values (:'admin','Admin','admin',null),(:'rep1','Rep One','salesperson','R1'),
                            (:'rep2','Rep Two','salesperson','R2'),(:'billing','Bill','billing_team',null)
on conflict (id) do nothing;
insert into customers (id, shop_name, route, ledger_category) values
  ('aaaaaaaa-0000-0000-0000-00000000000a','SHOP A','R1','WHOLESALE-CUSTOMER'),
  ('bbbbbbbb-0000-0000-0000-00000000000b','SHOP B','R1','WHOLESALE-CUSTOMER'),
  ('cccccccc-0000-0000-0000-00000000000c','SHOP R','R1','RETAIL')
on conflict (id) do nothing;
\set shopA '''aaaaaaaa-0000-0000-0000-00000000000a'''
\set shopB '''bbbbbbbb-0000-0000-0000-00000000000b'''
\set shopR '''cccccccc-0000-0000-0000-00000000000c'''

-- Product A (wholesale ₹25 / retail ₹27) and an unrelated Product C.
insert into products (id, name, retail, wholesale, mrp, sort_order) values
  ('pA','TEST PRODUCT A', 27, 25, 35, 9000), ('pC','TEST PRODUCT C', 50, 45, 60, 9001);

-- helper: place a one-line order as the current user; returns the item row
create or replace function t_order(p_customer uuid, p_product text, p_price numeric,
                                   p_unit text default 'Piece', p_status text default null)
returns public.order_items language plpgsql as $$
declare o uuid; it public.order_items;
begin
  insert into orders (customer_id, shop_name, sales_rep_id) values (p_customer, 'x', auth.uid()) returning id into o;
  insert into order_items (order_id, product_name, qty, unit_price, entered_unit, approval_status)
  values (o, p_product, 10, p_price, p_unit, p_status) returning * into it;
  return it;
end $$;
grant execute on function t_order(uuid,text,numeric,text,text) to authenticated;

-- A verified order at the OLD price → source of the old Last Price
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select id as old_item, approved_price_version as old_ver from t_order(:shopA, 'TEST PRODUCT A', 25) \gset
reset role;
update orders set billing_status='verified', billing_verified_at=now()
 where id = (select order_id from order_items where id = :old_item);

-- ============ T1: Excel changes Product A ₹25 → ₹30 ============
select set_config('request.jwt.claim.sub', :'admin', false); set role authenticated;
select import_products_catalogue('merge',
  '[{"id":"pA","name":"TEST PRODUCT A","wholesale":30,"retail":32}]'::jsonb, 'master.xlsx') as r1 \gset
reset role;
select t_check('T1 price change creates a new revision',
  (select price_version from products where id='pA') = :old_ver + 1,
  format('version %s -> %s', :old_ver, (select price_version from products where id='pA')));
select t_check('T1 revision row records old and new prices',
  exists (select 1 from product_price_revisions where product_id='pA' and wholesale_price=30
          and previous_wholesale_price=25 and source='excel'));
select t_check('T1 import RPC reports the change', (:'r1'::jsonb->'price_changes'->0->>'product') = 'TEST PRODUCT A');
select t_check('T1 old Last Price line is now on an older revision (app hides it)',
  (select approved_price_version from order_items where id=:old_item) <> (select price_version from products where id='pA'));
select t_check('T1 price_changed_at stamped by the database', (select price_changed_at > now() - interval '1 minute' from products where id='pA'));

-- ============ T4: Shop A asks for ₹28 (below wholesale ₹30) ============
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
-- the app is bypassed on purpose: it sends approval_status = null
select id as a28, approval_status as a28_status from t_order(:shopA, 'TEST PRODUCT A', 28) \gset
reset role;
select t_check('T4 Shop A ₹28 requires Admin approval (server forced pending)', :'a28_status' = 'pending');

-- ============ T5: Admin approves Shop A ₹28 ============
select set_config('request.jwt.claim.sub', :'admin', false); set role authenticated;
update order_items set approval_status='approved', approved_by='Admin', approved_at=now() where id = :a28;
reset role;
select t_check('T5 approval saved permanently with full identity',
  exists (select 1 from shop_price_approvals a join products p on p.id=a.product_id
          where a.product_id='pA' and a.customer_id=:shopA and a.approved_price=28.00
            and a.price_revision_id=p.current_price_revision_id and a.status='approved'
            and a.approved_by=:'admin'::uuid and a.approved_at is not null),
  (select format('%s rows', count(*)) from shop_price_approvals));

-- ============ T6: Shop A orders ₹28 again ============
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as t6 from t_order(:shopA, 'TEST PRODUCT A', 28) \gset
select coalesce(approval_status,'') as t6b from t_order(:shopA, 'TEST PRODUCT A', 28.00) \gset
reset role;
select t_check('T6 Shop A ₹28 again → no new approval', :'t6' = '' , coalesce(nullif(:'t6',''),'null'));
select t_check('T6 ₹28.00 is the same price as ₹28', :'t6b' = '');

-- ============ T12b: a different rep, same shop ============
select set_config('request.jwt.claim.sub', :'rep2', false); set role authenticated;
select coalesce(approval_status,'') as t12 from t_order(:shopA, 'TEST PRODUCT A', 28) \gset
reset role;
select t_check('T12 different Sales Rep → same Shop A approval recognised', :'t12' = '');

-- ============ T7: Shop B asks for the same ₹28 ============
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as t7 from t_order(:shopB, 'TEST PRODUCT A', 28) \gset
-- ============ T8: Shop A ₹27 / ₹29 / ₹28.01 ============
select coalesce(approval_status,'') as t8a from t_order(:shopA, 'TEST PRODUCT A', 27) \gset
select coalesce(approval_status,'') as t8b from t_order(:shopA, 'TEST PRODUCT A', 29) \gset
select coalesce(approval_status,'') as t8c from t_order(:shopA, 'TEST PRODUCT A', 28.01) \gset
reset role;
select t_check('T7 Shop B ₹28 → new Admin approval required', :'t7' = 'pending');
select t_check('T8 Shop A ₹27 → new approval required', :'t8a' = 'pending');
select t_check('T8 Shop A ₹29 → new approval required', :'t8b' = 'pending');
select t_check('T8 Shop A ₹28.01 → new approval required', :'t8c' = 'pending');

-- ============ Category rules ============
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as c1 from t_order(:shopR, 'TEST PRODUCT A', 32) \gset
select coalesce(approval_status,'') as c2 from t_order(:shopR, 'TEST PRODUCT A', 30) \gset
select coalesce(approval_status,'') as c3 from t_order(:shopA, 'TEST PRODUCT A', 30) \gset
select coalesce(approval_status,'') as c4 from t_order(:shopR, 'TEST PRODUCT A', 30, 'Box') \gset
select coalesce(approval_status,'') as c5 from t_order(:shopR, 'TEST PRODUCT A', 29, 'Box') \gset
select coalesce(approval_status,'') as c6 from t_order(:shopA, 'TEST PRODUCT A', 28, 'Piece', 'approved') \gset
reset role;
select t_check('Retail customer at current Retail ₹32 → no approval', :'c1' = '');
select t_check('Retail customer at Wholesale ₹30 → approval required', :'c2' = 'pending');
select t_check('Wholesale customer at current Wholesale ₹30 → no approval', :'c3' = '');
select t_check('Box unit at wholesale (existing rule) → no approval', :'c4' = '');
select t_check('Box unit below wholesale → approval required', :'c5' = 'pending');
select t_check('Rep cannot self-mark a line "approved" (only matching approval passes)', :'c6' = 'approved');
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as c7 from t_order(:shopB, 'TEST PRODUCT A', 28, 'Piece', 'approved') \gset
reset role;
select t_check('Rep self-marking "approved" without a valid approval → forced pending', :'c7' = 'pending');

-- ============ Wrong product_id sent by the app ============
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
insert into orders (id, customer_id, shop_name, sales_rep_id) values ('dddddddd-0000-0000-0000-00000000000d', :shopB, 'x', auth.uid());
insert into order_items (order_id, product_name, product_id, qty, unit_price, entered_unit)
values ('dddddddd-0000-0000-0000-00000000000d', 'TEST PRODUCT A', 'pA__addon', 1, 28, 'Piece');
reset role;
select t_check('App sends a bogus product_id → product resolved from name, still enforced',
  (select approval_status = 'pending' and product_id = 'pA' from order_items where order_id='dddddddd-0000-0000-0000-00000000000d'));

-- ============ Edit after approval ============
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select id as e1 from t_order(:shopA, 'TEST PRODUCT A', 28) \gset
update order_items set unit_price = 26 where id = :e1;
reset role;
select t_check('Rep edits an approved-price line down to ₹26 → pending again',
  (select approval_status from order_items where id=:e1) = 'pending');

-- ============ Billing / admin edits are not gated ============
select set_config('request.jwt.claim.sub', :'billing', false); set role authenticated;
select coalesce(approval_status,'') as b1 from t_order(:shopB, 'TEST PRODUCT A', 20) \gset
reset role;
select t_check('Billing-team edits are not re-gated', :'b1' = '');

-- ============ T9: same Excel uploaded again ============
select set_config('request.jwt.claim.sub', :'admin', false); set role authenticated;
select (select count(*) from product_price_revisions) as revs_before \gset
select import_products_catalogue('merge',
  '[{"id":"pA","name":"TEST PRODUCT A","wholesale":30,"retail":32}]'::jsonb, 'master.xlsx') as r9 \gset
select import_products_catalogue('merge',
  '[{"id":"pA","name":"test product a ","wholesale":30.00,"retail":32.0}]'::jsonb, 'master.xlsx') as r9b \gset
-- non-price fields only: MRP, GST, HSN, packaging, sell-by
select import_products_catalogue('merge',
  '[{"id":"pA","name":"TEST PRODUCT A","mrp":40,"gst":18,"hsn":"1234","qty_in_box":24,"sell_by_box":true}]'::jsonb, 'm.xlsx') \gset
reset role;
select t_check('T9 same Excel uploaded again → no new revision',
  (select count(*) from product_price_revisions) = :revs_before,
  format('%s -> %s', :revs_before, (select count(*) from product_price_revisions)));
select t_check('T9 MRP/GST/HSN/packaging-only change → no new revision',
  (select price_version from products where id='pA') = :old_ver + 1);
select t_check('T9 non-price fields were applied', (select mrp = 40 and qty_in_box = 24 from products where id='pA'));
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as t9c from t_order(:shopA, 'TEST PRODUCT A', 28) \gset
reset role;
select t_check('T9 Shop A approval still valid after re-upload', :'t9c' = '');

-- ============ T10: another product's price changes ============
select set_config('request.jwt.claim.sub', :'admin', false); set role authenticated;
select import_products_catalogue('merge', '[{"id":"pC","name":"TEST PRODUCT C","wholesale":44}]'::jsonb, 'm.xlsx') \gset
reset role;
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as t10 from t_order(:shopA, 'TEST PRODUCT A', 28) \gset
reset role;
select t_check('T10 Product C price change → Product A approval for Shop A still valid', :'t10' = '');
select t_check('T10 Product C got its own new revision', (select price_version from products where id='pC') = 2);

-- Shop B approval at this revision, used to prove T11 invalidates every shop
select set_config('request.jwt.claim.sub', :'admin', false); set role authenticated;
update order_items set approval_status='approved' where id = (
  select oi.id from order_items oi join orders o on o.id=oi.order_id
  where o.customer_id=:shopB and oi.product_id='pA' and oi.unit_price=28 and oi.approval_status='pending' limit 1);
reset role;

-- ============ Race: price changes while a request waits for Admin ============
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select id as race_item from t_order(:shopA, 'TEST PRODUCT A', 27.5) \gset
reset role;

-- ============ T11: Product A ₹30 → ₹35 ============
select set_config('request.jwt.claim.sub', :'admin', false); set role authenticated;
select import_products_catalogue('merge',
  '[{"id":"pA","name":"TEST PRODUCT A","wholesale":35,"retail":37}]'::jsonb, 'master2.xlsx') \gset
-- Admin approves the request that was made BEFORE the change
update order_items set approval_status='approved' where id = :race_item;
reset role;
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as t11a from t_order(:shopA, 'TEST PRODUCT A', 28) \gset
select coalesce(approval_status,'') as t11b from t_order(:shopB, 'TEST PRODUCT A', 28) \gset
select coalesce(approval_status,'') as t11c from t_order(:shopA, 'TEST PRODUCT A', 27.5) \gset
select coalesce(approval_status,'') as t11d from t_order(:shopA, 'TEST PRODUCT A', 35) \gset
reset role;
select t_check('T11 new revision created for ₹30 → ₹35', (select price_version from products where id='pA') = :old_ver + 2);
select t_check('T11 Shop A old ₹28 after new revision → new approval required', :'t11a' = 'pending');
select t_check('T11 Shop B old ₹28 after new revision → new approval required', :'t11b' = 'pending');
select t_check('Race: approval of a request made before the price change is not reusable', :'t11c' = 'pending');
select t_check('T11 ordering at the new master price ₹35 → no approval', :'t11d' = '');

-- ============ T13: history kept for audit ============
select t_check('T13 previous approvals remain stored for audit',
  (select count(*) from shop_price_approvals where product_id='pA') >= 3,
  (select string_agg(format('%s rev%s ₹%s %s', left(customer_id::text,8), revision_number, approved_price, status), '; ' order by id) from shop_price_approvals));
select t_check('T13 every price revision of Product A kept',
  (select count(*) from product_price_revisions where product_id='pA') = 3);

-- ============ Admin edits the price while approving ============
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select id as m1 from t_order(:shopA, 'TEST PRODUCT A', 31) \gset
reset role;
select set_config('request.jwt.claim.sub', :'admin', false); set role authenticated;
update order_items set approval_status='approved', approved_price=32 where id=:m1;
reset role;
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as m2 from t_order(:shopA, 'TEST PRODUCT A', 32) \gset
select coalesce(approval_status,'') as m3 from t_order(:shopA, 'TEST PRODUCT A', 31) \gset
reset role;
select t_check('Admin-adjusted approval (₹31 asked, ₹32 approved) → ₹32 reusable', :'m2' = '');
select t_check('Admin-adjusted approval → the asked ₹31 is NOT approved', :'m3' = 'pending');

-- ============ Approval later rejected → revoked ============
select set_config('request.jwt.claim.sub', :'admin', false); set role authenticated;
update order_items set approval_status='rejected' where id=:m1;
reset role;
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as m4 from t_order(:shopA, 'TEST PRODUCT A', 32) \gset
reset role;
select t_check('Approved line later rejected → approval revoked, needs approval again', :'m4' = 'pending');

-- ============ Approval switch OFF ============
update app_settings set price_approval_enabled=false;
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
select coalesce(approval_status,'') as off1 from t_order(:shopB, 'TEST PRODUCT A', 20) \gset
reset role;
update app_settings set price_approval_enabled=true;
select t_check('Approval workflow switched OFF in Admin → no server gating', :'off1' = '');

-- ============ Security ============
select set_config('request.jwt.claim.sub', :'rep1', false); set role authenticated;
do $$ begin
  perform import_products_catalogue('merge','[{"id":"pA","name":"TEST PRODUCT A","wholesale":1}]'::jsonb,'x');
  perform t_check('Sales rep cannot run the catalogue import', false);
exception when others then perform t_check('Sales rep cannot run the catalogue import', sqlerrm like 'Only an Admin%'); end $$;
do $$ begin
  insert into shop_price_approvals(product_id,product_name,customer_id,price_revision_id,revision_number,approved_price)
  values ('pA','x','bbbbbbbb-0000-0000-0000-00000000000b',(select current_price_revision_id from products where id='pA'),1,1);
  perform t_check('Sales rep cannot write approvals directly', false);
exception when others then perform t_check('Sales rep cannot write approvals directly', true, sqlerrm); end $$;
do $$ begin
  update products set price_version = 1, current_price_revision_id = null where id='pA';
  perform t_check('Client cannot reset a product revision (value ignored)',
    (select price_version from products where id='pA') > 1);
exception when others then perform t_check('Client cannot reset a product revision (value ignored)', true, sqlerrm); end $$;
reset role;

select n, case when pass then 'PASS' else 'FAIL' end as result, name, coalesce(detail,'') as detail
from test_results order by n;
select count(*) filter (where pass) as passed, count(*) filter (where not pass) as failed from test_results;
