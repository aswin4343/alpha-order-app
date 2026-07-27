-- ============================================================================
-- Alpha Trade Links V3 — set roles & names
-- Run this AFTER you've created the 6 users in Authentication → Users.
-- Run in Supabase → SQL Editor → New query → paste → Run.
-- ============================================================================

-- Admin
update public.profiles p
set role = 'admin', full_name = 'Administrator'
from auth.users u
where u.id = p.id and u.email = 'admin@alpha.app';

-- Salespeople (name shown on orders & leaderboard, plus their route)
update public.profiles p
set role = 'salesperson', full_name = 'Anjali'
from auth.users u where u.id = p.id and u.email = 'anjali@alpha.app';

update public.profiles p
set role = 'salesperson', full_name = 'Aneesh'
from auth.users u where u.id = p.id and u.email = 'aneesh@alpha.app';

update public.profiles p
set role = 'salesperson', full_name = 'Bijoy'
from auth.users u where u.id = p.id and u.email = 'bijoy@alpha.app';

update public.profiles p
set role = 'salesperson', full_name = 'Rep 4'
from auth.users u where u.id = p.id and u.email = 'rep4@alpha.app';

update public.profiles p
set role = 'salesperson', full_name = 'Rep 5'
from auth.users u where u.id = p.id and u.email = 'rep5@alpha.app';

-- Verify: list all profiles with their role
select p.full_name, p.role, u.email
from public.profiles p
join auth.users u on u.id = p.id
order by p.role, p.full_name;
