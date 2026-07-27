# Alpha Trade Links V3 — Phase 3A Setup Guide

This phase adds **cloud login and sync** using Supabase. Follow these steps in order.
Everything here is done once. Take it slowly.

---

## What Phase 3A delivers

- Individual login for each salesperson (and an admin account)
- Orders and shop visits now save to the cloud, stamped with which rep did them
- Customer shop name + route sync to the cloud (phone / GST / address stay on the
  phone only — privacy rule respected)
- Foundation for the admin dashboard, leaderboard and previous-order loader (next phases)

---

## STEP 1 — Run the database setup

1. Open your Supabase dashboard → **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open `supabase_setup.sql` (in this folder), copy everything, paste it in.
4. Click **Run**.
5. Expect: *Success. No rows returned.* Your tables and security rules now exist.

---

## STEP 2 — Create the login accounts

Go to **Authentication → Users → Add user → Create new user**.
For **each** account, tick **Auto Confirm User** so they can log in right away.

Create these 6 accounts (set a password for each and save them somewhere safe):

| Email | Who |
|---|---|
| admin@alpha.app | Admin (you) |
| anjali@alpha.app | Anjali |
| aneesh@alpha.app | Aneesh |
| bijoy@alpha.app | Bijoy |
| rep4@alpha.app | Rep 4 |
| rep5@alpha.app | Rep 5 |

---

## STEP 3 — Set roles and names

1. Back in **SQL Editor → New query**.
2. Open `supabase_set_roles.sql`, copy everything, paste, **Run**.
3. The last line shows a table — confirm each person has the right role
   (admin = admin, everyone else = salesperson).

---

## STEP 4 — Deploy the app

Upload the contents of this folder to GitHub as usual (replace the old files).
Netlify rebuilds automatically.

---

## STEP 5 — Test login

1. Open the app (use a private tab to avoid the cache).
2. You should now see a **Sign In** screen.
3. Log in as a rep: username `anjali`, password (the one you set).
   (The app adds `@alpha.app` automatically — reps just type `anjali`.)
4. Place a test order. It sends to WhatsApp **and** saves to the cloud.
5. In Supabase → **Table Editor → orders**, confirm the order appears with the
   correct `sales_rep_id`.

---

## Notes

- Reps log in with just their first name as username (e.g. `anjali`) — the app
  appends `@alpha.app`. Admin logs in as `admin`.
- To reset a password: Authentication → Users → click the user → reset password.
- The publishable key in the app is safe to expose; security is enforced by the
  Row Level Security policies from Step 1.
- **Next phases:** previous-order loader, order editing with ADD-ONS, personal
  performance screen, then the full admin dashboard.
