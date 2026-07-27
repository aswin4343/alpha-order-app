# Alpha Trade Links V3 — Phase 3C Round 2a (Product Management)

Lets the admin manage the product catalogue from the app, with Excel upload.
Products move to the cloud; reps download them to their phones automatically.

---

## IMPORTANT — read first

This is a **migration**: your 872 products move from inside the app into the
Supabase cloud. After this, the admin controls products, and reps download them.
Test carefully (see Step 4) because products are what reps order from.

---

## STEP 1 — Create the products table (one-time SQL)

Supabase → SQL Editor → New query → paste `supabase_products.sql` → Run.
This creates the `products` and `catalogue_meta` tables with admin-only write
access and rep read access.

---

## STEP 2 — Deploy the app

Upload the `v3app` contents to GitHub, commit, let Netlify publish.

---

## STEP 3 — Migrate your current products (one-time, as admin)

1. Log in as **admin** → dashboard.
2. Tap **📦 Product & Price Management**.
3. It will say the cloud catalogue is empty. Tap
   **"Migrate 872 products to cloud"**.
4. Confirm. Wait for "Done. 872 products published (version 1)."
   Your catalogue is now in the cloud.

---

## STEP 4 — Test (critical)

**As admin:**
- The Product Management screen should now show "872 products live · version 1".

**As a rep (private tab, log in as anjali):**
- Open the app. It downloads the cloud catalogue in the background.
- Search a product you know (e.g. "SOBISCO") — it should appear normally.
- Place a test order — should work exactly as before.

If reps can search and order, the migration succeeded.

---

## Updating products later (the whole point)

To change prices, add products, or update schemes:

1. Prepare the **complete** product list as an Excel file. Columns (any order,
   flexible names): **Item Name, MRP, RTP/Retail, WSP/Wholesale, Base, Buy,
   Free, Net**.
2. Admin → Product & Price Management → choose the Excel file.
3. It shows a confirm box: "Replace all N products with M from your file."
   Check the number looks right, tap **Replace all**.
4. Reps get the new catalogue automatically next time they open the app online.

**Remember:** upload the FULL list every time — it replaces everything. If you
upload a small file, the app warns you before replacing.

---

## How reps stay offline-capable

Reps download the catalogue when they open the app with internet, and cache it
on the phone. In a shop with no signal, they keep using the last downloaded
copy — search and ordering still work. They get updates on the next online open.

---

## Notes
- Only the admin account can change products (enforced by the database).
- If a rep's app ever seems to have old prices, they just need to open it once
  with internet to pull the latest.
- **Next — Round 2b:** targets, salesperson management, notifications.
