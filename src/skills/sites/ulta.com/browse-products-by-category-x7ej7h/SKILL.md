---
name: browse-products-by-category
title: Ulta Browse Products by Category
description: >-
  Browse Ulta.com by category taxonomy (Makeup, Skin Care, Hair, etc.) instead
  of search. Returns brand, name, price, rating, SKU, URL, image, and badges for
  every product in any category leaf — with URL-param filtering (form, finish,
  brand, price bucket) and server-side sorting.
website: ulta.com
category: shopping
tags:
  - beauty
  - cosmetics
  - shopping
  - catalog
  - read-only
  - akamai
source: 'browserbase: agent-runtime 2026-05-25'
updated: '2026-05-25'
recommended_method: fetch
alternative_methods:
  - method: browser
    rationale: >-
      Browser fallback for the rare case the fetch path is blocked or when an
      agent needs to interact with the live rendered grid. Add a residential
      proxy (proxy:{proxy:"residential",proxyCountry:"us"}) on the
      browserless_agent call — a bare goto can land on Akamai's 'Q R Code'
      verification interstitial. Slower and more expensive than the fetch path,
      which returns the same SSR Apollo state.
  - method: api
    rationale: >-
      Ulta exposes an internal GraphQL endpoint (NonCachedPage queries served
      from istio-envoy at www.ulta.com) but there's no public, documented JSON
      API. The SSR Apollo state inlined into category-page HTML is the practical
      'API' — same data, no auth headers, no persisted-query handshake.
verified: false
proxies: false
---

# Ulta Browse Products by Category

## Purpose

Browse products listed on Ulta.com by **navigating its category taxonomy** (Makeup → Lips → Lipstick, Skin Care → Moisturizers, etc.) instead of using the on-site search box. Returns a structured list of products in any category — brand, product name, list/sale price, rating, review count, SKU, product-detail URL, image URL, variant label, and badges/promo text. Read-only; never adds anything to a bag or wishlist.

## When to Use

- "What lipsticks does Ulta carry?" / "Show me all moisturizers" — taxonomy-first browsing, not keyword search.
- Crawling an entire category for price comparison, brand inventory tracking, or recommendation seeding.
- Pulling the catalog under a narrow leaf category with filters applied (e.g. matte-finish lipsticks under $15).
- Anywhere you'd otherwise scrape Ulta search-result pages — the category route is faster, cheaper, and stable across sessions because the data is server-rendered on the category URL itself.
- **Do NOT use** when the user query is keyword-style ("find the Maybelline Sky High mascara"). Search is the right surface for that; this skill is the wrong tool.

## Workflow

Ulta's category pages are React/Apollo apps **but** the first 64 products of each category are server-side-rendered into a `window.__APOLLO_STATE__` blob inside the HTML. That means a single `browserless_agent` `goto` — no login, no cookies, and (usually) no proxy — lands on a page whose `window.__APOLLO_STATE__` you can read directly with one `evaluate`. Filters and pagination compose cleanly via URL query params. Lead with this lightweight goto+evaluate path; the interactive-snapshot path is a fallback for when an unknown filter/sort doesn't take effect or you need to poke the live rendered grid.

### 1. Discover categories

The full category taxonomy is in `https://www.ulta.com/l/category_filter_sitemap.xml` (~1.5 MB, ~247 distinct base category paths plus many filter-variant URLs). Categories nest up to three levels deep:

```
https://www.ulta.com/shop/<top>                       ← landing page (curated, ~12 products)
https://www.ulta.com/shop/<top>/all                   ← full grid of every product in <top>
https://www.ulta.com/shop/<top>/<sub>                 ← e.g. /shop/makeup/lips
https://www.ulta.com/shop/<top>/<sub>/<leaf>          ← e.g. /shop/makeup/lips/lipstick
```

Top-level slugs observed: `makeup`, `skin-care`, `hair`, `fragrance`, `body-care`, `tools-brushes`, `k-beauty`, `men`, `luxury-at-ulta-beauty`, `wellness-by-ulta-beauty`, `travel-size-mini`, `gifts`.

To enumerate sub-categories of an unknown top-level, navigate to the sitemap and parse the `<loc>` URLs in-page. One `browserless_agent` call:

```json
{
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.ulta.com/l/category_filter_sitemap.xml",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ const txt = document.body.innerText || document.documentElement.textContent || ''; const m = txt.match(/<loc>[^<]+<\\/loc>/g) || []; const urls = m.map(x=>x.slice(5,-6)).filter(u=>u.startsWith('https://www.ulta.com/shop/makeup/') && !u.includes('?')); return JSON.stringify(urls); })()"
      }
    }
  ]
}
```

Swap the `makeup/` prefix in the filter for whichever top-level slug you're enumerating. (If the sitemap is served as raw XML the browser may wrap it in its XML viewer — reading `document.body.innerText`/`textContent` still yields the `<loc>` text to regex.)

### 2. Load the category page (no proxy) and read the Apollo state

```json
{
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.ulta.com/shop/makeup/lips/lipstick",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ const s = window.__APOLLO_STATE__; return JSON.stringify({ title: document.title, present: !!s, state: s }); })()"
      }
    }
  ]
}
```

A plain `goto` (no proxy) is enough — the page ships the SSR'd Apollo state inline and `window.__APOLLO_STATE__` is populated on `load`. Only escalate to a residential proxy (`proxy: { proxy: "residential", proxyCountry: "us" }`) if the goto lands on Akamai's `<title>Q R Code</title>` interstitial. In a real browser you read `window.__APOLLO_STATE__` directly (no HTML string-parsing needed); the brace-balanced `extractApolloState` extractor in step 3 is kept only as a fallback for when you have raw HTML instead of a live page. The return payload can be large — project to just the product cards inside the `evaluate` (see step 3) rather than returning the whole state blob (text return is capped ~200k chars).

Read these two facts before parsing:

- **Total product count**: read `document.title` — `<title>Lipstick - Makeup - <COUNT> Products | Ulta Beauty</title>`. Also surfaces as `<COUNT> Products` in the body text. Use this to plan pagination.
- **Per-page size**: always `64` (`"pageSize":64` in the Apollo state). Compute `Math.ceil(total / 64)` to know how many pages to walk.

### 3. Walk `window.__APOLLO_STATE__` for products

On a live page loaded via `goto`, do the walk inside the `evaluate`: read `window.__APOLLO_STATE__` directly and return only the projected product cards. The brace-balanced `extractApolloState` extractor below is a fallback for the case where you're handed raw HTML (e.g. a cached response) rather than a live page — the state is assigned as `window.__APOLLO_STATE__ = { ... };` in a `<script>` tag, and the value can contain string-literal braces, so use a depth counter that respects double-quoted strings:

```js
function extractApolloState(html) {
  const marker = html.indexOf('window.__APOLLO_STATE__');
  const eq = html.indexOf('=', marker);
  let depth = 0,
    inStr = false,
    esc = false,
    started = false,
    end = -1;
  for (let i = eq; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      depth++;
      started = true;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return JSON.parse(html.slice(eq + 1, end).trim());
}
```

Then walk `apollo.ROOT_QUERY[<the only key that starts with "Page(">]` recursively, collecting every object that has **both** `productName` and `brandName` keys — those are the product cards. Each card has this shape (full key list):

```
{
  brandName, productName, productId, skuId,
  image: { imageUrl, ... },
  listPrice, salePrice, discount, kitPrice, priceLabel, promoText,
  rating, reviewCount, reviewAccessibilityLabel,
  variantLabel, badge, badgeTags, productCardTags,
  sponsored, isLimitedStock, bookmarked,
  action: { url, ... },                ← canonical product-detail URL
  addToBagAction, viewOptionAction, bookmarkAction, removeBookmarkAction,
  dataCapture: { ... }, dataCaptureData: { dataLayer: { Tealium: { ... } } }
}
```

The canonical product-detail URL is at `card.action.url`, shaped like `https://www.ulta.com/p/<slug>-<productId>?sku=<skuId>` (e.g. `https://www.ulta.com/p/macximal-silky-matte-lipstick-pimprod2043558?sku=2635484`). Image CDN URLs follow `https://media.ultainc.com/i/ulta/<skuId>`.

### 4. Paginate

Append `?page=N` (1-indexed; `?page=1` is identical to the bare URL):

```
https://www.ulta.com/shop/makeup/lips/lipstick?page=2
https://www.ulta.com/shop/makeup/lips/lipstick?page=3
...
```

Walk pages until you've collected ≥ `total` products (the last page returns `total mod 64` products, not a full 64). Verified: lipstick category with `total=217` returned `64 + 64 + 64 + 25 = 217` across 4 pages.

### 5. Apply filters and sort via URL params (optional)

Filters compose with each other and with `?page=N`. Pass them as query args — server returns a smaller, filtered Apollo state with its own correct count.

| Param       | Example values                                                                     | Notes                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sort`      | `best_sellers` _(default)_, `price_asc`, `price_desc`, `top_rated`, `new_arrivals` | **Use `sort=`, not `sortBy=`.** `sortBy=` is silently ignored — products come back in default order.                                                        |
| `finish`    | `matte`, `cream`, `glitter`, `high+shine`, `metallic`, ...                         | URL-encoded; spaces become `+`.                                                                                                                             |
| `form`      | `liquid`, `cream`, `gel`, `stick`, `aerosol`, `balm`, `serum`, `lotion`, ...       |                                                                                                                                                             |
| `skin+type` | `combination`, `dry`, `normal`, `oily`, `sensitive`, `all`                         | Literal space in key — encoded as `skin+type` in the URL.                                                                                                   |
| `brand`     | brand-slug (e.g. `mac`, `nyx-professional-makeup`)                                 | Discoverable from the facet rail; multiple brands as repeated param.                                                                                        |
| `price`     | `under-15`, `15-25`, `25-50`, `50-100`, `over-100`                                 | (Verified-by-pattern from facet URLs. **`priceRange=0-15` does NOT work** — the param name is `price` and the values are bucket slugs, not min-max ranges.) |
| `page`      | `2`, `3`, ...                                                                      | 1-indexed; combines with everything above.                                                                                                                  |

Compose freely: `?finish=matte&sort=price_asc&page=2` is valid and the server returns the correct filtered+sorted+paginated subset. Verified: `?finish=matte` reduced lipstick from 217 → 117 and the title even updated to "Matte Lipstick - 117 Products". Filter param names match the URLs harvested from `/l/category_filter_sitemap.xml` — when in doubt, search the sitemap for `?<key>=` to confirm a key exists.

### Interactive-snapshot fallback

Use only when the goto+evaluate path is genuinely blocked (none observed during 2026-05-25 testing) or when you specifically need to interact with the rendered UI. Batching the whole flow into ONE `browserless_agent` call's `commands` array is the convenient default — it saves round-trips and avoids accidentally dropping the session config — and there's no session to create or release (a later call reusing the same `proxy`/`profile` reconnects to the same session).

1. **A residential proxy is required** for this route: set `proxy: { proxy: "residential", proxyCountry: "us" }` on the call. A no-proxy browser session lands on Akamai's `<title>Q R Code</title>` interstitial that requires app-side verification.
2. `{ "method": "goto", "params": { "url": "<category-url>", "waitUntil": "load", "timeout": 45000 } }` then `{ "method": "waitForTimeout", "params": { "time": 3000 } }` before the snapshot (the product grid renders 1–3s after `load`), then `{ "method": "snapshot" }`.
3. From the snapshot, the product cards expose Add to Bag and a clickable image — **read only**, don't click the bag. (If a card ref is missing, confirm via a fresh `snapshot`.)
4. To paginate, change the URL — the in-page pagination control issues a new GraphQL `NonCachedPage` query whose response is non-trivial to parse, while a `goto` of `.../?page=N` re-renders the same SSR Apollo state you'd read from the goto+evaluate path.

## Site-Specific Gotchas

- **A no-proxy `goto` returns full SSR Apollo state.** Verified across 4 distinct category URLs on 2026-05-25 — anonymous loads return 200 with `window.__APOLLO_STATE__` populated. Only escalate to a residential proxy if a `goto` lands on Akamai's `<title>Q R Code</title>` verification interstitial. A specific page returning `<title>ULTA.com :: Our Apologies</title>` is the "Be Right Back" ESI waiting-room (observed once when hitting `sitemap.xml` directly, never on `/shop/` URLs) — retry that page.
- **Use `sort=` not `sortBy=`.** `?sortBy=price-low-to-high` is silently ignored and the response is unchanged from the default sort. `?sort=price_asc` works. Sort values use underscores (`price_asc`, `best_sellers`, `top_rated`), not hyphens.
- **`priceRange=0-15` does NOT work.** The price filter param is `price=` and takes bucket slugs (`under-15`, `15-25`, etc.) — not a min-max range. If `priceRange=` appears in any URL, it's client-side state and won't affect server-rendered results.
- **`/shop/<top>` (no sub-category) is a curated landing page, not a full grid.** Only ~12 hand-picked products are inlined (`12 items`, "We think you'll like" header). For the complete top-level catalog, use `/shop/<top>/all` — e.g. `/shop/makeup/all` returns 6,657 products (~104 pages) and behaves like a leaf category. Easy to misdiagnose as a broken extractor; double-check the URL has `/all` or a sub-category appended.
- **Page size is always 64.** Hardcoded in the SSR response; no URL param overrides it. Pages 1..N-1 each contain 64 items, the last page contains `total mod 64`.
- **Last page can be empty if `page=N` exceeds the true page count.** Requesting `?page=99` on a 4-page category returns a valid HTML page with the same Apollo skeleton but 0 product cards. Stop walking when an extracted page returns 0 products, even if your computed `Math.ceil(total/64)` was wrong.
- **Sponsored products are mixed into the grid and flagged.** `card.sponsored === true` plus `card.sponsoredBadgeLabel`. Decide whether to include or exclude based on caller intent; default behavior should be to include them and pass the flag through.
- **The page title is the most reliable source for total count.** It's always `"<Leaf> - <Parent> - <N> Products | Ulta Beauty"`. `"<N> Products"` appears multiple times in the body. The Apollo `pageSize:64` is constant but no top-level `totalResults`/`totalCount` field surfaces cleanly — parse the title.
- **Don't expect `__INITIAL_STATE__` / `__NEXT_DATA__`.** Ulta uses Apollo Client, so the only inlined data is `window.__APOLLO_STATE__`. Skip the other common SSR markers.
- **JSON-LD on the page only has `BreadcrumbList`** (Home → Makeup → Lips → Lipstick), not `Product` or `ItemList`. Don't bother grepping for `@type":"Product"` — none exist in the SSR.
- **Product entity keys are not on the Apollo cache root** (no `Product:pim...` top-level entries). The data lives nested under `ROOT_QUERY.Page(...).content.modules.[ProductListingResults].productCards[]`. Walk for `{ productName, brandName }` shape, don't look up by entity ID.
- **`fetch` response size is ~2.3–4 MB per category page** (~1.5 MB Apollo state + ~1 MB CSS/JS strings). The brace-balanced extractor takes ~50ms in Node; full extract+walk for 64 products is <200ms wall.
- **Rate limit is permissive but be polite.** No formal block observed during testing, but sustained > 2 req/s starts triggering Akamai friction (occasionally a 503 from the AkamaiNetStorage tier). Keep ≤ 1 req/s across `goto` calls.

## Expected Output

```json
{
  "category_url": "https://www.ulta.com/shop/makeup/lips/lipstick",
  "category_path": ["Home", "Makeup", "Lips", "Lipstick"],
  "filters_applied": { "finish": "matte", "sort": "price_asc" },
  "total_products": 117,
  "page_size": 64,
  "pages_walked": 2,
  "products": [
    {
      "brand": "MAC",
      "name": "M·A·Cximal Silky Matte Lipstick",
      "product_id": "pimprod2043558",
      "sku": "2635484",
      "url": "https://www.ulta.com/p/macximal-silky-matte-lipstick-pimprod2043558?sku=2635484",
      "image_url": "https://media.ultainc.com/i/ulta/2635484",
      "list_price": "$25.00",
      "sale_price": null,
      "discount": null,
      "rating": 4.6,
      "review_count": 1704,
      "variant_label": "46 colors",
      "badge": "",
      "promo_text": null,
      "sponsored": false,
      "is_limited_stock": false
    }
  ]
}
```

Empty-category shape (rare — happens when an over-narrow filter combination matches nothing):

```json
{
  "category_url": "https://www.ulta.com/shop/makeup/lips/lipstick?finish=matte&price=over-100",
  "total_products": 0,
  "page_size": 64,
  "pages_walked": 1,
  "products": []
}
```

Invalid-category shape (the URL doesn't exist in Ulta's taxonomy — the server returns a 200 with an "Our Apologies" or generic 404 body):

```json
{
  "category_url": "https://www.ulta.com/shop/makeup/lips/not-a-real-leaf",
  "error": "category_not_found",
  "products": []
}
```
