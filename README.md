# Alpha Trade Links — Booking App v2.0

Fast, offline-capable PWA for FMCG sales reps. Select customer → add products → send a formatted order to WhatsApp.

## What's new in v2

| Feature | Detail |
|---|---|
| WhatsApp number | Orders now go to **+91 97470 76361** |
| Route name | Included in every order message |
| Brand selector | ALPHA TRADE LINKS / ZEDGO — changes only the message header |
| Scheme engine | Buy X Get Y Free badges from `schemes_updated.xlsx` |
| Pricing | Base Rate + live Net Rate (rep-only, never shown to customers) |
| Quantity type | Piece / Box selector per product |
| Customer categories | 15 categories from `Customer_Category.xlsx` |
| Duplicate fix | 8,648 rows → 900 unique customers |
| New customer module | Name, Area, Route, Category, GSTN, Phone, Email + validation |
| Returns module | Credit notes with multiple products, MRP, reason |
| Auto-reset | Order clears when a new customer is selected |
| Copy Order | Paste into WhatsApp Business manually |
| Clear Data | Removed, as requested |
| App icon | Updated |

## Scheme rules (exact)

Each row in the scheme file is an independent slab. The engine:

1. Finds all slabs where `qty >= slabBuy`
2. Uses **only the highest qualifying slab**
3. Applies `Free = FLOOR(qty / slabBuy) × slabFree`
4. Never combines slabs; leftover quantity earns nothing

Example — slabs 6→1 and 12→3:

| Qty | Free |
|---|---|
| 5 | 0 |
| 6–11 | 1 |
| 12–23 | 3 |
| 24–35 | 6 |
| 36 | 9 |

Net rate = `base × buy ÷ (buy + free)`.

## Run locally

Requires Node 18+.

```bash
npm install
npm run dev
```

## Deploy

```bash
npm run build   # outputs to dist/
```

Push to GitHub, then import in Netlify. `netlify.toml` sets build command `npm run build` and publish directory `dist`.

## Data

Bundled and loaded into IndexedDB on first launch:

- `src/data/products.json` — 845 products (744 master + 49 scheme-only + 52 price-list-only)
- `src/data/customers.json` — 900 unique customers with routes
- `src/data/categories.json` — 15 customer categories

Replace via **Settings → Import** at any time.

## Notes

- Delivery number is fixed in `src/utils/whatsapp.js` (`ORDER_WHATSAPP_NUMBER`)
- Pricing: 241 products have RP/WP from `Price_list.xlsx`; 78 scheme products show
  BR/NR. Remaining 526 products show no price tag until the rest of the price list
  arrives. To update, replace `src/data/products.json` (fields: `retail`, `wholesale`).
- Product brand labels were removed from messages — the auto-detected groupings in
  `updated_product_list.xlsx` proved unreliable. Supply a Brand column to reinstate.
- Phase 2 (planned): Supabase cloud sync, shared team password, order history.
