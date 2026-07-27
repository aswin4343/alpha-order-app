# Alpha Trade Links V3 — Phase 3B Setup

Phase 3B adds three salesperson features on top of the 3A cloud foundation:

1. **Previous-Order Loader** — selecting a repeat customer offers their recent
   orders (from any rep) to reload into the cart in one tap.
2. **Order Editing with Add-ons** — a reloaded order is fully editable; the rep
   can change quantities and add more products before sending.
3. **My Performance screen** — each rep sees their own Today / Week / Month
   counts for orders, quantity, shops and visits (chart icon in the header).

---

## STEP 1 — Run the security update (one-time)

The previous-order loader lets any rep see a shop's order history. This needs a
small security-rule change.

1. Supabase → **SQL Editor → New query**
2. Open `supabase_phase3b.sql`, copy all, paste, **Run**
3. It prints the current order policies at the end — confirm no error.

(If you skip this, the loader will simply show "No previous orders" because reps
can't read each other's orders.)

---

## STEP 2 — Deploy the app

Upload the contents of the `v3app` folder to GitHub as usual. Netlify rebuilds.

---

## STEP 3 — Test

Open in a private tab, log in as a rep.

**Previous-order loader:**
- Select a customer you've ordered for before (e.g. the shop from your 3A test).
- A "Previous Orders" panel should appear with that shop's past orders.
- Tap "Load this order" → the cart fills with those items.
- Edit quantities or add more products, then send as normal.
- Or tap "Start fresh order" to skip.

**My Performance:**
- Tap the chart icon in the top bar.
- See Today / This Week / This Month counts, plus all-time totals.
- Place an order, return to this screen — the counts should increase.

---

## Notes

- The loader matches products by name against the current catalogue. If a past
  order contained a product that's since been removed/renamed, that line is
  skipped and the rep is told how many were skipped.
- Performance figures are per-rep (each rep sees only their own).
- **Next: Phase 3C** — the admin dashboard (leaderboard, live monitoring,
  analytics, targets, product/price management).
