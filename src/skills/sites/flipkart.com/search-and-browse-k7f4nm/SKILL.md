---
name: search-and-browse
title: Flipkart Product Search & Browse
description: >-
  Search Flipkart by free-text query and return ranked products (title, brand,
  price, MRP, discount, rating, stock, pid, URL) by parsing the server-rendered
  __INITIAL_STATE__; supports pagination, sort, and navigating to product detail
  pages. Read-only.
website: flipkart.com
category: ecommerce
tags:
  - ecommerce
  - flipkart
  - search
  - products
  - price
  - india
source: 'browserbase: agent-runtime 2026-06-03'
updated: '2026-06-03'
recommended_method: fetch
alternative_methods:
  - method: browser
    rationale: >-
      Fallback when the primary load is rate-limited or blocked. The search
      page renders cleanly under browserless_agent (add a residential proxy if
      blocked); but the __INITIAL_STATE__ blob must come from the raw navigation
      response, not the hydrated DOM — see the browserless_function path.
  - method: api
    rationale: >-
      No standalone public search API exists — the search page makes zero
      XHR/fetch calls for result data (verified by CDP network trace). Results
      are server-rendered into the HTML, so the fetch+parse path is the
      canonical 'API'.
verified: true
proxies: true
---

# Flipkart Product Search & Browse

## Purpose

Search Flipkart (flipkart.com — India's largest e-commerce marketplace) for products by free-text query and return the ranked result set: title, brand, current and struck-off price, discount, star rating, rating/review counts, stock state, product id (`pid`), and canonical product URL. Optionally navigate to any result's detail page. Read-only — never adds to cart, logs in, or checks out.

## When to Use

- Price / availability monitoring for a product or category on Flipkart.
- Bulk extraction of search results (title, price, rating, URL) across queries or pages.
- Resolving a search query to a canonical product `pid` + detail URL for downstream navigation.
- Anywhere you'd otherwise scrape rendered Flipkart HTML — the data is already in the server-rendered page as JSON, so a single HTTP fetch beats driving a browser.

## Workflow

Flipkart's search page is **server-rendered**: the complete result set (all ~24–40 product cards, pagination, sort options, breadcrumbs) is embedded in the HTML as a `window.__INITIAL_STATE__ = {...}` JSON blob. There is **no separate public search API** — the page makes **zero XHR/fetch calls** to retrieve results (confirmed via CDP network trace: 0 Fetch/XHR requests to any flipkart host on the search page). So the optimal path is a single `browserless_function` that navigates and reads the raw server response body, then parses the JSON in one pass. Use a residential proxy for reliability (datacenter IPs occasionally return a transient `500`; see gotchas).

### Recommended: load + parse `__INITIAL_STATE__`

1. **Build the search URL**:

   ```
   https://www.flipkart.com/search?q={url-encoded query}&page={N}&sort={sort}
   ```
   - `q` — the search query (`wireless+earbuds`, `running+shoes`, `laptop`, …).
   - `page` — 1-indexed; optional, defaults to 1. Total page count is in the response (often hundreds).
   - `sort` — optional, one of: `relevance` (default), `popularity`, `price_asc`, `price_desc`, `recency_desc`, `discount`.

2. **Load the HTML and read the raw navigation response** with `browserless_function`.
   The `__INITIAL_STATE__` blob survives only in the server response body (the app deletes
   it from the live DOM on hydration — see gotchas), so grab `resp.text()`, not `page.content()`:

   ```js
   export default async ({ page }) => {
     const url = "https://www.flipkart.com/search?q=wireless+earbuds&page=1";
     const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
     const html = await resp.text();                 // raw SSR body — still contains __INITIAL_STATE__
     // steps 3–6: brace-match window.__INITIAL_STATE__, walk widgets, dedupe, project products
     return { data: /* compact JSON projection */, type: "application/json" };
   };
   ```

   Expect an HTTP 200. Prefer a residential proxy for reliability (datacenter IPs occasionally return a transient `500`).

3. **Extract the embedded state**. Slice the substring after `window.__INITIAL_STATE__ = ` up to the closing `</script`, strip a trailing `;`, and `JSON.parse` it.

4. **Walk to the product widgets**. Products live under `state.pageDataV4.page.data` — iterate every slot key; the search results are in the (repeated) widget whose `widget.type === "PRODUCT_SUMMARY"`, each holding a `widget.data.products[]` array. Concatenate across all `PRODUCT_SUMMARY` widgets and **dedupe by `productInfo.value.id`** (cards repeat across slots).

5. **Decode each product** from `product.productInfo.value` (`v`):
   - `v.id` — the `pid` (e.g. `ACCH7KPDFXMWQ6XN`).
   - `v.titles.title` / `v.titles.newTitle` — product name; `v.titles.superTitle` — brand; `v.titles.subtitle` — variant (e.g. "Black, True Wireless").
   - `v.pricing.prices[]` — array of `{value, strikeOff}`. **Current price** = the entry with `strikeOff: false`; **original (MRP)** = the entry with `strikeOff: true`. `v.pricing.totalDiscount` is the discount **percentage** (integer); `v.pricing.discountAmount` is the absolute rupee discount. Prices are integer **INR** (₹), no decimals.
   - `v.rating.average` (out of `v.rating.base`, =5), `v.rating.count` (total ratings), `v.rating.reviewCount` (text reviews), `v.rating.roundOffCount` (display string like "64.6K+"). `v.rating` may be absent for unrated products.
   - `v.availability.displayState` — `IN_STOCK`, etc.
   - **Canonical URL** = `https://www.flipkart.com` + `v.baseUrl` (baseUrl already includes the `?pid=` query and the `/p/itm…` item id).

6. **Metadata** (sibling widgets under the same `page.data`): `PAGINATION_BAR` widget → `data.totalPages`, `data.currentPage`; `FILTER_SORT_OPTIONS` widget → `data.query`, `data.productStartIndex`/`productEndIndex`, `data.breadCrumbs[].title` (category path Flipkart auto-mapped the query into), and `data.sortOptions[]` (each `.action.params.value` is the `sort` URL value).

7. **Navigate to a product** (optional): GET the canonical URL the same way; the detail page also embeds a `window.__INITIAL_STATE__` blob (product-detail-shaped — `productPage`/`productInfo` top-level keys) for richer specs.

### Browser fallback

Only needed if the primary path is rate-limited/blocked (not observed in testing). The search page also renders cleanly under `browserless_agent` (add `proxy: { proxy: "residential" }` if blocked). **Critical: do NOT read `window.__INITIAL_STATE__` or the hydrated DOM HTML for the blob** — the React app deletes the global and removes the inline `is_script` element after hydration, so the blob is gone from the live DOM (verified: the post-load DOM does not contain `__INITIAL_STATE__`). The `browserless_function` path above already reads the **raw navigation-response body** (`resp.text()`), which still contains it — that is the reliable source.

As a pure last resort, the rendered product **cards** are present in the DOM (~125 `a[href*="/p/itm"]` anchors): a `browserless_agent` `{ "method": "goto", ... }` then `{ "method": "text", "params": { "selector": "main" } }` lists them with prices/ratings, but this yields fewer, less-structured products than parsing the navigation JSON.

For read-only extraction you never need to click anything; ignore the login-modal overlay.

## Site-Specific Gotchas

- **No standalone search JSON API.** Flipkart server-renders results into `window.__INITIAL_STATE__`; the search page issues **0 XHR/fetch calls** for result data (verified by CDP network trace). Don't hunt for an `/api/` endpoint — parse the embedded state. (This differs from per-product async widgets on detail pages, which do lazy-load.)
- **`__INITIAL_STATE__` is consumed and deleted on hydration — only the raw HTTP response has it.** The React app reads `window.__INITIAL_STATE__` and then removes both the global and the inline `is_script` element. So in a _live_ browser, `window.__INITIAL_STATE__`, `document.querySelector('#is_script')`, and `page.content()` all come up empty (verified). The blob survives **only in the raw HTTP response body** — i.e. exactly what `browserless_function`'s `(await page.goto(url)).text()` returns. A script that scrapes the hydrated DOM (`page.content()`) for the blob will silently return zero products. This is _the_ reason the `browserless_function` path reads the navigation response, not the DOM.
- **The results slot under `page.data` is an ARRAY of widgets, not a single widget.** Slot `10003` (the main `PRODUCT_SUMMARY` carrier) is an array of repeated `PRODUCT_SUMMARY` widgets, each holding a `products[]` chunk. When walking `Object.values(page.data)`, flatten one level (spread array-valued slots) before filtering on `widget.type` — otherwise you skip every product. (Naïve `Object.values(...).filter(w => w.widget.type==='PRODUCT_SUMMARY')` returns nothing for these slots.)
- **JSON-LD is not a usable fallback here.** The page carries exactly one `<script type="application/ld+json">`, but in testing it parsed to an object with no `@type`/keys (empty/placeholder) — do not rely on a schema.org `ItemList` for extraction. The navigation-response `__INITIAL_STATE__` is the only complete source.
- **Residential proxy recommended, not strictly required.** With `proxy: { proxy: "residential" }` the load returned `200` consistently; without it the load succeeded but returned a transient `500 Internal Server Error` on one of two attempts. Use a residential proxy for reliable, repeatable extraction.
- **Prices are an array, not a field.** `v.pricing.prices` holds both the live price (`strikeOff:false`) and the MRP (`strikeOff:true`) — never assume `prices[0]` is the current price (observed order is `[MRP, current]`). Filter by the `strikeOff` flag.
- **`totalDiscount` is a percentage; `discountAmount` is rupees.** Don't conflate them (e.g. `totalDiscount: 75` means 75% off, `discountAmount: 4500` means ₹4500 off).
- **Cards repeat across slots.** The same product appears in multiple `PRODUCT_SUMMARY` widgets; always dedupe by `v.id`. A single search page yields ~24–40 **distinct** products after dedupe.
- **`rating` can be missing** for new/unrated products — guard before reading `v.rating.average`.
- **Sponsored/ad products** carry a populated `product.adInfo` object and may rank first; filter on `adInfo` presence if you need organic-only results.
- **Query auto-maps to a category.** Flipkart resolves the free-text query into a category tree (`breadCrumbs`), which scopes results — broad queries ("laptop") return fewer per page (~24) than category-rich ones ("wireless earbuds", ~38) because of card layout, not result scarcity. Total inventory is in `PAGINATION_BAR.totalPages` (e.g. 558 pages for "wireless earbuds").
- **`baseUrl` is already absolute-path + query-complete.** It contains `/p/itm…?pid=…`; just prefix the origin. Don't re-append `?pid=` — it's already there.
- **Prices/availability are India-region (INR).** Flipkart serves only India; there is no locale switch. Values are ₹.
- **Currency has no symbol in the JSON** — `value` is a bare integer; render the `₹` yourself.

## Expected Output

```json
{
  "query": "wireless earbuds",
  "page": 1,
  "sort": "relevance",
  "total_pages": 558,
  "category_path": ["Home", "Audio & Video", "Headset", "Earphones"],
  "result_count": 38,
  "products": [
    {
      "id": "ACCH7KPDFXMWQ6XN",
      "title": "GOBOULT Mustang Torq 60Hrs, App Support, 4Mic ENC, Breathable LED, 5.4v Bluetooth",
      "brand": "GOBOULT",
      "subtitle": "Yellow, True Wireless",
      "current_price": 1499,
      "original_price": 5999,
      "discount_pct": 75,
      "currency": "INR",
      "rating": 4.2,
      "rating_count": 64627,
      "review_count": 4820,
      "availability": "IN_STOCK",
      "sponsored": false,
      "url": "https://www.flipkart.com/goboult-mustang-torq-60hrs-app-support-4mic-enc-breathable-led-5-4v-bluetooth/p/itm74a6b52a73f95?pid=ACCH7KPDFXMWQ6XN"
    }
  ]
}
```

For an unrated product the `rating`, `rating_count`, and `review_count` fields are `null`. If the query returns no matches, `result_count` is `0` and `products` is `[]`.
