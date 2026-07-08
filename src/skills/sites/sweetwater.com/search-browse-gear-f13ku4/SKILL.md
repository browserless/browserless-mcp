---
name: search-browse-gear
title: Search & Browse Gear on Sweetwater
description: >-
  Search Sweetwater for products and browse categories, returning structured
  data — model number, brand, price, sale/rebate flags, and new/used/demo
  condition — via a residential-proxy browserless_agent read of the
  server-rendered HTML (driving the page interactively is blocked by PerimeterX).
website: sweetwater.com
category: ecommerce
tags:
  - ecommerce
  - music-gear
  - search
  - pricing
  - used-gear
  - sweetwater
source: 'browserbase: agent-runtime 2026-06-12'
updated: '2026-06-12'
recommended_method: fetch
alternative_methods:
  - method: browser
    rationale: >-
      Confirmed blocked. Driving the page interactively returns PerimeterX
      'Access to this page has been denied' even over a residential proxy with a
      25s+ CAPTCHA-solve wait. Not a viable path.
  - method: api
    rationale: >-
      Search is powered by Algolia (index production_products), but the data is
      delivered fully inside the page's __NEXT_DATA__ blob — fetching the
      /store/search HTML is simpler and avoids needing Algolia app/API keys.
verified: false
proxies: true
---

# Search & Browse Gear on Sweetwater

## Purpose

Search Sweetwater (the music-gear retailer) for products, browse categories, and read back fully
structured data for each item — model number, brand, name, current price, list/retail price, sale
and rebate flags, ratings, and **new vs. used/demo/open-box** condition with per-condition pricing.
This skill is **read-only**: it never adds to cart or checks out. The recommended path uses a
`browserless_agent` `goto` **over a residential proxy** — reading the server-rendered HTML rather
than driving the UI — which returns the full page. Interactive browser navigation is blocked by
PerimeterX and should not be attempted.

## When to Use

- "What does the Shure SM7B cost on Sweetwater?" / look up a specific model number or product name.
- "Find all electric guitars under $500" / browse a product category and read prices.
- "Is this item on sale?" — compare `finalPrice` vs `retailPrice` and read price-drop/rebate flags.
- "Does Sweetwater have a used/demo/open-box version of X?" — read the alternate-condition pricing.
- Pull a comparison table of model numbers, brands, prices, and conditions across search results.

## Workflow

Sweetwater is a Next.js storefront whose **keyword search is powered by Algolia** and whose **category
grids are server-rendered HTML**. The site sits behind PerimeterX (HUMAN) bot protection that denies
_driven_ browser sessions, but a `browserless_agent` `goto` over a residential proxy that reads the
first-load HTML passes cleanly.

### Method A — Keyword / model-number search (Algolia `__NEXT_DATA__`)

1. Load the search URL over a residential proxy (`browserless_agent` with `proxy: { proxy: "residential" }`), reading the server-rendered HTML rather than driving the UI:
   ```jsonc
   { "method": "goto", "params": { "url": "https://www.sweetwater.com/store/search?s=<query>", "waitUntil": "load", "timeout": 45000 } }
   { "method": "evaluate", "params": { "content": "(()=>JSON.parse(document.getElementById('__NEXT_DATA__').textContent))()" } }
   ```
   A rendered results page (not the 'Access to this page has been denied' wall) is the success signal.
2. The `evaluate` returns the parsed `__NEXT_DATA__` state blob directly (under `.value`) — no need to regex it out of raw HTML.
3. Read results from:
   - `props.pageProps.hitsTotal` — total match count.
   - `props.pageProps.hitsPerPage` — page size (42).
   - `props.pageProps.resultsState.results[0].hits` — the array of products.
4. For each hit, the useful fields are:
   - `objectID` — the **model number / item id** (e.g. `SM7B`).
   - `brand`, `productName`, `genericName`, `longDescription`.
   - `price` → `{ finalPrice, basePrice, catalogPrice, retailPrice, hasPriceDrop, isSpecialPrice,
instantRebateAmount, mailInRebateAmount }`. **On sale** ⇔ `retailPrice > finalPrice` OR
     `hasPriceDrop` OR `isSpecialPrice` OR a non-zero rebate.
   - `attributes.condition` — usually `"New"` (or `"Demo"` for demo-only listings).
   - `attributes.alternateConditions` — array of `{ condition, itemid, price }` for **used / demo /
     B-stock** variants of the same product (e.g. `{ "condition":"Demo","itemid":"SM7Bd3","price":395.1 }`).
   - `attributes.inStock`, `attributes.isInStock`, `attributes.available`, `attributes.priceRange`.
   - `categories.lvl0` / `lvl1` / `lvl2` — hierarchical category path.
   - `rating` → `{ average, count, reviewUrl }`; `url` — relative product-detail path; `specialOffer`,
     `financing`.

### Method B — Category browse (server-rendered product cards)

1. Category URLs come in two shapes, both fetchable the same way:
   - Human-readable: `/shop/<group>/<subcategory>/` (e.g. `/shop/guitars/electric-guitars/`).
   - ID-based: `/c<ID>--<Name>` (e.g. `/c590--Solidbody_Guitars`).
     Find them in the homepage / search-page navigation, or the category landing `/shop/by-category/`.
   ```jsonc
   // browserless_agent with proxy: { proxy: "residential" }
   {
     "method": "goto",
     "params": {
       "url": "https://www.sweetwater.com/c590--Solidbody_Guitars",
       "waitUntil": "load",
       "timeout": 45000,
     },
   }
   ```
2. Category pages do **not** carry `__NEXT_DATA__`. Parse the server-rendered grid in an `evaluate`
   (return a compact projection, not the raw HTML): each product is a
   `<div class="product-card …" data-itemid="<MODEL#>" …>` containing:
   - `data-itemid` — the model number.
   - `product-card__name` — full product name.
   - the price text (e.g. `$359.99`) and `product-card__offers` (e.g. `"$300.00 Off While Supplies Last"`).
   - used/open-box availability as `"Certified Open Box available for $X"` inside the card.
   - an `<a href="/store/detail/…">` link to the product detail page.
     There is also a small `ItemList` JSON-LD block, but it lists only the top ~5 featured items — use
     the `data-itemid` cards for the full grid.

### Method C — Used / demo / open-box gear

- Used and demo variants surface inline in both methods (Algolia `attributes.alternateConditions`;
  category cards' "Certified Open Box available for $X").
- A dedicated used-gear hub exists at `https://www.sweetwater.com/used` (also reachable with the same
  residential-proxy `goto`).

### Browser fallback

There is effectively **no interactive fallback**. Driving any sweetwater.com URL (clicks/scroll)
returns `"Access to this page has been denied"` (PerimeterX), and a residential-proxy session
left to auto-`solve` the "Press & Hold" challenge for 25s+ still does not pass. Do not spend budget
driving the page — read the server-rendered HTML on first load via `goto` + `evaluate` (above).

## Site-Specific Gotchas

- **Anti-bot wall (interactive path is dead):** sweetwater.com is behind PerimeterX/HUMAN. Both the
  homepage and `/store/search` return a 403 / "Access to this page has been denied" page when the
  browser is _driven_, even over a residential proxy with a long CAPTCHA-solve wait. The **only**
  reliable path is a `browserless_agent` `goto` over a residential proxy that reads the server-rendered
  HTML on first load (returns the full page).
- **The residential proxy is mandatory.** A no-proxy `goto` was not relied upon; always pass
  `proxy: { proxy: "residential" }`.
- **Parse in-page, don't ship raw HTML back.** The category grid can be large; run the `product-card`
  parsing (and the `__NEXT_DATA__` read) inside an `evaluate` and return only the projected fields —
  the agent/function text return is capped (~200k chars).
- **Two different search systems.** Keyword search (`/store/search`) is **Algolia** (`indexName:
production_products`) and exposes clean JSON in `__NEXT_DATA__`. Category pages (`/shop/…`,
  `/c<ID>--…`) are server-rendered HTML with no `__NEXT_DATA__` — parse `product-card` markup instead.
- **Generic queries redirect to a category page.** A query that exactly matches a category name —
  e.g. `s=microphone`, `s=guitar` — 307-redirects to a `/shop/<cat>/…` category page, which has no
  Algolia JSON. With `goto` the redirect is followed automatically: you'll land on a category page
  whose HTML has no `__NEXT_DATA__` — detect the missing `__NEXT_DATA__` (or the final `/shop/` URL)
  and switch to Method B (product-card parsing). Model numbers and specific terms (e.g. `sm7b`) stay
  on the Algolia search page and keep `__NEXT_DATA__`.
- **Don't abandon the read path on a single transient block.** One "Access denied" can be a cold-proxy
  fluke — retry the `goto` once with a fresh residential proxy before concluding the wall is up. Never
  fall back to _driving_ the UI; that path is dead.
- **Pagination:** results are paged at `hitsPerPage` = 42. `props.pageProps` carries the current
  page's hits; for more results, request additional pages (the search page is paginated — small
  result sets like `sm7b` (13 hits) fit on one page).
- **Sale detection is multi-signal.** Don't rely on a single field: an item is discounted if
  `retailPrice > finalPrice`, or `hasPriceDrop === true`, or `isSpecialPrice === true`, or
  `instantRebateAmount`/`mailInRebateAmount` > 0. `specialOffer` (when non-null) describes promos.
- **Model number = `objectID`** in Algolia and **`data-itemid`** on category cards — these are the
  canonical Sweetwater item IDs you can feed into `/store/detail/<itemid>--<slug>`.

## Expected Output

### Keyword search (Method A)

```json
{
  "method": "fetch",
  "query": "sm7b",
  "hits_total": 13,
  "hits_per_page": 42,
  "products": [
    {
      "model_number": "SM7B",
      "brand": "Shure",
      "name": "SM7B Dynamic Cardioid Vocal Microphone",
      "final_price": 439,
      "retail_price": 549,
      "on_sale": false,
      "price_drop": false,
      "instant_rebate": 0,
      "condition": "New",
      "alternate_conditions": [
        { "condition": "Demo", "itemid": "SM7Bd3", "price": 395.1 }
      ],
      "in_stock": true,
      "categories": [
        "Studio & Recording",
        "Microphones & Wireless",
        "Dynamic Microphones"
      ],
      "rating": { "average": 5, "count": 258 },
      "url": "/store/detail/SM7B--shure-sm7b-cardioid-dynamic-vocal-microphone"
    }
  ]
}
```

### Generic query redirected to a category (307 → Method B)

```json
{
  "method": "fetch",
  "query": "microphone",
  "redirected": true,
  "redirect_status": 307,
  "category_url": "/shop/studio-recording/microphones/",
  "note": "Generic category-name query redirected; re-fetch the category URL and parse product-card markup (Method B)."
}
```

### Category browse (Method B)

```json
{
  "method": "fetch",
  "category": "/c590--Solidbody_Guitars",
  "products": [
    {
      "model_number": "PAC112VVSB",
      "brand": "Yamaha",
      "name": "Yamaha PAC112V Pacifica Electric Guitar - Old Violin Sunburst",
      "price": 359.99,
      "offer": null,
      "open_box": null,
      "url": "/store/detail/PAC112VVSB--yamaha-pac112v-pacifica-old-violin-sunburst"
    }
  ]
}
```

### Blocked (browser path attempted)

```json
{
  "method": "browser",
  "success": false,
  "error_reasoning": "PerimeterX denied the driven session ('Access to this page has been denied'). Read the server-rendered HTML via a browserless_agent `goto` over a residential proxy instead — don't drive the UI."
}
```
