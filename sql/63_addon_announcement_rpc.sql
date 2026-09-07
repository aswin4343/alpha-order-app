-- ===========================================================================
-- 63_addon_announcement_rpc.sql
--
-- Replaces the broad "any authenticated user can insert into announcements"
-- policy (migration 61) with a narrowly-scoped, validated path — used ONLY
-- for the sales-rep-adds-an-add-on -> notify-billing case.
--
-- WHY: migration 61's policy (`with check (auth.uid() is not null)`) lets a
-- sales rep insert an announcement with ANY title, body, audience, or
-- recipient list — not just an add-on alert for their own order. It also
-- turned out to keep failing even after being confirmed present, which
-- points at either a conflicting policy or some other RLS interaction that
-- was never fully diagnosed. A SECURITY DEFINER function sidesteps that
-- entirely: it runs with the function owner's privileges, bypassing table
-- RLS internally, and does its OWN validation in code instead — so its
-- correctness doesn't depend on getting a client-facing policy exactly
-- right, and it can enforce far narrower rules than any RLS policy
-- realistically can (validate against a specific order, not just "is
-- logged in").
--
-- SCOPE NOTE: the "billing removes an item -> notify that rep" feature
-- (notifyRepOfRemoval) still uses migration 61's broader policy. Narrowing
-- that policy here would break that unrelated feature, which is out of
-- scope for this fix — the instruction was to fix the add-on notification
-- specifically, not to rearchitect every notification path. That other
-- path is a reasonable candidate for the same tightening in a follow-up.
-- ===========================================================================

create or replace function public.create_addon_announcement(
  p_order_id uuid,
  p_shop_name text,
  p_route text,
  p_rep_name text,
  p_product_summary text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_caller_role text;
  v_order_rep uuid;
  v_has_addon_item boolean;
  v_announcement_id uuid;
  v_billing_id uuid;
begin
  -- 1. Caller must be signed in.
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;

  -- 2. Caller must actually be a sales rep. Announcements have always been
  --    an admin-authored feature; this RPC is the one deliberate, narrow
  --    exception, and it should not be usable by an arbitrary role.
  select role into v_caller_role from profiles where id = v_caller;
  if v_caller_role is distinct from 'salesperson' then
    raise exception 'Only sales representatives can create an add-on notification';
  end if;

  -- 3. The referenced order must exist AND belong to the caller. Without
  --    this check, any signed-in rep could pass a colleague's order_id and
  --    generate a notification for it — this is what "validate the caller
  --    is authorized for THIS order" means in practice.
  select sales_rep_id into v_order_rep from orders where id = p_order_id;
  if v_order_rep is null then
    raise exception 'Order not found';
  end if;
  if v_order_rep is distinct from v_caller then
    raise exception 'This order does not belong to the caller';
  end if;

  -- 4. The order must actually CONTAIN an add-on line. This is what
  --    "validate that the add-on actually belongs to that order" means —
  --    it stops the RPC being called against a perfectly ordinary,
  --    non-add-on order just to generate an unwarranted alert.
  select exists(
    select 1 from order_items where order_id = p_order_id and is_addon = true
  ) into v_has_addon_item;
  if not v_has_addon_item then
    raise exception 'This order has no add-on items — nothing to notify Billing about';
  end if;

  -- 5. All validation passed — create the announcement. Audience, notif_type
  --    and the linked order are all fixed by this function, not supplied by
  --    the caller, so there is no way to use this RPC to send an announcement
  --    with arbitrary content, audience or target order.
  insert into announcements (title, body, high_priority, audience, created_by, notif_type, ref_order_id, expires_at)
  values (
    'New Product Added',
    format(
      E'A new product has been added to this customer''s bill by the Sales Representative.\n\nSales Representative: %s\nCustomer: %s%s\nProduct:\n%s',
      coalesce(p_rep_name, '—'),
      coalesce(p_shop_name, '—'),
      case when p_route is not null and p_route <> '' then ', ' || p_route else '' end,
      coalesce(p_product_summary, '—')
    ),
    true,
    'selected', -- narrowest value every version of this table already accepts
    v_caller,
    'addon',
    p_order_id,
    now() + interval '3 days'
  )
  returning id into v_announcement_id;

  -- 6. Target the billing team specifically — the function resolves this
  --    itself rather than trusting a caller-supplied recipient list, so the
  --    RPC can never be used to notify anyone other than billing.
  for v_billing_id in select id from profiles where role = 'billing_team' loop
    insert into announcement_recipients (announcement_id, rep_id)
    values (v_announcement_id, v_billing_id);
  end loop;

  return v_announcement_id;
end;
$$;

-- Only signed-in users may call this at all; the function's own body is what
-- actually restricts it to sales reps acting on their own orders.
revoke all on function public.create_addon_announcement(uuid, text, text, text, text) from public;
grant execute on function public.create_addon_announcement(uuid, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- TEST 3 from the spec — an arbitrary/invalid call should be denied. Run
-- this as any authenticated session; it should raise an exception, not
-- create a row:
--
--   select create_addon_announcement(
--     '00000000-0000-0000-0000-000000000000'::uuid, -- a non-existent order
--     'Fake Shop', 'EXP', 'Fake Rep', 'Fake Product'
--   );
--   -- expect: "Order not found"
--
-- VERIFY — after a genuine add-on, confirm exactly one row was created and
-- it reached the billing user(s):
--
--   select a.id, a.title, a.notif_type, a.ref_order_id, a.created_at,
--          (select count(*) from announcement_recipients r
--            where r.announcement_id = a.id) as recipients
--   from announcements a
--   where a.notif_type = 'addon'
--   order by a.created_at desc limit 5;
-- ---------------------------------------------------------------------------
