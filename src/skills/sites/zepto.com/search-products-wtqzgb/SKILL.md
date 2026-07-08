---
name: search-products
title: Zepto Product Search
description: >-
  Search Zepto for products matching a query at a given Indian delivery
  location, returning in-stock items with name, brand, pack size, price, MRP,
  discount, rating, review count, stock state, ETA, product URL, and image URL.
  Read-only.
website: zepto.com
category: quick-commerce
tags:
  - grocery
  - india
  - quick-commerce
  - search
  - read-only
source: 'browserbase: agent-runtime 2026-05-19'
updated: '2026-05-19'
recommended_method: browser
alternative_methods: []
verified: true
proxies: true
---

# Zepto Product Search

## Purpose

Given a free-text product query and an Indian delivery location (street/area/landmark name or pincode), return the best-matching in-stock products listed on Zepto for that location's delivery store — with product name, brand, pack size/variant, current price, MRP, discount, rating, review count, in-stock status, per-card delivery ETA, canonical product URL, and image URL. Read-only — never clicks ADD, never proceeds toward cart/checkout.

## When to Use

- "What's the price of Amul butter / Maggi noodles / Cadbury Dairy Milk on Zepto in Koramangala?"
- "Find the cheapest 1 L milk available for delivery in Bandra right now."
- Price-monitoring scrapes that need MRP + discount + per-store availability.
- Anywhere you need to know whether Zepto actually services a given Indian address before quoting a delivery ETA.

## Workflow

The Zepto web site at `www.zepto.com` is a Next.js SPA. The recommended path is **browser-driven** via `browserless_agent`, navigating directly to `https://www.zepto.com/search?query=<URL-encoded query>` and parsing product cards from a `snapshot`. A backing JSON API exists (`POST https://bff-gateway.zepto.com/user-search-service/api/v3/search`) but is gated by per-session secrets — see Site-Specific Gotchas; do not try to call it cold.

**Run the whole flow — location set → search → parse → paginate — inside ONE `browserless_agent` call's `commands` array.** Batching keeps it to the fewest round-trips and avoids accidentally dropping the session config. The session persists across separate calls, keyed by the call's `proxy`/`profile`, so cookies/session state (the selected delivery location) survive as long as follow-up calls carry the **same** `proxy` — drop or change it and you land in a different, blank session that has lost the location. There is no session to create or release. On every call pass `proxy: { proxy: "residential", proxyCountry: "in" }`: Zepto serves a CloudFront-fronted Next.js app that fingerprints aggressively, and the address-autocomplete + map widgets fail without a residential India-routable IP. (Historically we favored a Singapore egress for latency; a residential India IP is the correct control here and avoids IP-mismatch heuristics outright.)

1. **Set the delivery location BEFORE searching.** Zepto's IP-based default is unreliable (it picks an arbitrary metro and may resolve to a non-serviceable area), and price/availability/ETA all vary by `storeId`. The site uses Google-Places-style address autocomplete, not pincode entry — you type a free-text address and pick a suggestion. Sequence the location flow as the first commands in the array:

   ```json
   {
     "proxy": { "proxy": "residential", "proxyCountry": "in" },
     "commands": [
       {
         "method": "goto",
         "params": {
           "url": "https://www.zepto.com/",
           "waitUntil": "load",
           "timeout": 45000
         }
       },
       { "method": "waitForTimeout", "params": { "time": 2000 } },
       { "method": "snapshot" },
       {
         "method": "click",
         "params": { "selector": "button:has-text('Select Location')" }
       },
       { "method": "waitForTimeout", "params": { "time": 1500 } },
       {
         "method": "click",
         "params": { "selector": "input[placeholder*='Search a new address']" }
       },
       {
         "method": "type",
         "params": {
           "selector": "input[placeholder*='Search a new address']",
           "text": "Koramangala Bangalore"
         }
       },
       { "method": "waitForTimeout", "params": { "time": 2500 } },
       { "method": "snapshot" }
     ]
   }
   ```

   The `snapshot` after typing surfaces 5 suggestions under the textbox. Each suggestion is a container div whose children read:

   ```
   div
     StaticText: Koramangala
     StaticText: Koramangala, Bangalore, Karnataka, India
   ```

   Click the first matching suggestion's container (`{ "method": "click", "params": { "selector": "..." } }` — confirm the selector via the `snapshot` if the accessible text differs), then `{ "method": "waitForTimeout", "params": { "time": 3000 } }`. After the click, the modal closes, the page reloads, and the header switches from `button: Select Location` to `button: <Area Short Name>` plus a `heading: <N> minutes` ETA badge. **This is the success signal — do not search until you see that header heading.**

2. **Search via URL.** The query is a URL param; no need to click into the search box. Append these commands to the SAME call (the location set above persists within the session, so the new page header still shows the same area button and the same global ETA). URL-encode the query when building the string:

   ```json
   { "method": "goto", "params": { "url": "https://www.zepto.com/search?query=basmati%20rice", "waitUntil": "load", "timeout": 45000 } },
   { "method": "waitForTimeout", "params": { "time": 2500 } },
   { "method": "snapshot" }
   ```

3. **Branch on what the page shows.** Inspect the snapshot tree for one of five top-level patterns:

   | Pattern in `tree` text                                                       | Outcome                                                                                                                                  |
   | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
   | `heading: Showing results for "<q>"` followed by product `link:` rows        | **success** — parse results (step 5)                                                                                                     |
   | `heading: Could not find any products for "<q>"`                             | **no_results** — return empty array                                                                                                      |
   | `heading: Sit Tight! We're Coming Soon!` + `Our team is working tirelessly…` | **not_serviceable** — Zepto does not deliver to the selected location                                                                    |
   | `heading: Try Again in <N> Mins` (no products)                               | **store_offline** — local dark store currently closed; retry later                                                                       |
   | `heading: Try Again in <N> Mins` + product rows                              | **store_offline_but_browsable** — results still rendered for browsing but ordering is paused; rating/price valid, ETA NOT shown per-card |

4. **Parse each product card.** Every result is an `[X-Y] link: <inline summary>` whose `href` (in `urlMap`) points to `https://www.zepto.com/pn/<slug>/pvid/<uuid>`. The link's accessible name is a single concatenated string in this fixed order — extract via the nested `StaticText` children, NOT by regexing the link name (the accessible name omits some fields and concatenates without separators):

   - `image: <Product Name>` — accessible alt = product name. The actual image URL is in `urlMap[<image-ref>]` and looks like `https://cdn.zeptonow.com/production/ik-seo/tr:w-403,ar-...,pr-true,f-auto,q-40,dpr-2/cms/product_variant/<uuid>/<slug>.jpeg`.
   - `button: ADD` — present iff the product is currently in stock. **An out-of-stock card replaces this with a `Notify Me` button or omits the action entirely.** Always check for the literal `button: ADD` text on the card to decide `inStock`.
   - **OPTIONAL** `image: P3 - Ad.png` (or `P1 - …`, `P2 - …`) — sponsored/Premium ad slot. Treat the card normally but set `sponsored: true`.
   - `span` → `StaticText: ₹` + `StaticText: <integer>` — **discounted (current) selling price in ₹** (whole rupees, no decimals on the site).
   - **OPTIONAL** second `span` → `StaticText: ₹` + `StaticText: <integer>` — **MRP**. Present only when there is a discount. If absent, treat `mrp = sellingPrice` and `discount = 0`.
   - **OPTIONAL** `StaticText: ₹<N>` + `StaticText: OFF` — flat-amount discount badge. The percent can be derived as `(N / mrp) * 100`.
   - `StaticText: <Product Name>` — canonical product name (use this, not the `image:` alt — `image:` is sometimes truncated).
   - `StaticText: <pack-size>` — e.g. `1 pc (20.2 g)`, `1 pack (500 ml)`, `1 L`, `1 pack (5 kg)`. Free-form string; preserve verbatim.
   - **OPTIONAL** `StaticText: <variant>` — sub-variant label like `Milk Chocolate`, `Long Grain`, `Silk Oreo`, `Fruit & Nut`, `Premium`. Optional; may be absent on basics.
   - **OPTIONAL** rating block: `span` → `image` (star icon) + `StaticText: <rating>` (e.g. `4.6`, `5`) followed by `span` → `StaticText: (` + `StaticText: <count>` + `StaticText: )`. Review count uses K/M suffix (e.g. `274.5k`, `1.9k`, `855`, `125.4k`). Parse with `parseFloat(num) * (suffix === 'k' ? 1000 : suffix === 'm' ? 1e6 : 1)`. **Many cards have no rating block at all** — treat as `null`.
   - **OPTIONAL** `StaticText: <N> mins` — per-card delivery ETA, e.g. `9 mins`. Present only when the selected store is online (i.e. the global header reads `<N> minutes`, not `Try Again in <N> Mins`).
   - **OPTIONAL** trailing `StaticText: Bestseller` / `StaticText: New` — quality/recency tags.

   **Brand is not a separate field on the card.** Zepto inlines the brand into the product name (e.g. `Cadbury Dairy Milk Chocolate Bar Cricket Pack`, `Nandini Goodlife Toned UHT Milk`, `Nestle Kitkat 4 Fingers …`). Extract by matching the first word(s) of the product name against a known-brand list, OR — preferred for accuracy — open the product detail page (PDP) at the card's `/pn/<slug>/pvid/<uuid>` URL; the PDP returns the brand as a structured field. Only do PDP fetches for the top-N results the caller actually cares about; doing it for every card on a 263-result query is wasteful.

5. **Pagination.** Results render as a vertical-feed grid of `PRODUCT_GRID` widgets (3 cards per row, ~30 cards per page). To fetch more, append scroll+wait+snapshot commands to the same call and dedupe by `pvid` UUID:

   ```json
   { "method": "scroll", "params": { "direction": "down" } },
   { "method": "waitForTimeout", "params": { "time": 1500 } },
   { "method": "snapshot" }
   ```

   Repeat the scroll/wait/snapshot triple to append more batches. The site lazily loads more grids — there's no "Next page" button. Sponsored ad cards are interleaved between organic grids; tag them with `sponsored: true` (presence of `P3 - Ad.png` / `Sponsored` label) and exclude or rank lower depending on caller intent.

No session-release step is needed — there's nothing to release, and the session persists across separate calls, keyed by the call's `proxy`/`profile`. Batch the entire location → search → parse → paginate flow inside one call's `commands` array (or repeat the same `proxy` on follow-up calls) so the selected delivery location persists throughout.

### API path (DO NOT use cold)

Zepto's web app calls `POST https://bff-gateway.zepto.com/user-search-service/api/v3/search` with body `{"query":"<q>","pageNumber":0,"mode":"SHOW_ALL_RESULTS","userSessionId":"<uuid>"}`. The response is a clean JSON layout with `productResponse` blocks containing `product.brand`, `productVariant.formattedPacksize`, `productVariant.ratingSummary.{averageRating,totalRatings}`, `discountedSellingPrice` (paise — divide by 100 to get ₹), `mrp` (paise), `outOfStock`, etc. — far richer than the rendered card. **However**, the request requires ~30 headers including `x-csrf-secret`, `x-xsrf-token`, `request-signature` (SHA hash of body + secret), `storeId`/`store_ids` (derived from the selected delivery location), `deviceId`, `sessionId`, and a 1.5KB `compatible_components` feature-flag string. The signature is rotated per request and validated server-side. We attempted to replay a captured request out-of-band; verified blocked. The only viable use of the API is in-page via an evaluate after the same session has set its location, which is strictly more expensive than parsing the rendered DOM. Don't waste time on cold API calls.

## Site-Specific Gotchas

- **Location must be set BEFORE searching, not after.** Without an explicit location, Zepto picks a metro from the request IP. Through a residential proxy this typically resolves to a sane Indian metro, but the specific dark-store assignment is non-deterministic across runs — price, availability, and ETA all vary. Always run the address-autocomplete flow (step 1) first and verify the header reads `<N> minutes` before issuing search queries.
- **No pincode field — the picker is Google-Places autocomplete.** Don't try to enter a 6-digit pincode directly; it won't typeahead. Type the area name + city (e.g. `Bandra West Mumbai`, `Koramangala Bangalore`, `Sector 18 Noida`) and click the first suggestion. The textbox accepts free-form English; Hindi script also works but English is the safer canonicalization.
- **The Select Location button click does NOT visibly open a modal in the snapshot's first 200 lines** — the modal renders far down the tree (search `tree` text for the literal string `Your Location`). When verifying the modal opened, look for `textbox: Search a new address`, not for a top-of-tree dialog. The xpathMap puts the modal inside `body/div[2]/div[2]/...` while the rest of the page lives in `body/div[2]/div[1]/...`.
- **Picking a suggestion is a single click — no Confirm button.** Some quick-commerce sites require a follow-up "Confirm address" tap. Zepto does not. The modal closes on first click of any suggestion-row container div.
- **Five distinct page states for the same `/search?query=` URL.** Always branch on the top-level `heading:` text before parsing cards. `Showing results for "<q>"`, `Could not find any products for "<q>"`, `Sit Tight! We're Coming Soon!`, `Try Again in <N> Mins` (alone), and `Try Again in <N> Mins` + products — each requires different handling. Defaulting to "parse all `link:` rows under banner" without checking the heading yields silent garbage on the not-serviceable and offline-store branches.
- **`Try Again in <N> Mins` is per-store, not global.** A given location's dark store can be offline temporarily (curfew hours, restocking, weather). Other locations the same minute may show `9 minutes` fine. If `Try Again in N` shows with no product rows, the only fix is changing location or waiting; retrying immediately will not help.
- **Brand is not a discrete field on cards.** The accessibility tree exposes a flat product-name string. The first-word brand heuristic works for ~80% of cases (`Cadbury`, `Nestle`, `Amul`, `Nandini`, `Daawat`, `Hocco`, `Tata`) but breaks for multi-word brands (`Mother Dairy`, `Pure Temptation`, `Bb Royal`, `B Natural`). For accurate brand extraction, hit the PDP at `/pn/<slug>/pvid/<uuid>` — the PDP page title format is `Buy <Product Name> Online - Price @ ₹<N> | Instant Delivery | Zepto` and the breadcrumb under the buy box gives `Home > <L2 Category> > <L3 Category>`. The cleanest brand source is the API's `productResponse.product.brand` field; if you can extract it from an in-page XHR you've already paid for, do that instead of a second PDP roundtrip.
- **Prices on the rendered card are whole rupees with no decimals.** The backing API uses paise (`discountedSellingPrice: 1800` = ₹18.00). Don't confuse the two: if you scrape the card, you have ₹; if you scrape an XHR response, divide by 100.
- **Rating block is often absent.** Roughly half of cards lack a star + review-count block (new SKUs, low-volume categories). Treat missing as `null`, not 0.
- **`P3 - Ad.png` / `P1 - …` / `P2 - …` marks sponsored cards.** They are real products but are paid placements. Set `sponsored: true` and consider de-ranking them when computing "best match".
- **Review counts use Indian-style K suffix, not commas.** `274.5k` = 274,500. `1.9k` = 1,900. `42.3k` = 42,300. Parse before storing.
- **Image URLs in `urlMap` are ImageKit-transformed CDN paths.** They include resize/quality params (`tr:w-403,ar-4000-4000,pr-true,f-auto,q-40,dpr-2`). If you want a higher-res version, strip the `tr:…/` segment to get the original path under `cms/product_variant/<uuid>/<slug>.jpeg` at `cdn.zeptonow.com/production/`.
- **The backing API at `bff-gateway.zepto.com/user-search-service/api/v3/search` is signed and gated.** Headers include a rotating `x-csrf-secret`, a body-signed `request-signature`, store IDs derived from the selected delivery location, and a 1.5KB `compatible_components` flag set. Cold curl/fetch returns 401/403 (or worse — a 200 with empty/sanitised payload). Don't bother trying to spoof; either parse the rendered DOM, or use an evaluate from within an already-authenticated session.
- **`bff-gateway.zepto.com` and `api.zeptonow.com` are NOT the same surface.** The latter returns 500 on every cold path we probed; only `bff-gateway` carries the v3 search API, and only behind in-page auth.
- **CSP locks scripts to `*.zeptonow.com`, `*.zeptonow.dev`, `*.zepto.com`, `cdn.zeptonow.com`.** Don't try to inject third-party JS for scraping; an evaluate (page-context) works because it runs as the page's own origin, but anything else will get CSP-blocked.
- **Proxy geography matters.** A residential India egress (`proxy: { proxy: "residential", proxyCountry: "in" }`) is the correct control — it satisfies the IP-mismatch heuristics and keeps address-suggestion latency bearable (~2.5s for the 5-item dropdown). EU/US exits add 600-900ms of latency on every modal interaction and sometimes time out the autocomplete typeahead.
- **The page lazily renders cards as you scroll** — a fresh `/search?query=` snapshot returns only the first ~30 cards (10 `PRODUCT_GRID` widgets of 3 each). To get the full 263-result set for a popular query like "chocolate", you must scroll-paginate; there is no `?page=N` URL param that works.
- **Cookies/session state persist across `goto` commands, and across separate calls that carry the same `proxy`/`profile`.** Setting location once means subsequent `/search?query=…` navigations keep that location. This is the only reason the URL-search step is cheap; if a call drops or changes the `proxy`/`profile` (landing in a different, blank session), redo step 1.
- **READ-ONLY.** Never click `ADD`, never proceed to `/cart` or `/checkout`. Cart-modification XHRs are gated by the same signed-header machinery as search and don't easily round-trip back.

## Expected Output

Five distinct outcome shapes; the caller should branch on `status`:

```json
// success — normal results
{
  "status": "success",
  "query": "basmati rice",
  "location": {
    "label": "Koramangala",
    "fullAddress": "Koramangala, Bangalore, Karnataka",
    "etaMinutes": 9
  },
  "totalShown": 30,
  "totalAvailable": 263,
  "products": [
    {
      "name": "Daawat Pulav Basmati Rice | Long Grain",
      "brand": "Daawat",
      "packSize": "1 pack (500 g)",
      "variant": "Long Grain",
      "price": 75,
      "mrp": 90,
      "discount": { "amount": 15, "percent": 17 },
      "rating": 4.6,
      "reviewCount": 16800,
      "inStock": true,
      "etaMinutes": 9,
      "sponsored": false,
      "tags": [],
      "url": "https://www.zepto.com/pn/daawat-pulav-basmati-rice-long-grain/pvid/96b12acf-bdcd-47bb-a9e9-a04364fd30e1",
      "imageUrl": "https://cdn.zeptonow.com/production/ik-seo/tr:w-403,ar-3000-3000,pr-true,f-auto,q-40,dpr-2/cms/product_variant/19b0b091-07e3-40b6-b60e-0719e39caf64/Daawat-Pulav-Basmati-Rice-Long-Grain.jpeg"
    }
  ]
}

// no_results — query matched zero SKUs in this location
{
  "status": "no_results",
  "query": "xyzzyplugh",
  "location": { "label": "Bandra C", "fullAddress": "Bandra C, Mumbai, Maharashtra", "etaMinutes": 9 },
  "products": []
}

// not_serviceable — Zepto doesn't deliver to the chosen address
{
  "status": "not_serviceable",
  "query": "milk",
  "location": { "label": "Other", "fullAddress": "Andaman and Nicobar Islands", "etaMinutes": null },
  "message": "Sit Tight! We're Coming Soon!"
}

// store_offline — local dark store temporarily closed, no products shown
{
  "status": "store_offline",
  "query": "coffee",
  "location": { "label": "Koramangala", "fullAddress": "Koramangala, Bangalore, Karnataka", "etaMinutes": null },
  "retryInMinutes": 15,
  "products": []
}

// store_offline_but_browsable — store paused but the catalog still renders
// for browsing. Cards have valid price/MRP/rating but NO per-card ETA;
// inStock should be reported as `null` (intent: orderable when reopened),
// not `true` — placing an order would be blocked at checkout time.
{
  "status": "store_offline_but_browsable",
  "query": "coffee",
  "location": { "label": "Koramangala", "fullAddress": "Koramangala, Bangalore, Karnataka", "etaMinutes": null },
  "retryInMinutes": 15,
  "products": [
    {
      "name": "Nescafe Classic - Instant Coffee Powder - Pure Coffee",
      "brand": "Nescafe",
      "packSize": "1 pc (24 g)",
      "variant": null,
      "price": 116,
      "mrp": 124,
      "discount": { "amount": 8, "percent": 6 },
      "rating": 4.7,
      "reviewCount": 12800,
      "inStock": null,
      "etaMinutes": null,
      "sponsored": false,
      "tags": [],
      "url": "https://www.zepto.com/pn/nescafe-classic-instant-coffee-powder/pvid/<uuid>",
      "imageUrl": "https://cdn.zeptonow.com/production/ik-seo/tr:w-403,ar-1200-1200,pr-true,f-auto,q-40,dpr-2/cms/product_variant/<uuid>/Nescafe-Classic.jpeg"
    }
  ]
}
```
