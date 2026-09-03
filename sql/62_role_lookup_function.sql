-- ===========================================================================
-- 62_role_lookup_function.sql
--
-- WHY NO ADD-ON NOTIFICATION IS EVER CREATED.
--
-- notifyBillingOfAddon runs in the SALES REP's session and does:
--
--     select id from profiles where role = 'billing_team'
--
-- `profiles` normally restricts each user to their OWN row, so for a rep that
-- query returns an empty list. The function then finds no recipients and
-- returns silently — no announcement row, no recipients, no error anywhere.
-- That is why the table shows zero rows with notif_type = 'addon' even though
-- the insert permissions from migration 61 are correct: the code never gets
-- as far as inserting.
--
-- The same applies in reverse: notifyRepOfRemoval reads orders.sales_rep_id
-- from a BILLING session.
--
-- Fix: a SECURITY DEFINER function that returns just the user ids for a role.
-- It runs with the definer's rights, so it works from any signed-in session,
-- while exposing nothing but opaque ids — no names, emails or other profile
-- data. Row-level security on `profiles` itself is left completely untouched.
-- ===========================================================================

create or replace function public.user_ids_for_role(p_role text)
returns setof uuid
language sql
security definer
set search_path = public
as $$
  select id from profiles where role = p_role;
$$;

-- Any signed-in user may resolve recipients for a role. This returns ids only.
revoke all on function public.user_ids_for_role(text) from public;
grant execute on function public.user_ids_for_role(text) to authenticated;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- VERIFY
--
--   -- should list your billing users' ids
--   select * from public.user_ids_for_role('billing_team');
--
-- Confirm the diagnosis too — if this shows profiles is restricted to
-- auth.uid(), that is exactly why the rep's lookup came back empty:
--
--   select policyname, cmd, qual from pg_policies where tablename = 'profiles';
-- ---------------------------------------------------------------------------
