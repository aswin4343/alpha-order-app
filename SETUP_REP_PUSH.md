# Sales-Rep External Push — Setup (v6 addition)

You already set up QC push (function deployed, secrets set, app_settings filled).
This adds **external push for sales reps** when a product/price announcement is
posted. It reuses everything you already configured — no new keys, no new tables.

There are just **2 steps**, then deploy the app.

---

## STEP 1 — Redeploy the push function (it now handles announcements too)

The `send-qc-push` function was updated to send BOTH kinds of push (QC alerts
AND sales-rep announcements). Redeploy it so the new version is live.

Open PowerShell, go to the v3app folder, and run (adjust paths to where things are):

```
cd "C:\Users\2000b\Downloads\<the v6 folder>\v3app"
```
```
C:\Users\2000b\Downloads\supabase_2.113.0_windows_amd64\supabase.exe functions deploy send-qc-push --no-verify-jwt
```

Pick your project (`nkbawdgxllsyktwppnhn`) when asked. Wait for
**"Deployed Functions on project ... send-qc-push"**.

> Nothing else in PowerShell is needed — your secrets and login are already saved.

---

## STEP 2 — Run one SQL file (adds the announcement→push trigger)

In Supabase → SQL Editor → New query → paste the contents of:

**`supabase_v6_rep_announcement_push.sql`**

→ Run. It should say **Success**.

That's the whole backend. (It pushes to salespeople whenever an 'all'-audience
announcement is created — including the automatic product-update announcements
from an Excel upload.)

---

## STEP 3 — Deploy the app (your normal flow)

Upload the `v3app` contents to GitHub → Netlify rebuilds → open
**sales.alphatradelinks.com** in incognito.

---

## HOW TO TEST

1. On a sales rep's phone, open **sales.alphatradelinks.com**, sign in as a rep.
   - iPhone: Add to Home Screen first, open from that icon.
2. On the order screen, tap **Enable** on the blue "Turn on notifications" banner
   → Allow.
3. Close the app completely.
4. As Admin, upload an Excel with a price/scheme change (or send any announcement
   to "all").
5. The rep's device should get an external push: **📢 Product Update** — tapping
   it opens the announcements screen.

If nothing arrives: check Supabase → Edge Functions → send-qc-push → Logs.
`sent: 0, no salesperson subscriptions` means no rep has tapped Enable yet.

---

## WHAT DIDN'T CHANGE

- QC push works exactly as before (same function, now with an extra branch).
- All existing SQL, tables, and the app_settings config are untouched.
- If you ever want to stop ALL pushes instantly:
  `update public.app_settings set qc_push_function_url = null where id = 1;`
