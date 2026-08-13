-- ============================================================================
-- Alpha Trade Links — TWO Billing Team logins (shared queue)
--
-- This gives you two billing staff logins. Both see the SAME billing queue
-- (all orders), which is the standard shared-queue setup. No app code changes
-- are needed — the app already routes anyone with role 'billing_team' to the
-- Billing dashboard.
--
-- ┌── DO THIS FIRST (creating the actual logins) ─────────────────────────────┐
-- │ Passwords/logins CANNOT be created by SQL — they live in Supabase Auth.   │
-- │ In Supabase → Authentication → Users → "Add user", create these two       │
-- │ (choose any passwords you like and give them to your billing staff):      │
-- │    • billing1@alpha.app                                                    │
-- │    • billing2@alpha.app                                                    │
-- │ Tick "Auto Confirm User" so they can log in immediately.                  │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- THEN run the SQL below (Supabase → SQL Editor) to give them the billing role.
-- ============================================================================

-- Billing login 1
update public.profiles
set role = 'billing_team',
    full_name = 'Billing Staff 1'
where id = (select id from auth.users where email = 'billing1@alpha.app');

-- Billing login 2
update public.profiles
set role = 'billing_team',
    full_name = 'Billing Staff 2'
where id = (select id from auth.users where email = 'billing2@alpha.app');

-- ── Verify: you should see BOTH rows with role = billing_team ───────────────
select p.full_name, p.role, u.email
from public.profiles p
join auth.users u on u.id = p.id
where p.role = 'billing_team'
order by u.email;

-- ── Notes ──────────────────────────────────────────────────────────────────
-- • Already had an old 'billing@alpha.app' login? It still works and still has
--   the billing role — leave it, or remove it in Authentication → Users if you
--   want exactly two. Nothing breaks either way.
-- • Both logins share one queue: any order any billing person verifies moves on
--   for everyone (there is no per-user split). That's the intended setup.
-- • To rename a staff member later, just re-run one update with a new full_name.
