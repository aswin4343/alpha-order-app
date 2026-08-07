-- ============================================================================
-- QC Team account setup
-- 1. Create logins in Supabase → Authentication → Users → Add user
--    (e.g. qc1@alpha.app, qc2@alpha.app — one per QC staff member).
-- 2. Run this for each, adjusting email + name.
-- ============================================================================

update public.profiles
set role = 'qc_team', full_name = 'QC Staff 1'
where id = (select id from auth.users where email = 'qc1@alpha.app');

-- Repeat for more QC staff:
-- update public.profiles set role='qc_team', full_name='QC Staff 2'
-- where id = (select id from auth.users where email='qc2@alpha.app');

-- Verify:
select p.full_name, p.role, u.email
from public.profiles p join auth.users u on u.id = p.id
where p.role = 'qc_team';
