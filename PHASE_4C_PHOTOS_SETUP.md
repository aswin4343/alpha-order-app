# Alpha Trade Links V4 — Phase 4C (part 1): Proof-of-Delivery Photos

Delivery reps capture a bill photo and a product photo (camera), which upload
to Supabase Storage and appear as secure links in the delivery report.

---

## STEP 1 — Create the Storage bucket (one-time)

1. Supabase dashboard → **Storage** (left sidebar) → **New bucket**.
2. Name it EXACTLY: **delivery-photos**
3. Turn **Public bucket ON**.
4. Create it.

(Public = the photo links open instantly when pasted in WhatsApp. The links are
long random strings that can't be guessed.)

## STEP 2 — Run the SQL (one-time)

Supabase → SQL Editor → New query → paste `supabase_v4_phase4c_photos.sql` → Run.
This adds the photo table, upload permissions, and the 40-day auto-cleanup.

Optional but recommended for auto-cleanup: Database → Extensions → enable
**pg_cron**. Then re-run the SQL so the daily cleanup schedules itself. If you
skip this, photos still work — they just won't auto-delete (you can run
`select public.cleanup_old_delivery_photos();` manually anytime).

## STEP 3 — Deploy

Upload `v3app` to GitHub, commit, let Netlify publish.

## STEP 4 — Test (on a real phone — camera can't be tested on desktop)

1. Log in as a delivery rep (e.g. `auto`) with an assigned delivery.
2. Tap the delivery → tick items → scroll to **Proof photos**.
3. Tap **Bill Photo** → the phone camera opens → take a photo. It uploads and
   shows a thumbnail. Do the same for **Product Photo** (at least one required).
4. Tap **Complete Delivery**. The report now includes **Proof Photos** links.
5. Tap **Copy Report** → paste into WhatsApp. The photo links open the images.

---

## Notes

- **At least one photo** (bill or product) is required to complete a delivery.
- Photos are compressed on the phone (~250 KB) before upload — fast and
  storage-friendly.
- Photos auto-delete after **40 days** (keeps you within the free storage tier).
- **First real test is on a phone** — camera capture and uploads can't be tested
  on desktop. If a photo fails to upload, check: bucket named exactly
  `delivery-photos`, bucket is Public, and the SQL ran without errors.
- **Next (Phase 4C part 2):** the smart customer-location system — auto-capture
  each shop's GPS on delivery, store it, and flag mismatches on future visits.
