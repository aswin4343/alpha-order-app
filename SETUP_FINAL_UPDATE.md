# Alpha Trade Links — Final Update: Setup & Deploy Guide

This release adds **3 features**. Two are pure app + SQL (easy). The third (QC
external push) needs a one-time Supabase **Edge Function** deploy — new for this
project, but it's just copy-paste commands, laid out below.

Do the steps **in order**. SQL first, then the Edge Function, then deploy the app.

---

## PART A — SQL (run in Supabase → SQL Editor)

Run these **in this order**. All are additive and safe (no data deleted).

1. `supabase_v4_announcement_expiry.sql` — adds 3-day expiry to admin announcements.
2. `supabase_v4_qc_push.sql` — push subscriptions table + the delivery→push trigger.

> Feature 1 (My Performance route filter) needs **no SQL** — orders/visits already
> store a `route` column.

After step 2, run this to confirm the new tables exist:

```sql
select 'push_subscriptions' as t, count(*) from public.push_subscriptions
union all select 'app_settings', count(*) from public.app_settings;
```

---

## PART B — QC External Push (Edge Function)

This is what makes QC alerts arrive when the **app is closed**.

### B1. Install the Supabase CLI (one time, on your computer)

- Windows (PowerShell):  `scoop install supabase`  *(or download from https://github.com/supabase/cli/releases)*
- Mac:  `brew install supabase/tap/supabase`

Then log in and link the project:

```bash
supabase login
supabase link --project-ref nkbawdgxllsyktwppnhn
```

### B2. Set the function secrets (VAPID keys + shared secret)

The VAPID keypair below was generated for this app. The **public** key is already
baked into the app; the **private** key must ONLY live here as a secret.

```bash
supabase secrets set \
  VAPID_PUBLIC_KEY="BKuLlftaYk3AOuZUmloHuTCcwsLTGMcA4fKRGbxktfIVWoZeG3rVvBZb2JGoRuDY_ueEMFoOWh1QxLe81hhSHZQ" \
  VAPID_PRIVATE_KEY="0t4MEjGvsNjAiiJQPKp6ndzazzdpmF2JI-zJ9ttYlOs" \
  VAPID_SUBJECT="mailto:admin@alphatradelinks.app" \
  QC_PUSH_SECRET="CHOOSE_A_LONG_RANDOM_STRING_HERE"
```

> Replace `CHOOSE_A_LONG_RANDOM_STRING_HERE` with any long random string. You'll
> paste the **same** string into `app_settings` in step B4.

### B3. Deploy the function

From the `v3app` folder (the one containing the `supabase/` directory):

```bash
supabase functions deploy send-qc-push --no-verify-jwt
```

`--no-verify-jwt` is required: the database trigger calls this function without a
user JWT. It's protected instead by the `QC_PUSH_SECRET` header.

The deploy prints the function URL, e.g.:
`https://nkbawdgxllsyktwppnhn.supabase.co/functions/v1/send-qc-push`

### B4. Point the DB trigger at the function (Supabase → SQL Editor)

Paste the **same** secret from B2 and the function URL from B3:

```sql
update public.app_settings
set qc_push_function_url = 'https://nkbawdgxllsyktwppnhn.supabase.co/functions/v1/send-qc-push',
    qc_push_secret = 'CHOOSE_A_LONG_RANDOM_STRING_HERE'   -- must match B2
where id = 1;
```

That's it — the pipeline is live: **Billing verifies → delivery row inserted →
trigger calls the function → push sent to all QC devices.**

---

## PART C — Deploy the app (your usual flow)

1. Upload the contents of the `v3app` folder to GitHub (repo `alpha-order-app`).
2. Netlify auto-rebuilds.
3. Test in **incognito**.

---

## HOW QC STAFF TURN ON NOTIFICATIONS

Each QC person, on each device, once:

1. Open the app, sign in as QC.
2. On the QC dashboard, tap **Enable** on the blue "Turn on QC alerts" banner.
3. Allow notifications when the browser asks.

**iPhone note:** iOS only allows web push for **installed** PWAs. The QC user must
first tap Share → **Add to Home Screen**, open the app *from the home screen icon*,
then Enable. (Android/desktop Chrome work without installing.)

---

## HOW TO TEST EACH FEATURE

**1. My Performance route filter**
- Log in as a sales rep → My Performance → pick a Route from the dropdown.
- Numbers should filter to that route; "All routes" restores the original totals.
- Date + Route together should both apply.

**2. Excel product update → auto-announcement**
- Admin → Product Management → upload an Excel where you changed a price / scheme /
  added / removed a product.
- The confirm dialog now lists the **detected changes**.
- Confirm → sales reps get ONE announcement (the exact wording per change type),
  which auto-expires after 3 days.
- Upload the **same** file again → "No product changes detected" → no announcement.

**3. QC external push**
- QC device: Enable alerts (above).
- Close the app entirely (or background it).
- As Billing, verify any bill.
- The QC device should get: **🔔 New Quality Check Required** with Shop, Bill No,
  Verified By. Tapping it opens that exact QC task.

If a push doesn't arrive, check Supabase → Edge Functions → `send-qc-push` → Logs.
`sent: 0` means no QC device has subscribed yet (do the Enable step).

---

## ROLLBACK / SAFETY

- All SQL is additive; nothing is dropped or deleted.
- Existing manual announcements have `expires_at = NULL` → they never expire.
- If the Edge Function/trigger misbehaves, disable push instantly without touching
  billing:  `update public.app_settings set qc_push_function_url = null where id = 1;`
  (Billing verification is wrapped so a push failure can never block it anyway.)
