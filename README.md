# Canine Keepsakes — Custom Site

Static HTML/CSS/JS storefront (no build step) + Netlify Functions for checkout.
Route decided 2026-06-12: custom site + Printful "Manual order / API" store + PayPal. See `Handoffs/2026-06-12_CK_Site_Handoff.md`.

## Structure
```
ck-site/
├── index.html          home — hero + 21-collection grid
├── collection.html     ?c=slug — designs + 13 product cards
├── product.html        ?c=&p=&d= — design / colour / size pickers
├── basket.html         localStorage basket
├── checkout.html       delivery form + shipping rates + PayPal Smart Buttons
├── css/style.css       premium gift-shop theme (Fraunces + Outfit)
├── js/store.js         catalog loader, basket, shared header/footer
├── data/
│   ├── designs.json    21 collections × 415 Drive design file IDs
│   ├── products.json   13 UK-available product types (prices, colours, sizes)
│   └── catalog.json    generated merge — the file pages actually load
└── netlify/functions/  shipping-rates, create-order, capture-order (+ _lib)
```

## Deploy (Netlify)
1. Drag the `ck-site` folder into Netlify, or `netlify deploy` from this dir.
2. Set env vars: `PRINTFUL_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (`sandbox` first).
3. In `checkout.html`, uncomment the PayPal SDK `<script>` and insert the client ID.

## Oliver's jobs (before checkout goes live)
1. Printful dashboard → new store → type **Manual order / API** → generate API key.
2. PayPal Business → developer.paypal.com → REST app → client ID + secret.
3. Make the Drive "Finished Designs" folder **link-shared (anyone with link, viewer)** — thumbnails and print-file URLs depend on it. (Open question: move print files to Netlify hosting instead.)

## Known state / open items
- **Breed labels**: Drive design filenames are UUIDs — breeds shown as "Design N" until a labelling pass. UI is thumbnail-led so this is cosmetic, not blocking.
- **Counts**: Hog Dogs 18, Dog Eastwood 19, Redneck 19, **Work Like A Dog 19** (new finding — handoff only listed the first three). World Cup Dogs has no Drive folder; excluded.
- **Sizes** in `products.json` are standard ranges — verify against live Printful variants once the API key exists (capture-order resolves real variant IDs at order time and falls back colour-only).
- **Orders are created as Printful DRAFTS** (`confirm: false`) — confirm manually in dashboard.
- **Mockups**: product imagery currently shows raw design art; the mockup pipeline (printful.js + Sharp left-chest 35%/8%/5%, 50s batch delay, 429 retry ×3/60s) is the next build task.
- Catalog regen: edit `data/designs.json` / `data/products.json`, then re-run the merge script (see session notes) or ask Claude to regenerate `catalog.json`.

## Local preview
Any static server from this folder, e.g. `python3 -m http.server 8080` → http://localhost:8080
(Functions need `netlify dev` + env vars.)
