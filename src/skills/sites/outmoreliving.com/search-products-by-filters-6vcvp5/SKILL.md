---
name: search-products
title: Outmore Living Product Search
description: >-
  Search Outmore Living's catalog by product type (chaise, sofa, lounge chair,
  ottoman, side table), Solerno collection, and price range. Returns name, SKU,
  price, materials (teak, Sunbrella, HeatTech, ComfortCore), availability, and
  product URL via the public Shopify storefront JSON endpoints.
website: outmoreliving.com
category: ecommerce
tags:
  - ecommerce
  - shopify
  - outdoor-furniture
  - search
  - catalog
source: 'browserbase: agent-runtime 2026-05-19'
updated: '2026-05-19'
recommended_method: api
alternative_methods:
  - method: browser
    rationale: >-
      Used only as fallback when the Shopify JSON endpoints (products.json,
      collections/{handle}/products.json, search/suggest.json) return 5xx. The
      browser path costs ~50× more tokens and cannot return per-variant SKU +
      availability without a click-through per product.
verified: false
proxies: true
---

# Outmore Living Product Search

## Purpose

Search the Outmore Living catalog (outmoreliving.com) and return matching products filtered by **type** (chaise, sofa, lounge chair, ottoman, side table, accent pillow), **collection** (Solerno), and **price range**. For each product return: name, SKU, price, materials (teak, Sunbrella, HeatTech, ComfortCore), availability, and product page URL. Read-only — never add to cart, never check out.

## When to Use

- Daily / weekly catalog monitoring (price drops, restocks of `Solerno Heated *` SKUs).
- Cross-shopping outdoor furniture by type or material — e.g. "all teak + Sunbrella chaises under $4000."
- Any flow that would otherwise scrape `outmoreliving.com/collections/...` HTML — the Shopify JSON endpoints are unauthenticated, uncached at the IP level, and return everything you'd otherwise parse out of rendered HTML.

## Workflow

Outmore Living runs on stock Shopify. **Do not browse the site to enumerate products** — three public JSON endpoints expose the entire catalog with no auth, no cookies, no anti-bot stealth, no rate limiting that we hit, and no residential-proxy requirement (we ran a residential-proxy HTTP fetch only out of caution; bare HTTP works equally well). The browser fallback exists for the rare case where Shopify's JSON endpoints are temporarily 5xx-ing.

### 1. Pull the catalog

Three endpoints, pick the one matching your scope:

| Scope                                 | URL                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Entire catalog                        | `https://outmoreliving.com/products.json?limit=250`                                    |
| Solerno collection only               | `https://outmoreliving.com/collections/the-solerno-collection/products.json?limit=250` |
| Any other collection (see list below) | `https://outmoreliving.com/collections/{handle}/products.json?limit=250`               |

All return HTTP 200 with `application/json`. The catalog is small (37 published products, ~580 KB at `limit=250`), so paginate only if a future expansion overflows 250 items: append `&page=2`, `&page=3`, … until you get `{"products":[]}`.

To enumerate collections (handle + display title + product count):

```
GET https://outmoreliving.com/collections.json?limit=250
```

Current handle list (verified 2026-05-19):
`accessories`, `all`, `apparel` (empty), `chairs-ottomans`, `coffee-side-tables`, `customer-favorites`, `dining`, `heated-seating-1`, `heated-seating`, `heated-seating-copy`, `heated-seating-website-1-copy`, `loveseats-sofas`, `new-arrivals`, `power-bars-chargers`, `protective-covers`, `sets`, `heated-seating-dec-2025-copy`, `social-lander-individual-products-copy`, **`the-solerno-collection`** (17 products).

### 2. Filter client-side

Map the user's requested filters onto the response shape:

**Type → `product.product_type`** (canonical enum observed in catalog):

| User request  | Catalog `product_type` value(s)                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chaise        | `"Chaise Lounge"`                                                                                                                                                   |
| sofa          | `"Sofa"`                                                                                                                                                            |
| lounge chair  | `"Chair"` (filter further to titles starting with `Solerno Heated Lounge Chair`)                                                                                    |
| ottoman       | `"Ottoman"`                                                                                                                                                         |
| side table    | `"Side Table"`                                                                                                                                                      |
| accent pillow | **No matches.** The catalog has no pillows. Closest: `"Signature Outdoor Throw"` (no `product_type`). Return `[]` and surface this in your response — do not guess. |

Full observed enum: `Cover, Chair, Chaise Lounge, Table, Set, "" (empty), Ottoman, Protective Cover, Side Table, Coffee Table, Sofa, Loveseat`.

**Collection (Solerno) → two equivalent options:**

- Hit `/collections/the-solerno-collection/products.json` directly (17 products), or
- Filter the full catalog where `product.title.toLowerCase().includes("solerno")` (covers the same 17 + sometimes 1–2 stragglers like `Heated Ottoman` whose title omits the word).

The collection endpoint is canonical — prefer it.

**Price → client-side numeric compare on `variant.price`** (string, parse as Float). Each product has multiple variants (color / fabric / configuration); a product's representative price is `Math.min(...variants.map(v => +v.price))`. For "products under $X," include the product if any variant's price ≤ X.

**Materials → derived from three signals** (in order of reliability):

1. **`product.tags`** — most reliable but sparse. Observed tag vocab: `Heated`, `Sunbrella Fabrics`, `Teak`, `best seller`. Many product types lack tags entirely (covers, throws, accessories).
2. **`variant.option1` / `variant.option2`** — frame material (Teak) appears as `option1` on Solerno furniture; Sunbrella fabric colors (Dove, Aloe, Indigo, Carbon, Seaglass, Java, Bisque, Cast Sand) appear as `option2`.
3. **`product.body_html` substring match** — required for HeatTech and ComfortCore (no tag exists for either; they're proprietary marketing names that appear only in product copy).

```js
function deriveMaterials(p) {
  const tags = new Set(p.tags || []);
  const body = (p.body_html || '').toLowerCase();
  return {
    teak:
      tags.has('Teak') ||
      (p.variants || []).some((v) => v.option1 === 'Teak') ||
      body.includes('teak'),
    sunbrella: tags.has('Sunbrella Fabrics') || body.includes('sunbrella'),
    heattech: tags.has('Heated') || body.includes('heattech'), // proxy: Heated tag ≈ HeatTech presence
    comfortcore: body.includes('comfortcore'),
  };
}
```

**Availability → product-level rollup of `variant.available`:**

```js
const available = (p.variants || []).some((v) => v.available === true);
```

A product is "available" if **any** variant is in stock. Per-variant availability is also exposed in the response if you need color-level granularity.

### 3. Construct the product URL

`https://outmoreliving.com/products/{product.handle}` — no query string needed. Optionally append `?variant={variant.id}` to deep-link to a specific color / configuration.

### 4. Emit the result

See **Expected Output** below.

### Browser fallback (only if `products.json` returns 5xx)

Render the collection page with a stealth + residential-proxy session and parse the cards in-page. There is no session-release step — nothing to release. The session persists across calls, keyed by `proxy`/`profile`, so repeat the same `proxy` to stay in it; batching nav + extract into a single `browserless_agent` call's `commands` array just saves round-trips.

```jsonc
// browserless_agent
{
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://outmoreliving.com/collections/the-solerno-collection?sort_by=price-ascending",
        "waitUntil": "load",
        "timeout": 45000,
      },
    },
    {
      "method": "waitForSelector",
      "params": {
        "selector": ".product-card, .grid__item, [id^=product-grid]",
        "timeout": 10000,
      },
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(() => { const cards = [...document.querySelectorAll('.product-card, .grid__item')]; return JSON.stringify(cards.map(c => { const a = c.querySelector('a[href*=\"/products/\"]'); const priceEl = c.querySelector('.price, [class*=price]'); const img = c.querySelector('img'); return { title: (c.querySelector('.product-card__title, .full-unstyled-link, h3')?.textContent || '').trim(), url: a ? new URL(a.getAttribute('href'), location.origin).href : null, price: (priceEl?.textContent || '').replace(/\\s+/g,' ').trim(), imageAlt: img?.getAttribute('alt') || '' }; }).filter(p => p.url)); }())",
      },
    },
  ],
}
```

The `evaluate` result comes back under `.value` as a JSON string: each card yields product title, product URL, a `price` string (which carries the "From $X" range when variants differ), and image alt-text. **SKU + per-variant availability are not on the collection grid** — they require a follow-up `goto`/`evaluate` on each product page (or, better, just retry the JSON endpoint after a backoff). If the collection page itself trips Cloudflare (a challenge interstitial rather than the grid), prepend a `{ "method": "solve", "params": { "type": "cloudflare" } }` command before the extract.

The browser path costs ~50× more tokens than the JSON path and still cannot return per-variant SKU/availability without a click-through per product. Use only when the JSON endpoint is genuinely down.

## Site-Specific Gotchas

- **`/products.json` returns 37 products; the `all` collection lists 41.** Difference = unpublished / draft products that the storefront hides but `/collections/all/products.json` exposes through whatever publishing rule Shopify is currently applying. For agent-facing answers, prefer the customer-visible count from `/products.json`. If you need the truly canonical inventory, hit `/collections/all/products.json`.
- **The single-product endpoint `/products/{handle}.json` does NOT include `available` on variants.** Field `available` is present on the **list** endpoint (`/products.json` and `/collections/.../products.json`) and the **search** endpoint (`/search/suggest.json`), but absent from the single-product detail JSON. **For availability, never rely on the single-product endpoint alone** — fetch the list endpoint or call `/products/{handle}/variants.json` separately.
- **Accent pillows do not exist in the catalog.** A search query for `pillow` or `accent` via `/search/suggest.json?q=...` returns 0 products. The closest match is the `Signature Outdoor Throw`. When asked for accent pillows, return an empty array plus a `notes` field explaining the absence — do not silently return the throw as a pseudo-match.
- **Material tags are sparse and inconsistent.** `Teak` tag is only set on the two Solerno dining tables, even though every Solerno chair / chaise / sofa is also teak-framed. **You must combine `tags`, `variant.option1/option2`, and `body_html` substring matching** to identify materials reliably. HeatTech and ComfortCore have no dedicated tags at all — they appear only in `body_html`. The `Heated` tag is a reasonable proxy for HeatTech presence (every Heated product uses HeatTech).
- **SKU format varies by product family.** Solerno furniture SKUs follow `FU-SO-{ITEM-CODE}-{COLOR}` (e.g. `FU-SO-HCL-DOV` = Furniture, Solerno, Heated Chaise Lounge, Dove). Protective covers use `B{nnnnn}.{COLOR}` (e.g. `B00500.STN`). Don't assume one regex — the SKU field is opaque; treat it as a passthrough string.
- **`product_type` is inconsistent vs. title.** `Solerno Heated Lounge Chair` has `product_type: "Chair"` (not `"Lounge Chair"`). To disambiguate "lounge chair" vs. "dining chair" vs. "swivel chair" vs. "bistro chair", **match on title + product_type, not product_type alone**.
- **Multiple near-duplicate collections exist** — `heated-seating`, `heated-seating-1`, `heated-seating-copy`, `heated-seating-website-1-copy`, `heated-seating-dec-2025-copy`, etc. These look like staging / A-B / lander variants the merchant hasn't cleaned up. For canonical Solerno listing, **always use `the-solerno-collection`** (17 products) — the others overlap or duplicate it.
- **Compare-at-price is mostly empty** (`""` or `"0.00"`) on Solerno products. One outlier observed: `Dining Set Protective Cover - Rectangle` has `price: "700.00", compare_at_price: "280.00"` — a likely data-entry error where the fields are reversed. Treat `compare_at_price` as best-effort and never assume it's > `price`.
- **`variants` can contain hidden / draft variants.** Always filter to `available === true` (or fall back to `inventory_management === "shopify"`) before counting "in stock."
- **No residential-proxy or stealth required.** a direct HTTP fetch without a residential proxy works for all JSON endpoints in repeated testing. The site is Cloudflare-fronted but its bot rules don't block the standard Shopify storefront API. Don't waste budget on stealth sessions.
- **Pagination yields empty `{"products":[]}` past the last page** — not 404. Use that as the terminator.
- **Search via `/search/suggest.json?q={term}&resources[type]=product&resources[limit]=10`** returns the same shape as the list endpoint plus a flattened `available`, `price`, `price_min`, `price_max` per product, and a relative `url`. Useful for fuzzy text search across body_html (e.g. `q=ComfortCore` returns every product mentioning the term).

## Expected Output

```json
{
  "query": {
    "types": ["chaise", "sofa"],
    "collection": "Solerno",
    "price_min": 0,
    "price_max": 5000
  },
  "total_matches": 2,
  "notes": [],
  "products": [
    {
      "name": "Solerno Heated Chaise Lounge",
      "product_type": "Chaise Lounge",
      "collection": "the-solerno-collection",
      "url": "https://outmoreliving.com/products/solerno-heated-chaise-lounge",
      "price_min": 3300.0,
      "price_max": 3300.0,
      "currency": "USD",
      "available": true,
      "materials": {
        "teak": true,
        "sunbrella": true,
        "heattech": true,
        "comfortcore": true
      },
      "tags": ["Heated", "Sunbrella Fabrics"],
      "variants": [
        {
          "sku": "FU-SO-HCL-DOV",
          "title": "Teak / Dove",
          "price": "3300.00",
          "available": true
        },
        {
          "sku": "FU-SO-HCL-ALO",
          "title": "Teak / Aloe",
          "price": "3300.00",
          "available": true
        },
        {
          "sku": "FU-SO-HCL-IND",
          "title": "Teak / Indigo",
          "price": "3300.00",
          "available": true
        },
        {
          "sku": "FU-SO-HCL-CBN",
          "title": "Teak / Carbon",
          "price": "3300.00",
          "available": true
        },
        {
          "sku": "FU-SO-HCL-SGS",
          "title": "Teak / Seaglass",
          "price": "3300.00",
          "available": true
        },
        {
          "sku": "FU-SO-HCL-JVA",
          "title": "Teak / Java",
          "price": "3300.00",
          "available": true
        },
        {
          "sku": "FU-SO-HCL-BQE",
          "title": "Teak / Bisque",
          "price": "3300.00",
          "available": true
        },
        {
          "sku": "FU-SO-HCL-CSD",
          "title": "Teak / Cast Sand",
          "price": "3300.00",
          "available": true
        }
      ]
    },
    {
      "name": "Solerno Heated Sofa",
      "product_type": "Sofa",
      "collection": "the-solerno-collection",
      "url": "https://outmoreliving.com/products/solerno-heated-sofa",
      "price_min": 4800.0,
      "price_max": 4800.0,
      "currency": "USD",
      "available": true,
      "materials": {
        "teak": true,
        "sunbrella": true,
        "heattech": true,
        "comfortcore": true
      },
      "tags": ["Sunbrella Fabrics"],
      "variants": [/* … */]
    }
  ]
}
```

**Empty-result shape** (e.g. `accent pillow` request):

```json
{
  "query": {
    "types": ["accent pillow"],
    "collection": null,
    "price_min": null,
    "price_max": null
  },
  "total_matches": 0,
  "notes": [
    "Outmore Living's catalog contains no accent pillows. The closest item is 'Signature Outdoor Throw' (handle: signature-outdoor-throw). Returning empty result set."
  ],
  "products": []
}
```

**Sort options** (Shopify-supported, pass through as `?sort_by=` on collection URLs or sort client-side after JSON fetch):
`manual`, `best-selling`, `title-ascending`, `title-descending`, `price-ascending`, `price-descending`, `created-ascending`, `created-descending`.
