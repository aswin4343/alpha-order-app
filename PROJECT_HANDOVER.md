# ALPHA TRADE LINKS (ATL Flow) — Project Handover / Continuation Notes
*(Updated — supersedes any earlier handover doc. If an earlier doc conflicts with this one, trust this one.)*

## ⚠️ READ THIS FIRST — a real lesson from this session

**The live Supabase database and the SQL files in the project repo have drifted out of
sync before, more than once, and it broke live Billing in production.** Multiple `.sql`
migration files existed in the zip but had never actually been run against the real
database — this caused "Could not load items" errors for the Billing team, discovered
only when they hit it live. It took 3 rounds of guessing before we ran a proper
audit query instead.

**Rule going forward: never assume a SQL file "must already be run" just because it's
old or because a prior session's notes say a feature is "done."** Before debugging any
data-loading error, or before doing significant new work on `order_items`, `orders`,
or `products`, run a schema audit like this one (edit the table/column lists to match
what the current code actually queries):

```sql
select table_name, column_name from information_schema.columns
where (table_name, column_name) in (
  ('order_items','available'),('order_items','change_reason'),('order_items','change_type'),
  ('order_items','edited_at'),('order_items','edited_by'),('order_items','free_qty'),
  ('order_items','gst_percent'),('order_items','hsn'),('order_items','id'),
  ('order_items','is_addon'),('order_items','is_special_price'),('order_items','mrp'),
  ('order_items','normal_price'),('order_items','order_id'),('order_items','original_product_name'),
  ('order_items','original_qty'),('order_items','price_type'),('order_items','product_name'),
  ('order_items','qty'),('order_items','removed'),('order_items','scheme_applied'),
  ('order_items','scheme_enabled'),('order_items','unit'),('order_items','unit_price'),
  ('orders','billing_notes'),('orders','billing_status'),('orders','billing_verified_at'),
  ('orders','billing_verified_by'),('orders','brand'),('orders','created_at'),
  ('orders','customer_id'),('orders','delete_reason'),('orders','deleted_at'),
  ('orders','deleted_by'),('orders','hidden'),('orders','id'),('orders','intro_credit_days'),
  ('orders','intro_email'),('orders','intro_gstn'),('orders','intro_phone'),
  ('orders','is_new_customer'),('orders','latitude'),('orders','longitude'),
  ('orders','order_date'),('orders','sales_rep_id'),('orders','shop_name'),
  ('orders','total_products'),('orders','total_quantity'),('orders','total_value'),
  ('products','gst'),('products','hsn'),('products','id'),('products','net'),
  ('products','retail'),('products','slabs'),('products','wholesale')
)
order by table_name, column_name;
```
**Confirmed as of this handover: all 56 columns above exist** (last gap — `order_items.price_type` —
was just added and schema-reloaded via `notify pgrst, 'reload schema';`). This audit did
NOT cover other tables (`deliveries`, `customers`, `profiles`, `push_subscriptions`,
`billing_edit_events`, `announcements`, `app_settings`, `delivery_items`, etc.) — those
are working in practice (push notifications confirmed live) but were only spot-checked,
not exhaustively audited. If something on those breaks with a `42703` /
"column ... does not exist" error, do the SAME kind of audit immediately rather than
guessing which file to run.

**After ANY `alter table` that adds a column, always also run:**
```sql
notify pgrst, 'reload schema';
```
Supabase's API layer can keep serving the old table shape for a bit otherwise.

---

## What this is
A custom React (Vite + Tailwind) PWA for an FMCG distributor in Thiruvananthapuram, Kerala.
It's a Sales Force Automation + Billing + Delivery + Quality Control + Picker Bill + Full
Bill platform, covering two brands: **ALPHA TRADE LINKS** and **ZEDGO** (ZEDGO = the HoReCa
division of Alpha itself, just a different trading name — same company, dynamic branding
per order via `orders.brand`).

App name/icon: **ATL Flow**. Backend: Supabase (cloud Postgres, project ref
`nkbawdgxllsyktwppnhn`, Mumbai/ap-south-1). Deployed via GitHub + Netlify.

## How work is done
- The user is non-technical. Build in a sandbox, package a CUMULATIVE zip, user deploys.
- Deploy = unzip the latest zip → upload the `v3app` folder CONTENTS to GitHub repo
  `alpha-order-app` (user: aswin4343) → commit → Netlify auto-rebuilds.
- Netlify site: `guileless-cascaron-767cf6.netlify.app`
- **Custom domain is LIVE:** `sales.alphatradelinks.com` — confirmed working (DNS +
  HTTPS resolved, used throughout this whole session without issue).
- Test in incognito (cache is aggressive) — this matters even more now, since a stale
  browser cache masked how long the "Could not load items" bug had actually been live.
- The sandbox cannot reach Supabase or use camera/GPS — user verifies those live.
- After packaging, node_modules/dist are removed; run `npm install` again to rebuild.
- Working style: PHASE big features, build in sandbox, verify build compiles, package
  cumulative zip, flag SQL that must run first — **and now: verify it was ACTUALLY run**,
  don't just tell the user to run it and move on.
- **Important:** this project has been worked on across MULTIPLE separate Claude chat
  sessions (not just this one), sometimes without a clean handover between them. Code
  and SQL file history reflects that — don't assume the current session's own memory of
  "what's built" is complete; verify against the actual zip/code/database.

## Supabase
- Project URL: `https://nkbawdgxllsyktwppnhn.supabase.co`
- FREE PLAN — NO automatic backups. Export CSV manually before risky deletes.
- pg_cron + pg_net enabled. Storage bucket `delivery-photos` (public, 40-day auto-delete).
- Roles: admin, salesperson, delivery_admin, delivery_rep, billing_team, qc_team.
- Supabase CLI is set up on the user's Windows machine (PowerShell), already logged in
  and linked. Deploy Edge Functions with:
  `<path-to>\supabase.exe functions deploy <name> --no-verify-jwt`
- 40 SQL files currently in the project. Do not assume any of them have been run just
  because they're present in the repo — see the warning above.

## Modules built (current, cumulative — v9-full-bill.zip)
- **SALES:** order generator (872-product catalogue), schemes/free goods, price
  selection (MRP/Retail/Wholesale + custom edit, defaults to Wholesale), brand toggle
  (Alpha/ZEDGO), new customers, returns/credit notes, WhatsApp order, order date +
  editable route, My Performance with Date + Route filter, duplicate-order prevention,
  rep self-delete-order.
- **BILLING:** verify orders (grouped one card per shop/day, Pending/Verified/Add-ons
  tabs), edit qty/remove/replace with reasons (now pushes a notification to the rep,
  see below), date + express-route filters, TWO billing team logins, bill cancellation
  flow, **🧾 Full Bill** and **🖨️ Picker Bill** buttons on every shop order (both the
  plain case and the add-on-consolidated case).
- **DELIVERY:** admin dashboard, rep dashboard, delivery detail (checklist, photos, GPS,
  WhatsApp report, punch in/out), driver tracking.
- **ADMIN:** dashboard with sales trend chart, top-products donut, order-status donut,
  recent activity feed, read-only overview tabs for Billing/QC/Delivery (counts,
  pending/verified, cancelled-bills bell), Excel catalogue upload with automatic
  change-detection + auto-announcement (price up/down, scheme change, added/removed —
  ONE consolidated announcement, auto-expires in 3 days), staff management,
  announcements, Verified Orders tab, customer merge/dedup tooling.
- **QC:** role + multi-login, dashboard, soft gate, Packed By dropdown, per-product
  verification with auto-save/resume, live progress, error reporting.
- **PICKER BILL:** print-ready picking sheet, per shop-order (consolidated across
  original + add-ons). Dynamic company letterhead, shop/route/rep/date/order-ref
  header, SL NO / Product / MRP / Unit / QTY / large tick-box table, one-tap
  copy-to-clipboard on product names, dedicated print CSS (`.picker-bill-print`).
- **FULL BILL (new this session):** the Billing Team's internal GST-invoice-style view
  — SL/HSN/Description/MRP/Unit/QTY/Rate/FQTY/Taxable/GST%/Total table + GST-slab
  summary (SGST/CGST/Tax Amt), sub-total, round-off, total qty, grand total, amount in
  words. Uses `src/utils/billingCalc.js` (reverse-GST math: sales rep's price is
  ALWAYS after-tax; before-tax rate/taxable/GST are derived FROM the after-tax total,
  never independently recomputed, so they always reconcile exactly). Labeled
  "BILLING VIEW — INTERNAL ONLY" — explicitly NOT a legal customer invoice, no
  sequential invoice numbering (confirmed with user — not needed). Dedicated print CSS
  (`.full-bill-print`, same isolation technique as Picker Bill).
  **Alpha Trade Links' GSTIN/FSSAI/address is still a placeholder** (`GSTIN — to be
  added`) in `src/components/PickerBill.jsx`'s `COMPANY_INFO` constant (shared by both
  bill views). Update it there once the user provides real details.
- **PUSH NOTIFICATIONS (external, real device push — confirmed working live):**
  - **Architecture: ONE consolidated Edge Function `send-qc-push`** handling THREE
    event kinds via a `kind` param: `'qc'` (default), `'announcement'`, `'billing_edit'`.
    (An earlier two-function design — `send-qc-push` + `send-announcement-push` — was
    abandoned; `send-announcement-push` was dead code and has been REMOVED from the
    zip as of v9.)
  - QC gets a push the moment Billing verifies a bill (shop, bill no, verified-by),
    deep-links to that QC task. **Confirmed working.**
  - Sales reps get a push when Admin posts a product-update announcement, deep-links
    to Announcements. **Confirmed working** (user directly verified).
  - Sales reps ALSO get a push when Billing edits their order (qty change/remove/
    replace) — `kind: 'billing_edit'`, backed by a `billing_edit_events` table,
    deep-links to that order. Built by another session; not independently re-verified
    live in this session, but wiring looks complete and consistent.
  - Infra: VAPID keypair (public key baked into the app; private key + a shared
    `QC_PUSH_SECRET` live only in Supabase secrets), Postgres triggers on `deliveries`,
    `announcements`, and (presumably) an order-edit event table — all via `pg_net` —
    custom service worker (`src/sw.js`, injectManifest mode, NOT default generateSW),
    `push_subscriptions` table, `app_settings` singleton row holding
    `qc_push_function_url` + `qc_push_secret`.
  - Each user enables notifications ONCE per device via a "Turn on notifications"
    banner. iPhone requires "Add to Home Screen" first. Subscriptions are
    domain-specific — now that everyone's on `sales.alphatradelinks.com`, that's a
    non-issue going forward.

## Queued / not yet built
1. Delivery-side product dedup confirmation when billing verifies as-is.
2. QC Phase 2 (deeper error/audit trail), Phase 3 (packing-staff performance +
   auto-flagging), Phase 4 (5-sheet Excel report engine).

## Known issues / open threads
- **A staff QC phone got "Could not enable notifications on this device."** Status
  unknown — was mid-troubleshooting (clear Chrome cache / check Site Settings →
  Notifications isn't blocked) several sessions ago, never confirmed resolved. Ask
  the user directly before assuming it's fine.
- **Alpha Trade Links' real GSTIN/FSSAI/registered address** still needed for
  Full Bill + Picker Bill letterheads (currently placeholder text).
- **`Alpha_Price_List_Aug_20.xlsx`** — the user has a new catalogue file with GST%/HSN
  added, but **333 of 844 products have ALL pricing fields blank** (MRP/RTP/WSP/Base/
  Buy/Free/Net all empty) — only name/GST%/HSN filled in for those. **DO NOT let the
  user upload this via Admin's Excel upload yet** — that upload REPLACES the entire
  catalogue, so it would wipe live pricing for a third of the products immediately.
  User's plan: fill in the missing prices "in future." Re-check the file the same way
  (open it, check for blank price columns) before giving the go-ahead to upload,
  whenever the user says it's ready.

## Latest zip
`alpha-trade-links-v9-full-bill.zip` — cumulative, includes the other session's work
(two billing logins, admin overview tabs, consolidated push, billing-edit push,
cancellation flow, customer merge) PLUS this session's Full Bill feature, PLUS the
`send-announcement-push` dead-code cleanup. The app code in this zip is accurate and
up to date — the schema drift problem above was purely a live-database issue, not a
zip/code issue.

## SQL files — status as of this handover
**Confirmed present in the live database** (via the audit above): all `order_items`,
`orders`, `products` columns the app currently queries, including the ones added THIS
session (`mrp`, `gst_percent`, `hsn`, `free_qty`, `price_type` on `order_items`; `gst`,
`hsn` on `products`).

**Not exhaustively re-verified this session, but working in practice:** the push
notification pipeline (`app_settings`, `push_subscriptions`, `deliveries`/
`announcements` triggers) — confirmed via live user testing, not a schema audit.

**If Billing, QC, Delivery, Admin, or push notifications throw a `42703` "column does
not exist" error again:** do NOT guess which file to run. Build a targeted audit query
like the one at the top of this doc (list every column the failing feature's code
actually selects — grep `cloudSync.js` for the `.select(...)` call), run it, and only
then run the specific missing-column SQL.

## Working style that works well here
- PHASE big features (don't build everything at once — it causes debugging spirals).
- Build in sandbox, verify build compiles, package cumulative zip, present_files.
- Flag SQL that must run before deploying — AND verify it actually ran when a bug
  suggests otherwise, using an audit query rather than guessing column-by-column.
- For risky data changes (like Excel catalogue replace): preview first, check for
  data-loss patterns (e.g. blank pricing) before green-lighting an upload.
- Be honest about scope and tradeoffs; test at mobile + desktop widths.
- The user is non-technical — walk through Windows/PowerShell/Supabase-dashboard steps
  one command at a time. They can't always attach screenshots — be ready to work from
  pasted text (SQL results, console errors) instead.
