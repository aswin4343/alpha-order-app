# Alpha Trade Links V4 — Phase 4A (Delivery Foundation)

Adds the Delivery Management module's foundation. **The existing Sales & Admin
experience is completely unchanged** — delivery is a separate role-based module.

---

## What's in 4A

- Two new roles: **delivery_admin** and **delivery_rep**
- Orders **automatically appear** in the Delivery Admin dashboard the moment a
  sales rep creates them (no manual step)
- Delivery Admin dashboard: status counts, **route filter**, order list,
  **assign to delivery staff**, and delivery-staff management (name, mobile,
  routes, enable/disable)
- Delivery Rep dashboard: sees their assigned deliveries (the full checklist +
  photo + GPS workflow comes in 4B/4C)

---

## STEP 1 — Run the SQL (one-time)

Supabase → SQL Editor → New query → paste `supabase_v4_phase4a.sql` → Run.
This adds delivery columns/tables and a trigger that auto-creates a delivery
row for every new order. **It does not touch existing sales tables.**

---

## STEP 2 — Create delivery accounts (in Supabase)

Authentication → Users → Add user → Create new user (tick Auto Confirm):

- **Delivery Admin:** e.g. `delivery@alpha.app`
- **Delivery reps:** e.g. `driver1@alpha.app`, `driver2@alpha.app`

Then set their roles (SQL Editor → New query):
```sql
-- Delivery admin
update public.profiles p set role='delivery_admin', full_name='Delivery Admin'
from auth.users u where u.id=p.id and u.email='delivery@alpha.app';

-- Delivery reps (repeat per driver)
update public.profiles p set role='delivery_rep', full_name='Akhil'
from auth.users u where u.id=p.id and u.email='driver1@alpha.app';
```

---

## STEP 3 — Deploy

Upload `v3app` contents to GitHub, commit, let Netlify publish.

---

## STEP 4 — Test

1. **Golden Rule check:** log in as a sales rep (anjali) — everything looks and
   works exactly as before. Log in as sales admin — same dashboard as before.
2. **Delivery admin:** log in as `delivery` → you see the Delivery Admin
   dashboard with any existing orders listed, a route filter, and status counts.
3. **Assign:** on an order, pick a delivery staff from "Assign to…" — status
   changes to Assigned.
4. **Auto-flow:** log in as a sales rep, place a new order → log back in as
   delivery admin → that order appears in the list automatically.
5. **Delivery rep:** log in as `driver1` → sees deliveries assigned to them.

---

## Notes

- Delivery staff are just users with role `delivery_rep`. Create them in
  Supabase; manage their name/mobile/routes/active state in the app.
- **Next — Phase 4B:** delivery rep's full job (order detail, product
  checklist, undelivered reasons, complete delivery + WhatsApp report).
- **Then Phase 4C:** camera proof-of-delivery photos, Supabase Storage, GPS
  capture, and the smart customer-location system.
