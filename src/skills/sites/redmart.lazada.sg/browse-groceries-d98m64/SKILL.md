---
name: browse-groceries
title: RedMart Browse Groceries
description: >-
  Browse and search RedMart (Lazada Singapore's grocery arm) for products by
  query or category, returning name, pack size, price, original price, unit
  price, promo badge, rating, review count, image, and product URL. Read-only —
  never adds to cart or checks out.
website: redmart.lazada.sg
category: groceries
tags:
  - groceries
  - lazada
  - singapore
  - redmart
  - shopping
  - akamai
  - read-only
source: 'browserbase: agent-runtime 2026-05-24'
updated: '2026-05-24'
recommended_method: browser
alternative_methods:
  - method: fetch
    rationale: >-
      A plain HTTP GET returns only the JS bootstrap shell (~66 KB, zero
      product tiles). The catalog page hydrates RedmartProductTile-* markup via
      a deferred render script that requires a real headless browser, so a plain
      HTTP GET cannot replace the browser path.
  - method: api
    rationale: >-
      No public Lazada/RedMart product-search JSON API was discoverable. The
      page's inline window.LZD / iLogger state does not contain product arrays,
      and observed XHRs do not include the search result set. Don't waste time
      on mtop / acs-m.lazada.sg.
verified: true
proxies: true
---

# RedMart Browse Groceries

## Purpose

Browse and search the RedMart online grocery section of Lazada Singapore for a query and/or category, returning a structured list of grocery products with name, package weight/volume, current price (SGD), original/strikethrough price, unit price (per L, per kg, etc.), star rating, review count, in-stock state, product image, canonical product URL, and any "Multiple Promo" / promo badge. Read-only — never adds to cart, never checks out, never logs in.

## When to Use

- "What's the cheapest milk on RedMart?" / "Show me UHT milk under $2 per litre."
- Daily price-tracking of a specific SKU or category (e.g. eggs, rice, instant noodles).
- Building a comparison shopping list across RedMart and competitors (FairPrice, Sheng Siong) — pull the RedMart side here.
- Discovering current promotions / "Multiple Promo" tagged items in a category.
- Any time you'd otherwise navigate the RedMart UI to read product info but never to purchase.

## Workflow

RedMart's search and category pages are **server-side rendered on the `redmart.lazada.sg` subdomain** — all 40 product tiles per page are in the initial HTML returned by an `html` command on `body`. There is no public JSON API; the in-page React state (`window.__INITIAL_STATE__`, `window.pageData`, `window.LZD`) does **not** contain product arrays. A plain HTTP GET returns only the JS shell (no `RedmartProductTile-*` tiles), because the products are injected by a script that runs after page-load — so a headless render is required. Drive `browserless_agent`, extract from the rendered HTML.

A **residential-proxy real-browser path is mandatory** — without it the first navigation that crosses to `www.lazada.sg` (which the global Lazada search box does) gets redirected to an Akamai `_____tmd_____/punish` page. The SG-eligible residential IP is the load-bearing part: it is what lets the real browser clear Akamai. See gotcha #1.

1. **Drive one ephemeral `browserless_agent` call with a SG residential proxy.** Set the top-level `proxy` arg on **every** call:

   ```json
   "proxy": { "proxy": "residential", "proxyCountry": "sg" }
   ```

   A SG-eligible residential exit IP is required (RedMart geo-gates, and Akamai punishes datacenter/non-SG traffic). The session is keyed by `proxy`, so **repeat the same `proxy` arg on every call** to reconnect to the same warmed session (cookies intact); dropping or changing it lands you in a different, blank session. Batching the whole navigate → wait → extract sequence inside ONE `commands` array is the convenient default (fewer round-trips), but split-across-calls works too as long as you carry the same `proxy`.

2. **Navigate to the RedMart-scoped search URL.** This is the load-bearing URL pattern:

   ```
   https://redmart.lazada.sg/catalog/?q={URL-encoded query}&m=redmart
   ```

   **Use the `redmart.lazada.sg` subdomain, NOT `www.lazada.sg`.** The same query at `https://www.lazada.sg/catalog/?q=milk&m=redmart` immediately redirects to a `_____tmd_____/punish?x5secdata=...` Akamai challenge page even with a residential proxy; the `redmart.` subdomain returns the search results page directly. (Gotcha #1.)

   Optional sort parameter: `&sort=priceasc` (price low→high), `&sort=pricedesc`, `&sort=popularity`. Optional pagination: `&page=N` (1-indexed; page count is 40 results per page, but pages overlap heavily — gotcha #5).

   Put the navigation, hydration wait, and HTML grab in ONE `commands` array so they share the ephemeral session:

   ```json
   {
     "proxy": { "proxy": "residential", "proxyCountry": "sg" },
     "commands": [
       {
         "method": "goto",
         "params": {
           "url": "https://redmart.lazada.sg/catalog/?q=milk&m=redmart&sort=priceasc",
           "waitUntil": "load",
           "timeout": 45000
         }
       },
       { "method": "waitForTimeout", "params": { "time": 4000 } },
       { "method": "html", "params": { "selector": "body" } }
     ]
   }
   ```

   (tile hydration is ~2–3s after `load` fires, hence the 4000 ms `waitForTimeout`.)

3. **For category browsing instead of search**, navigate to the category slug directly. Observed category URLs (each works with `?m=redmart` and the same `&sort=...` / `&page=N` params):

   | Category                          | URL slug                                                             |
   | --------------------------------- | -------------------------------------------------------------------- |
   | Fresh produce                     | `redmart.lazada.sg/shop-groceries-fresh-produce/`                    |
   | Dairy, chilled & eggs             | `www.lazada.sg/shop-dairy-chilled-&-eggs/` (lives on `www.` — works) |
   | Food staples / cooking essentials | `redmart.lazada.sg/shop-Groceries-FoodStaplesCookingEssentials/`     |
   | Frozen                            | `redmart.lazada.sg/shop-groceries-frozen/`                           |
   | Beverages                         | `redmart.lazada.sg/beverages/`                                       |
   | Meat & seafood                    | `redmart.lazada.sg/meat-and-seafood/`                                |
   | Wines, beers & spirits            | `redmart.lazada.sg/wines-beers-spirits/`                             |
   | Health & beauty                   | `redmart.lazada.sg/shop-health-beauty/`                              |
   | Household supplies                | `redmart.lazada.sg/shop-household-supplies/`                         |
   | Pet supplies                      | `redmart.lazada.sg/shop-pet-supplies/`                               |
   | Mother & baby                     | `redmart.lazada.sg/mother-baby/`                                     |
   | Snacks & confectionery            | `www.lazada.sg/shop-snacks-&-confectionery/?m=redmart`               |
   | Kitchenware & tableware           | `www.lazada.sg/shop-kitchenware-&-tableware/?m=redmart`              |

   The exact set is harvested from the homepage left-nav (`https://redmart.lazada.sg/`). Some categories sit under `www.lazada.sg` rather than `redmart.lazada.sg` — those still serve product tiles correctly (the Akamai punish trigger is specifically on `www.lazada.sg/catalog/?q=...`, not on `www.lazada.sg/shop-*`). When in doubt, prefer the `redmart.lazada.sg` host.

4. **Extract product tiles from the rendered HTML.** The `html` command (step 2's `commands` array) returns the body HTML as a JSON string — the inner markup is JSON-escaped, so `"` appears as `\"` (note the `\\"` in the regex below). Feed that returned HTML string into the parse:

   ```python
   # html = the string returned by the { "method": "html", "params": { "selector": "body" } } command
   ```

   Then parse with a regex over `RedmartProductTile-*` classes:

   ```python
   import re, json
   # `html` = the JSON string returned by the { "method": "html", "params": { "selector": "body" } } command

   total = int(re.search(r"([0-9,]+) items", html).group(1).replace(",",""))

   # Each product tile is one <div class="RedmartProductTile-container">…</div>
   card_re = re.compile(
       r'<a class=\\"RedmartProductTile-link\\" href=\\"([^"\\]+)\\".*?'
       r'<img src=\\"([^"\\]+)\\".*?'
       r'(?:<span><span>([^<]+)</span></span>)?'                       # promo badge text e.g. "Multiple Promo"
       r'.*?class=\\"RedmartProductTile-price\\">([^<]+)</div>'         # current price "$2.75"
       r'(?:.*?class=\\"RedmartProductTile-originalPrice\\">([^<]+)</span>)?'  # strikethrough
       r'.*?class=\\"RedmartProductTile-title\\">([^<]+)</div>'         # product name
       r'.*?class=\\"RedmartProductTile-weight\\">([^<]+)</div>'        # pack size e.g. "1 L", "500 g", "24 × 200 ml"
       r'(?:.*?class=\\"ProductTileReview-score\\">([^<]+)</span>'      # rating
       r'.*?class=\\"ProductTileReview-text\\">\(([0-9]+)\)</span>)?'   # review count
       r'(?:.*?class=\\"ProductTileReview-unitPrice\\">([^<]+)</div>)?',# unit price "$2.75/L"
       re.DOTALL,
   )

   for href, img, badge, price, orig, title, weight, rating, reviews, unit_price in card_re.findall(html):
       qs = dict(kv.split("=",1) for kv in href.split("?",1)[1].split("&amp;") if "=" in kv)
       yield {
           "name": title,
           "pack_size": weight,
           "price_sgd": float(price.lstrip("$")),
           "original_price_sgd": float(orig.lstrip("$")) if orig else None,
           "unit_price": unit_price,                       # e.g. "$2.75/L"
           "promo_badge": badge,                           # e.g. "Multiple Promo"
           "rating": float(rating) if rating else None,
           "review_count": int(reviews) if reviews else 0,
           "image_url": img,
           "product_url": ("https:" + href.split("?",1)[0]) if href.startswith("//") else href.split("?",1)[0],
           "in_stock": qs.get("stock") == "1",
       }
   ```

   Each results page renders exactly **40** tiles inside `<div class="ProductGridModern-container desktop" data-spm="list">`. The total result count appears as `"X items"` in the header (e.g. `"4107 items"` for query `milk`).

5. **Paginate (carefully).** Append `&page=2`, `&page=3`, … to the `goto` URL — either as extra `goto` → `waitForTimeout` → `html` triplets appended to the same `commands` array, or as fresh `browserless_agent` calls (remember to repeat the `proxy` arg each time). Pagination is server-side honoured (active page is marked by `ant-pagination-item-N ant-pagination-item-active`), but consecutive pages have **heavy SKU overlap** — gotcha #5. Dedupe by SKU id `pdp-i{itemId}-s{skuId}.html` from `product_url`, and stop when no new SKUs surface for two consecutive pages.

6. **No session-release step.** The session persists across calls keyed by `proxy` — there is nothing to explicitly release. Batching steps 2–5 in one `commands` array is convenient; if you split across calls, repeat the same `proxy` arg on each so you stay in the same warmed session.

## Site-Specific Gotchas

- **`www.lazada.sg/catalog/?q=...` triggers Akamai punish; `redmart.lazada.sg/catalog/?q=...` does not.** Same `&m=redmart` query, same session, same proxy — only the subdomain matters. The global Lazada header search box at `redmart.lazada.sg/` submits to `www.lazada.sg/catalog/`, so **do not** use the in-page searchbox to drive search; construct the `redmart.lazada.sg/catalog/?q=...` URL directly. Verified: a residential-proxy session hitting `https://www.lazada.sg/catalog/?q=milk&m=redmart` lands on `https://www.lazada.sg//catalog//_____tmd_____/punish?x5secdata=...` with empty title. The same session loads `https://redmart.lazada.sg/catalog/?q=milk&m=redmart` to the full product grid in <3s.
- **A SG residential proxy is mandatory.** Set `proxy: { proxy: "residential", proxyCountry: "sg" }` on every `browserless_agent` call. Without it (datacenter or non-SG exit IP) you may pass the homepage but fail on search/category navigation, and Akamai punishes on the crossover to `www.lazada.sg`.
- **A plain HTTP GET returns an empty JS shell.** The catalog page is a server-side React/Vue render — `RedmartProductTile-*` markup is injected by a deferred script after page-load. A plain HTTP GET (even through a residential proxy) returns the ~66 KB bootstrap shell with 0 product tiles. The real-browser path is required. There is no public Lazada/RedMart search API discoverable from the page (no `mtop`/`acs-m.lazada.sg` JSON XHR carries the result set in the observed traffic; product data is hydrated from inline HTML, not fetched).
- **The in-page searchbox is a trap.** `[searchbox: Search in RedMart]` + `[button: SEARCH]` submit to `https://www.lazada.sg/catalog/?q=...` — i.e. the punish-triggering URL. Pressing Enter in the box also no-ops (the form action runs but the navigation is intercepted/dropped). Always build the URL yourself with `redmart.lazada.sg/catalog/?q=...&m=redmart`.
- **Search pagination has ~80% SKU overlap between consecutive pages.** Verified for `q=milk`: page 1 and page 2 share 32 of 40 SKUs. Lazada's grid re-displays "boosted" / sponsored / top-seller tiles on every page, so naïve scraping of pages 1–N grossly over-counts. Dedupe by `pdp-i{itemId}-s{skuId}` and stop on plateau. The advertised total ("4107 items" for `milk`) is the catalog count — you will only realistically retrieve a few hundred unique SKUs even at page 102.
- **Unit price (`/L`, `/kg`, `/100g`) is only shown for ~25–30 % of tiles.** Don't treat absence as failure; the field is genuinely absent in the HTML for the rest. When needed, compute it client-side from `RedmartProductTile-weight` × `RedmartProductTile-price`.
- **Pack-size string varies wildly.** `"1 L"`, `"500 g"`, `"24 × 200 ml"`, `"12 × 1 L"`, `"1 Per Pack"`, `"76 g"`. Treat it as opaque text; only parse if downstream needs structured grams/ml.
- **Product detail URLs live on `www.lazada.sg`, not `redmart.`.** Tile hrefs all point to `//www.lazada.sg/products/pdp-i{itemId}-s{skuId}.html?…`. These direct-navigation URLs are NOT punish-protected — verified that a `goto` on a tile URL renders the PDP normally. Only the `www.lazada.sg/catalog/?q=…` search endpoint is blocked.
- **Locale cookie is `hng=SG|en-SG|SGD|702`.** Set automatically on first navigation. No need to set it manually.
- **Currency is SGD throughout.** All prices are S$. The page rendering uses `$`rather than`S$`or`SGD` — adjust display if your output needs a currency symbol.
- **No country/region gate observed on `redmart.lazada.sg/` with a SG-region residential proxy.** The country picker has not been seen even on first visit; verified in iter-1 with no cookies set.
- **The `html` command output is JSON-escaped** (the command returns the body markup as a JSON string, so the inner string has `\"` in place of `"`). Account for this when writing regexes over the returned HTML — match `\\"` not `"`.

## Expected Output

```json
{
  "success": true,
  "query": "milk",
  "category": null,
  "sort": "priceasc",
  "page": 1,
  "page_size": 40,
  "total_results": 4107,
  "products": [
    {
      "name": "Want want Flavoured Milk 245ML",
      "pack_size": "245 ml",
      "price_sgd": 1.21,
      "original_price_sgd": null,
      "unit_price": null,
      "promo_badge": null,
      "rating": null,
      "review_count": 0,
      "image_url": "https://sg-test-11.slatic.net/p/abc123.jpg",
      "product_url": "https://www.lazada.sg/products/pdp-i301102812-s527098840.html",
      "item_id": "301102812",
      "sku_id": "527098840",
      "in_stock": true
    },
    {
      "name": "Meiji Fresh Milk 2L",
      "pack_size": "2 L",
      "price_sgd": 6.45,
      "original_price_sgd": 6.97,
      "unit_price": "$3.23/L",
      "promo_badge": "Multiple Promo",
      "rating": 4.92,
      "review_count": 35028,
      "image_url": "https://sg-test-11.slatic.net/p/5e3a9e19730f4604f7d9ca0d1f7c2df2.jpg",
      "product_url": "https://www.lazada.sg/products/pdp-i301102812-s527098840.html",
      "item_id": "301102812",
      "sku_id": "527098840",
      "in_stock": true
    }
  ],
  "method_used": "browser",
  "api_endpoint_observed": null,
  "error_reasoning": null
}
```

Distinct outcome shapes:

```json
// Empty / no results
{ "success": true, "query": "xyzzzzzz", "total_results": 0, "products": [], "method_used": "browser" }

// Anti-bot wall hit (caller used www.lazada.sg/catalog/?q=…)
{ "success": false, "reason": "akamai_punish_page",
  "url_after": "https://www.lazada.sg//catalog//_____tmd_____/punish?x5secdata=…",
  "remediation": "Switch host to redmart.lazada.sg/catalog/?q=…" }

// Session not stealthy enough (rare on redmart.* — common if the residential proxy is omitted or non-SG)
{ "success": false, "reason": "session_blocked",
  "remediation": "Retry with proxy: { proxy: 'residential', proxyCountry: 'sg' } on the browserless_agent call" }

// Category browse (no query)
{ "success": true, "query": null, "category": "shop-groceries-fresh-produce",
  "sort": "popularity", "total_results": 1088, "products": [ … ] }
```
