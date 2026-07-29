# Alpha Trade Links V3 — Announcements (in-app notifications)

Admin sends announcements to all or selected reps; reps see them with a bell
icon, unread badge, history, and read/unread status.

---

## STEP 1 — Create the tables (one-time SQL)

Supabase → SQL Editor → New query → paste `supabase_announcements.sql` → Run.

---

## STEP 2 — Deploy

Upload the `v3app` contents to GitHub, commit, let Netlify publish.

---

## STEP 3 — Test

**As admin:**
1. Dashboard → **📢 Send Announcement**.
2. Type a title (e.g. "New Offer") and message.
3. Choose **All reps** or **Selected reps**; optionally tick **High priority**.
4. Send. It appears in the "Sent" list with a "Read by 0/N" counter.

**As a rep (log in as anjali):**
1. The bell icon (top bar) shows a red unread badge.
2. Tap it → the announcement is there, high-priority ones marked 🔴.
3. Opening the list marks them read; the badge clears.
4. Back as admin, the "Read by" counter goes up.

---

## Notes

- Announcements appear **inside the app** — reps see them (and the bell badge)
  whenever they open the app. This is reliable on every phone with no
  permission prompts. (True phone push — pop-up when the app is closed — is a
  separate future project; it needs the app installed on each phone and only
  works on some devices.)
- "Read by X/N" lets you see how many reps have seen each announcement.
- **Remaining V3 item:** Targets — on hold until products have prices, since
  ₹ sales targets need product prices to compute sales value.
