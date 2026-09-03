-- ===========================================================================
-- 59_customer_route_permission.sql
--
-- Lets a signed-in user UPDATE rows in `customers`, which is what the
-- "Make this the customer's default route" action needs.
--
-- WHY THIS MAY BE THE PROBLEM: row-level security does NOT raise an error on
-- a blocked UPDATE — it simply matches zero rows and reports success. So the
-- app could report "saved", update its local cache, and then show the old
-- route again after the next sync pulled the unchanged row back from the
-- cloud. That is exactly the reported "route reverts after refresh" symptom.
--
-- This is the same class of gap fixed for order_items in migration 54: every
-- previous write to `customers` came from an admin path, so a policy allowing
-- reps to update may never have existed.
--
-- ONLY WIDENS ACCESS. It adds a policy and never drops or narrows an existing
-- one, so admin and billing access are unaffected.
-- ===========================================================================

-- STEP 1 — Check what is currently allowed. If no UPDATE policy exists that a
-- salesperson satisfies, that confirms the diagnosis:
--
--   select policyname, cmd, qual, with_check
--   from pg_policies where tablename = 'customers';

-- STEP 2 — Allow any authenticated user to update a customer record.
-- Customers are shared master data in this app (every rep can already read and
-- create them), so this matches the existing access model rather than
-- introducing a narrower per-rep ownership rule that would break shared use.
drop policy if exists customers_update_authenticated on customers;
create policy customers_update_authenticated on customers
  for update
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY — after running this, change a customer's default route in the app,
-- then confirm the value actually landed in the database:
--
--   select id, shop_name, route, updated_at
--   from customers
--   where shop_name = 'HASHIM BAKERY'
--   order by updated_at desc nulls last;
--
-- Expect the route to show the newly chosen value. If more than one row comes
-- back for this shop, they are duplicates — see the diagnostic at the bottom
-- of 58_customer_updated_at.sql.
-- ---------------------------------------------------------------------------
