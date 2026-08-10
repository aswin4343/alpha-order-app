# ATL Flow — Add-on Setup: Sales-Rep Announcement Push

This adds **phone push notifications for sales reps** when Admin posts a product
update (price/scheme/new/removed). It reuses everything you already set up for
QC push (same VAPID keys, same secret) — so this is short.

Do these 3 steps in order.

---

## Step 1 — Deploy the new Edge Function

Open PowerShell in your `v3app` folder (same as last time) and run
(adjust the path to `supabase.exe` if needed):

```
C:\Users\2000b\Downloads\supabase_2.113.0_windows_amd64\supabase.exe functions deploy send-announcement-push --no-verify-jwt
```

Wait for **"Deployed Functions on project ... : send-announcement-push"**.

> No need to set secrets again — this function reuses the VAPID keys and
> QC_PUSH_SECRET you already set.

---

## Step 2 — Run the SQL

Supabase → SQL Editor → New query → paste the contents of
**`supabase_v6_announcement_push.sql`** → Run.

---

## Step 3 — Point the trigger at the function

Supabase → SQL Editor → run this (the URL is your project's standard function URL):

```sql
update public.app_settings
set announcement_push_function_url =
    'https://nkbawdgxllsyktwppnhn.supabase.co/functions/v1/send-announcement-push'
where id = 1;
```

Confirm:

```sql
select qc_push_function_url, announcement_push_function_url from public.app_settings where id = 1;
```

Both URLs should be filled in.

---

## Step 4 — Deploy the app

Upload the `v3app` contents to GitHub as usual → Netlify rebuilds.

---

## How reps turn it on

Each sales rep, once per device:
1. Open the app, sign in.
2. On the order screen, tap **Enable** on the blue "Turn on notifications" banner → Allow.
   (iPhone: Add to Home Screen first, then open from that icon.)

After that, whenever Admin uploads an Excel with changes, every subscribed rep
gets the product-update announcement as a phone notification — and tapping it
opens their Announcements screen. The 3-day expiry still applies to the in-app
copy; the push itself is a one-time delivery.

---

## Quick test

1. Rep device: enable notifications (above), then close the app.
2. Admin: upload an Excel with a price change (or post any announcement).
3. Rep device should get a **Product Update** push.

If nothing arrives: Supabase → Edge Functions → `send-announcement-push` → Logs.
`sent: 0` means no rep has tapped Enable yet on that device.

## Kill switch (disables rep push without touching anything else)

```sql
update public.app_settings set announcement_push_function_url = null where id = 1;
```
