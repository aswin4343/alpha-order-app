# Alpha Trade Links V3 — Phase 3C Round 1 (Admin Dashboard)

This build adds the **Admin Dashboard** and also bundles the earlier pending
fixes (rep identity, visit copy format, and accurate new-shop counting).

---

## What's new

**Admin Dashboard** — when you log in as `admin`, you now land on a dashboard
instead of the order screen. It shows:

- **Team snapshot** — this month's total orders, quantity, visits, new shops
  (plus today's orders/visits)
- **Leaderboard** — all reps ranked by a combined score, switchable between
  Today / This Week / This Month. Tap a rep to expand their detailed stats.
- **Recent activity** — the latest orders and visits across the team, live.

Combined score = `orders×10 + new shops×15 + visits×2 + quantity÷10`.

**Bundled fixes (from earlier):**
- Orders/visits always attributed to the correct logged-in rep
- Visit **Copy** button now matches the Save Visit format, with location
- **New Shops** counts only shops created via the New Customer form

---

## STEP 1 — Run the SQL (one-time)

If you haven't already run it: Supabase → SQL Editor → New query →
paste `supabase_fix_newshops.sql` → Run. (Adds the `is_rep_created` flag used
for accurate new-shop counting.)

---

## STEP 2 — Deploy

Upload the `v3app` contents to GitHub, commit, let Netlify publish.

---

## STEP 3 — Test

**As admin:**
1. Sign out of any rep account (Settings → Sign Out, or open a private tab).
2. Log in as `admin` (username `admin` + your admin password).
3. You should land on the **Admin Dashboard**, not the order screen.
4. You'll see the leaderboard with your reps, team totals, and recent activity
   (from the test orders/visits already in the cloud).
5. Switch Today / Week / Month, and tap a rep to see their breakdown.

**As a rep:** logging in as anjali/aneesh/etc. still shows the normal ordering
app — they never see the dashboard.

---

## Notes

- The dashboard reads all reps' data; this works because the admin account has
  the `is_admin()` permission from Phase 3A. Reps still can't see each other's
  analytics.
- Score weights can be tuned later (in `src/utils/cloudSync.js`, `SCORE_WEIGHTS`).
- **Phase 3C Round 2 (next):** targets, product/price management with Excel
  upload, salesperson management, notifications.
