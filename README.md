# Alpha Trade Links — WhatsApp Order App

A fast, offline-capable Progressive Web App (PWA) for FMCG sales reps. Pick a customer, tap quantities on products, and fire off a fully-formatted order to WhatsApp — the whole flow takes under a minute.

- **No backend, no login, no server.** Everything runs in the browser.
- Data (products, customers, settings) is stored locally using **IndexedDB + localStorage**.
- Orders are always delivered to the business WhatsApp number **+91 90749 93560** (hardcoded).
- Ships pre-loaded with your product and customer lists — works the moment it opens.

---

## Tech Stack

- React 18 + Vite
- Tailwind CSS
- IndexedDB (large data) + localStorage (settings)
- `vite-plugin-pwa` for installability + offline support
- `xlsx` (SheetJS) for Excel import/export

---

## Run Locally

Requires **Node.js 18+**.

```bash
npm install
npm run dev
```

Open the printed local URL (e.g. http://localhost:5173) on your phone or desktop.

## Build for Production

```bash
npm run build      # outputs to dist/
npm run preview    # preview the production build locally
```

---

## Deploy to Netlify

### Option A — Connect your GitHub repo (recommended)

1. Push this project to a GitHub repository.
2. In Netlify, choose **Add new site → Import an existing project** and pick the repo.
3. Netlify auto-detects the settings from `netlify.toml`:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`
4. Deploy. Netlify gives you an HTTPS URL — required for PWA install.

### Option B — Drag & drop

1. Run `npm run build`.
2. Drag the generated `dist/` folder onto the Netlify dashboard.

The included `netlify.toml` and `public/_redirects` handle SPA routing.

---

## Push to GitHub

```bash
git init
git add .
git commit -m "Alpha Trade Links order app"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

---

## Install on a Phone (PWA)

1. Open the deployed HTTPS site in Chrome (Android) or Safari (iOS).
2. **Android:** tap the menu → *Add to Home screen* / *Install app*.
3. **iOS:** tap Share → *Add to Home Screen*.

Once installed it launches full-screen and works offline.

---

## Using the App

1. **First launch** — enter your Business Name (and optional salesperson name).
2. **Select customer** — search by shop name; add a new one if it isn't listed.
3. **Add products** — search, then tap `+ / −` or type quantities.
4. **Send order** — tap the green **SEND ORDER** button. WhatsApp opens with the message pre-filled; just tap Send.

### Order message format

```
🛒 *NEW ORDER*

Customer:
ABC Stores

Items:

• Veeba Tomato Ketchup × 5
• Cornix Popcorn × 12

Total Products: 2
Total Quantity: 17

Thank you.
```

---

## Managing Data (Settings)

- **Import Products / Customers** from Excel. Replaces existing data.
  - Products file: a column named `ItemName` (also accepts `Product Name` / `Name`).
  - Customers file: a `Name` column (also accepts `Shop Name`) and optional `RouteName` / `Area`, `Owner`, `Phone`.
- **Export** products/customers back to Excel.
- **Export / Import Complete Backup** as a single JSON file.
- **Clear All Data** wipes local storage.

---

## Project Structure

```
src/
  assets/        Logo
  components/    Reusable UI (cards, stepper, pickers, icons)
  context/       Global state (AppContext)
  data/          Bundled seed products.json & customers.json
  hooks/         useSearch, useDebounce
  pages/         SetupScreen, OrderPage, SettingsPage
  utils/         db (IndexedDB), excel (import/export), whatsapp (message builder)
```

---

## Notes

- The delivery WhatsApp number is fixed in `src/utils/whatsapp.js` (`ORDER_WHATSAPP_NUMBER`). Change it there if needed.
- Seed data lives in `src/data/`. Replacing it via **Settings → Import** overrides the seed permanently on that device.
