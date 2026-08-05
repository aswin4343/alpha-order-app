-- ============================================================================
-- Alpha Trade Links V4 — BILLING MODULE, Phase 1 (foundation + pipeline re-route)
--
-- Inserts a Billing Team step between Sales and Delivery:
--   Sales Rep → Pending Billing → Billing verifies → Delivery Admin
--
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

-- 1. Billing role helper -----------------------------------------------------
create or replace function public.is_billing()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'billing_team'
  );
$$;

-- 2. Order status / billing fields ------------------------------------------
alter table public.orders
  add column if not exists billing_status text not null default 'pending',  -- pending | verified
  add column if not exists billing_verified_by uuid references public.profiles(id),
  add column if not exists billing_verified_at timestamptz,
  add column if not exists billing_notes text;

-- Index for the billing dashboard (pending lookups by rep).
create index if not exists orders_billing_status_idx on public.orders(billing_status);
create index if not exists orders_rep_billing_idx on public.orders(sales_rep_id, billing_status);

-- 3. STOP auto-creating deliveries on order insert --------------------------
--    Deliveries are now created only when Billing VERIFIES an order.
drop trigger if exists on_order_created_delivery on public.orders;

-- Keep the old function present but unused (harmless). New orders simply sit in
-- billing_status = 'pending' until verified.

-- 4. Verify + forward: create the delivery when billing verifies -------------
create or replace function public.verify_order_to_delivery(p_order_id uuid, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  o record;
  rep_name text;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'order not found'; end if;
  if o.billing_status = 'verified' then return; end if; -- idempotent

  select full_name into rep_name from public.profiles where id = o.sales_rep_id;

  -- Mark verified.
  update public.orders
     set billing_status = 'verified',
         billing_verified_by = auth.uid(),
         billing_verified_at = now(),
         billing_notes = coalesce(p_notes, billing_notes)
   where id = p_order_id;

  -- Create the delivery now (this is what makes it appear for Delivery Admin).
  insert into public.deliveries (order_id, shop_name, route, sales_rep_name, status)
  values (o.id, o.shop_name, coalesce(o.route,''), coalesce(rep_name,''), 'pending');
end;
$$;

grant execute on function public.verify_order_to_delivery(uuid, text) to authenticated;

-- 5. Auto-verify EXISTING orders so their deliveries keep working -----------
--    (Existing orders already have deliveries created by the old trigger, so
--     just mark them verified — do NOT create duplicate deliveries.)
update public.orders
   set billing_status = 'verified',
       billing_verified_at = now()
 where billing_status = 'pending'
   and exists (select 1 from public.deliveries d where d.order_id = orders.id);

-- Any pending orders that somehow have NO delivery: mark verified AND create one.
do $$
declare r record; rep_name text;
begin
  for r in
    select o.* from public.orders o
    where o.billing_status = 'pending'
      and not exists (select 1 from public.deliveries d where d.order_id = o.id)
  loop
    select full_name into rep_name from public.profiles where id = r.sales_rep_id;
    update public.orders set billing_status='verified', billing_verified_at=now() where id=r.id;
    insert into public.deliveries (order_id, shop_name, route, sales_rep_name, status)
    values (r.id, r.shop_name, coalesce(r.route,''), coalesce(rep_name,''), 'pending');
  end loop;
end $$;

-- 6. RLS: billing team can read all orders + order_items; verify via function
alter table public.orders enable row level security;

drop policy if exists orders_billing_read on public.orders;
create policy orders_billing_read on public.orders
  for select using ( public.is_billing() );

drop policy if exists orders_billing_update on public.orders;
create policy orders_billing_update on public.orders
  for update using ( public.is_billing() ) with check ( public.is_billing() );

drop policy if exists order_items_billing_read on public.order_items;
create policy order_items_billing_read on public.order_items
  for select using ( public.is_billing() );

-- Done. Phase 1 ready.
