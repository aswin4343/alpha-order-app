# Alpha Flow v227 — Price revisions & shop-specific approval persistence

**Rule:** One Product + One Shop + One Master Price Revision + One Approved Price = One reusable approval.

## Deploy order (important)
1. Supabase SQL editor → run `sql/74_price_revisions_shop_approvals.sql`.
   It checks the live schema first and aborts with a clear message (changing nothing) if a column is missing.
2. Run `sql/74_verify.sql` → every row must show `ok = true`.
3. Build `src/` (`npm run build`) and deploy `dist/` to Netlify.

If the app is deployed before the migration: Merge still works (legacy path), Replace All is refused with a message, and no approvals are remembered.
To undo: `sql/74_rollback.sql` (removes triggers/functions, keeps all history).

## Database (migration 74 — additive only)
- `product_price_revisions` — permanent price history; a row is created only when retail or wholesale really changes (to the paisa).
- `shop_price_approvals` — permanent approvals; unique on (product, customer, revision, price).
- `products.current_price_revision_id`, `order_items.product_id`, `order_items.price_revision_id`.
- Trigger `products_price_revision` — the database owns price revisions; client values are ignored.
- Trigger `order_items_price_guard` — for sales reps, any line below the customer's default price without a valid shop approval is forced to `pending`.
- Trigger `order_items_record_approval` — every Admin approval (item-level or whole bill) is recorded; a later rejection revokes it.
- Function `import_products_catalogue(mode, rows, file)` — Excel Replace All / Merge as one transaction.
- Existing approvals are not carried over (they lack a reliable revision): each shop/product needs one fresh approval.

## App files
| File | Change |
|---|---|
| `utils/priceApproval.js` (new) | Paise-exact comparison, shop approval lookup, Last Price validity, default-price rule |
| `utils/catalogueImport.js` (new) | Replace/Merge payload builders (merge rules unchanged) |
| `utils/cloudSync.js` | Uploads via the atomic RPC; `loadShopPriceApprovals`; Last Price skips pending/rejected lines; `product_id` saved on lines; global product-level approval removed |
| `pages/OrderPage.jsx` | One approval source; old-revision Last Price hidden; `checkViolations` uses shop approvals |
| `components/ProductCard.jsx` | "✓ Approved ₹x" chip; all approval checks use the shop approval list |
| `components/AddOnFlowModal.jsx` | Same rules for add-ons |
| `context/AppContext.jsx` | Catalogue re-checked when the app returns to foreground / every 10 min |
| `pages/ProductAdminPage.jsx` | Upload result lists products that got a new price revision |
| `main.jsx` | Build label v227 |

## Tests (`tests/`)
- `tests/db/` — mirror schema + 44 scenario checks (`psql -f 00_mirror_schema.sql`, seed, migrate, `psql -f 10_scenarios.sql`).
- `tests/js/` — helper unit tests (21) and Excel → parser → builder → database import tests (16).
