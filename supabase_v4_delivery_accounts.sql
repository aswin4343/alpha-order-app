-- ============================================================================
-- Alpha Trade Links V4 — set delivery account roles & names
-- Run AFTER creating the 7 delivery accounts in Authentication → Users.
-- ============================================================================

-- Delivery Admin
update public.profiles p set role='delivery_admin', full_name='Delivery Admin'
from auth.users u where u.id=p.id and u.email='delivery@alpha.app';

-- Delivery Reps (named by vehicle)
update public.profiles p set role='delivery_rep', full_name='Dost'
from auth.users u where u.id=p.id and u.email='dost@alpha.app';

update public.profiles p set role='delivery_rep', full_name='Omini'
from auth.users u where u.id=p.id and u.email='omini@alpha.app';

update public.profiles p set role='delivery_rep', full_name='Montra'
from auth.users u where u.id=p.id and u.email='montra@alpha.app';

update public.profiles p set role='delivery_rep', full_name='Mahindra'
from auth.users u where u.id=p.id and u.email='mahindra@alpha.app';

update public.profiles p set role='delivery_rep', full_name='Super Carry'
from auth.users u where u.id=p.id and u.email='supercarry@alpha.app';

update public.profiles p set role='delivery_rep', full_name='Auto'
from auth.users u where u.id=p.id and u.email='auto@alpha.app';

-- Verify
select p.full_name, p.role, u.email
from public.profiles p join auth.users u on u.id=p.id
where p.role in ('delivery_admin','delivery_rep')
order by p.role, p.full_name;
