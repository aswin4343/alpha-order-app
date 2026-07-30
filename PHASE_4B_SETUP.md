# Alpha Trade Links V4 — Phase 4B (Delivery Execution)

The delivery rep's actual job: open a delivery, tick off products, capture
reasons for anything not delivered, complete it, and copy a WhatsApp report.

---

## STEP 1 — Run the SQL (one-time)

Supabase → SQL Editor → New query → paste `supabase_v4_phase4b.sql` → Run.
(Adds the per-product `delivery_items` table + completion columns.)

---

## STEP 2 — Deploy

Upload `v3app` contents to GitHub, commit, let Netlify publish.

---

## STEP 3 — Test

1. **Log in as a delivery rep** (e.g. `auto`) who has an assigned delivery.
2. **Tap the delivery** → you see its product checklist (pulled from the order).
3. **Tick delivered items.** For anything left unticked, a **reason dropdown**
   appears (Shop Closed, Customer Not Available, …, or Other → free text).
4. Optionally add a **note**.
5. Tap **Complete Delivery**. Status is auto-set:
   - all ticked → Delivered
   - some → Partial
   - none → Not Delivered
6. A **copyable report** appears. Tap **Copy Report**, then paste it into
   WhatsApp to the office.
7. **Log in as delivery admin** → the delivery's status now reflects the result
   (Delivered / Partial / Failed).

---

## Notes

- Reasons are required for any undelivered item before completion is allowed.
- The report is a text template you paste into WhatsApp. **Photos** (attached
  separately) come in Phase 4C, which adds camera proof-of-delivery, secure
  photo links, GPS capture, and the smart customer-location system.
- A delivery rep can only see and act on deliveries assigned to them (enforced
  by the database).
