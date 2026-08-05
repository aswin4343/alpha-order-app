-- ============================================================================
-- Alpha Trade Links V4 — Billing Team account setup
--
-- 1. First create the login in Supabase → Authentication → Users → Add user
--    (e.g. email: billing@alpha.app, set a password).
-- 2. Then run this to give it the billing_team role. Replace the email if
--    you used a different one.
-- ============================================================================

update public.profiles
set role = 'billing_team',
    full_name = 'Billing Team'
where id = (select id from auth.users where email = 'billing@alpha.app');

-- Verify:
select p.full_name, p.role, u.email
from public.profiles p join auth.users u on u.id = p.id
where u.email = 'billing@alpha.app';
