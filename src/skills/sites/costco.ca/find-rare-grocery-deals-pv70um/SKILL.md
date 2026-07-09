---
name: find-rare-grocery-deals
title: Find Rare Grocery Deals on Costco.ca
description: >-
  Return the current Costco Canada Warehouse Savings (instant-savings) catalog
  of grocery and household items via the Instacart-powered sameday.costco.ca
  surface — each item's sale price, savings, regular price, Instacart+
  subscriber price, pack size, and product URL. Read-only.
website: costco.ca
category: grocery
tags:
  - costco
  - grocery
  - deals
  - savings
  - instacart
  - canada
source: 'browserbase: agent-runtime 2026-05-24'
updated: '2026-05-24'
recommended_method: browser
alternative_methods: []
verified: false
proxies: true
---

# Find Rare Grocery Deals on Costco.ca

## Purpose

Return the current list of grocery items on instant-savings/markdown promotion on Costco Canada, with each item's sale price, savings amount, regular price, Instacart+ subscriber price, pack size, and canonical product URL. "Rare" here means time-limited promotional pricing surfaced on Costco's "Warehouse Savings" (a.k.a. weekly savings) collection — the same set of items printed in the in-warehouse savings booklet. Read-only; never adds to cart, never checks out.

**Important framing**: Costco Canada's "online grocery" is _not_ the main `www.costco.ca` shop site — it is the Instacart-powered same-day delivery surface at `sameday.costco.ca`, and that is where the deals catalog actually lives in machine-parseable form. The flag-ship `www.costco.ca/coupons.html`, `/online-offers.html`, `/executive-coupons.html`, and `/grocery-household.html` URLs are all Akamai-blocked at the edge (verified 2026-05-24, see Gotchas) and cannot be used.

## When to Use

- A weekly digest of all Costco CA grocery items currently on instant-savings.
- "What's on sale at Costco Canada in [category] right now?" — filterable by Bakery, Meat & Seafood, Deli & Dairy, Snacks & Candy, Produce, Frozen, Beverages, Ready Meals, Pantry, Household, etc.
- "Is item X currently discounted on Costco CA?" — point-lookup against the savings list.
- Price-tracking / clearance-monitoring agents that want a stable scrape target without member auth.
- **Do not use** for in-warehouse-only coupons (these require a logged-in member view of `costco.ca/coupons.html`, which the public surface blocks).

## Workflow

The fully-public catalog of deals lives at `https://sameday.costco.ca/store/costco-canada/collections/rc-weekly-savings`. This subdomain is **not Akamai-protected** the way `www.costco.ca` is — a plain cookieless `browserless_agent` session (no stealth, no proxy) reaches it fine, though a residential proxy is recommended for regional postal-code accuracy. The page is JS-rendered with virtualized scroll: each scroll batch surfaces ~16 product cards.

A residential-proxy session is still the safer default because Costco/Instacart geo-derive a delivery postal code from the request IP (Toronto proxy → `M4V 2H7`, Montreal proxy → `H3A 3J5`), which affects which warehouse's pricing surfaces.

### 1. Session setup

Drive the whole scrape as a single `browserless_agent` call whose `commands` array runs goto → hydrate → scroll-batch → extract, so the virtualized-scroll state persists (the session persists across calls, keyed by `proxy`/`profile`, so batching just saves round-trips). Set `proxy: { proxy: "residential", proxyCountry: "ca" }` on the call so the auto-assigned postal code is Canadian. Stealth is _not_ required for `sameday.costco.ca` (different protection profile than `www.costco.ca`).

### 2. Open the Warehouse Savings collection

```json
{ "method": "goto",          "params": { "url": "https://sameday.costco.ca/store/costco-canada/collections/rc-weekly-savings", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 5000 } }
```

Confirm you're on the right page with an `evaluate` returning `document.title` — expected: `Warehouse Savings Same-Day Delivery | Costco`.

Variants of this URL surface other deal-style collections; use the same scraping pattern on whichever fits:

| Collection slug            | What it shows                                                      |
| -------------------------- | ------------------------------------------------------------------ |
| `rc-weekly-savings`        | Instant-savings booklet items (the canonical deals page)           |
| `rc-new`                   | What's New (new arrivals, includes new-pricing items)              |
| `rc-popular-products`      | Most Popular (orthogonal to deals; mix of full-price + discounted) |
| `n-meat-seafood-61099`     | Meat & Seafood department; items on sale are tagged inline         |
| `n-bakery-9891`            | Bakery                                                             |
| `n-deli-dairy-20958`       | Deli & Dairy                                                       |
| `n-snacks-candy-95695`     | Snacks & Candy                                                     |
| `n-produce-42645`          | Produce                                                            |
| `n-frozen-252`             | Frozen                                                             |
| `n-beverages-8571`         | Beverages                                                          |
| `n-ready-meals-12961`      | Ready Meals                                                        |
| `n-pantry-57025`           | Pantry                                                             |
| `n-household-89386`        | Household (non-grocery, but on the same surface)                   |
| `n-cleaning-laundry-20688` | Cleaning & Laundry                                                 |

The `rc-` prefix is for Costco/Instacart-curated collections; the `n-...-<numeric-id>` prefix is for permanent department taxonomies. Department IDs are stable across runs — keep this table local rather than re-scraping the storefront nav each time.

### 3. Lazy-load by scroll, then dump the rendered markdown

```json
{ "method": "scroll",        "params": { "direction": "down" } },
{ "method": "waitForTimeout", "params": { "time": 2000 } },
{ "method": "scroll",        "params": { "direction": "down" } },
{ "method": "waitForTimeout", "params": { "time": 2000 } },
{ "method": "scroll",        "params": { "direction": "down" } },
{ "method": "waitForTimeout", "params": { "time": 3000 } }
```

Each scroll batch loads ~16 more cards. After three batches you reliably get 60+ cards; append more `scroll` + `waitForTimeout` pairs until the catalog is exhausted. To detect the end, run an `evaluate` that counts unique product URLs — `new Set([...document.querySelectorAll('a[href*="/store/costco-canada/products/"]')].map(a=>a.getAttribute('href'))).size` — and stop when two consecutive scroll-and-count passes return the same number.

### 4. Parse product cards

Pull the cards in-page with an `evaluate` that returns, per product anchor, its `innerText` plus its `href` (this replaces the old markdown dump — `text` alone would drop the URLs):

```json
{
  "method": "evaluate",
  "params": {
    "content": "(()=>JSON.stringify([...document.querySelectorAll('a[href*=\"/store/costco-canada/products/\"]')].map(a=>({text:a.innerText,url:a.getAttribute('href')}))))()"
  }
}
```

Each card's `text` is one long line with this consistent shape:

```
Current price: $1,203.29$120329$260 off (reg. $1,463.29) for non-Instacart+$1195.29 (reg. $1455.29) for Instacart+<Product Name><Pack Size>
```

Regex for the core fields (run over the whole markdown blob):

```python
PATTERN = re.compile(
    r'Current price: \$([\d,]+\.\d{2})\$\d+'
    r'\$([\d,]+) off \(reg\. \$([\d,]+\.\d{2})\) for non-Instacart\+'
    r'\$([\d,]+\.\d{2}) \(reg\. \$([\d,]+\.\d{2})\) for Instacart\+'
    r'(.+)$',
    re.DOTALL
)
# Groups: (sale_price, discount, regular_price, instacart_plus_price,
#          instacart_plus_regular, name_and_pack)
```

Run this over each card's `text`; the canonical `product_url` is the card anchor's `href` (prefix with `https://sameday.costco.ca` if relative), returned alongside the text by the `evaluate` above. Pack size (e.g. `1 each`, `8 x 1 kg`, `18 ct`) is the last token of `name_and_pack` and can be split off with a secondary regex `r'(.+?)((?:\d+ ?x ?)?\d+(?: ct| each| kg| g| L| mL))$'`.

To produce **grocery-only** results, filter the parsed list by URL slug — items whose slug contains a grocery department's product-id namespace (visible in product slugs as numeric prefixes that overlap with the department IDs above) or, more robustly, by visiting one of the grocery department collections in step 2 and applying this same parser. The `rc-weekly-savings` page is a department-mixed firehose; if the consumer wants only food items they will need to filter client-side or run the parser per-department.

### 5. Sort options (optional)

The collection page header exposes a Sort dropdown with five options: `Best match` (default), `Price: Lowest First`, `Price: Highest First`, `Unit Price: Low First`, `Unit Price: High First`, `Relevance`. To switch sort, issue a `click` on the Sort button then a `click` on the chosen option (confirm the option's selector via a `snapshot` if it isn't obvious) — the URL does _not_ reflect sort state, so the change must be done via the rendered UI before scraping. For "biggest discount first," sort `Price: Highest First` and re-parse; the parsed `discount` field is also already in the card text so you can sort client-side post-extraction without touching the UI.

### 6. Session teardown

No session-release step — there's nothing to release. The session persists across calls, keyed by `proxy`/`profile` (repeat the same `proxy` to reconnect to the same warmed browser; drop or change it and you land in a different, blank session). Batching the whole goto → scroll → extract flow inside one call's `commands` array saves round-trips and keeps the virtualized-scroll state (and any sort/filter toggle) together in one run.

### Browser fallback for `www.costco.ca`

If a future requirement forces the main-site path (e.g., to read in-warehouse-only coupons that don't surface on `sameday.`), the only reliable entry point as of 2026-05-24 is the **homepage** at `https://www.costco.ca/`. The homepage renders the "spring deals" / "weekly top picks" / "online deals" promo carousels inline with full deal-card markup matching `<sale-price> After $<X> OFF was $<original-price>`. Extract the rendered body (`html` or `snapshot`), parse the carousel groups, and stop there — every other deal URL (`/coupons.html`, `/online-offers.html`, `/grocery-household.html`, `/s?keyword=OFF&dept=...`) returns Akamai `Access Denied` even after a clean homepage warm-up, even with stealth + residential proxy, and even after clicking through from the homepage's own navigation. Do not waste turns on these.

## Site-Specific Gotchas

- **`www.costco.ca` deal pages are hard-blocked by Akamai.** `/coupons.html`, `/online-offers.html`, `/executive-coupons.html`, `/grocery-household.html`, `/treasure-hunt.html`, `/offers-ending.html`, `/whats-new.html`, `/in-the-warehouse.html`, and `/s?...` search URLs all return `Access Denied` (Akamai reference id pattern `errors.edgesuite.net/...`) even with stealth + residential proxy and warmed homepage cookies. Clicking the same links from the rendered homepage produces the same denial — it is URL-pattern-based, not heuristic. **Do not retry**; use `sameday.costco.ca` instead.
- **`sameday.costco.ca` is a separate, Instacart-operated subdomain** and is _not_ under the same Akamai policy as `www.costco.ca`. It accepts cookieless visits, no stealth required. The footer of every page reads "Powered by Instacart" — that is your signal you are on the right surface.
- **Postal code is IP-derived, not URL-controllable.** The site auto-assigns a delivery postal code from the request IP (Toronto proxy → `M4V 2H7`, Montreal proxy → `H3A 3J5`). To target a specific warehouse's prices, change the proxy region — there is no `?postal=` query override that survives navigation. The postal code shapes which delivery window is offered but the published Warehouse Savings collection itself appeared to surface the same SKUs across both Toronto and Montreal proxies in our tests (the same instant-savings booklet is national).
- **Two prices per item — Instacart+ vs non-Instacart+.** Every deal card carries _both_ a regular shopper price (`$<X> off (reg. $<Y>) for non-Instacart+`) and a discounted Instacart+ subscriber price (`$<A> (reg. $<B>) for Instacart+`). Emit both as separate fields; collapsing them produces misleading "savings" numbers that depend on a subscription the user may not have.
- **Virtualized scroll, ~16 cards per batch.** First load surfaces ~16 product cards; each `scroll` (direction down) + `waitForTimeout` adds another ~16. The collection size for Warehouse Savings was 200-300 items in our tests. Loop until the unique-URL count plateaus across two consecutive measurements.
- **`Last Chance` filter is mis-bucketed under "Dietary preference".** On the rc-weekly-savings filters panel, the filter labelled `Last Chance` lives under the `Dietary preference` group alongside `Gluten Free`, `Organic`, `Vegan`. This is an Instacart taxonomy artifact, not a UX bug to work around — checking it scopes results to clearance items. The filter is applied client-side; the URL does not change, so re-scrape after toggling.
- **Sort state is UI-only, not URL-reflected.** Switching sort (`Price: Lowest First`, etc.) does not push a query param. Click → wait → re-scrape.
- **Pack size is in the product card, not a separate field.** Sizes appear as `1 each`, `18 ct`, `8 x 1 kg`, `750 mL`, etc., concatenated to the product name. Use a unit-suffix regex to split.
- **Grocery vs non-grocery on rc-weekly-savings is interleaved.** The Warehouse Savings collection mixes electronics (Sonos, laptops), apparel, and groceries in one list. For grocery-only output, either visit each `n-<grocery-dept>-<id>` collection separately or filter the rc-weekly-savings parse client-side by removing items whose categories you don't want. There is no `?category=` URL filter that works.
- **Confirmed-dead endpoints — do not retry**: `www.costco.ca/coupons.html`, `www.costco.ca/online-offers.html`, `www.costco.ca/executive-coupons.html`, `www.costco.ca/grocery-household.html`, `www.costco.ca/treasure-hunt.html`, `www.costco.ca/offers-ending.html`, `www.costco.ca/in-the-warehouse.html`, `www.costco.ca/s?keyword=OFF*` — all Akamai 403 as of 2026-05-24.
- **No member login is required** for the deal listings on `sameday.costco.ca`. Costco's _purchase_ flow requires membership, but the catalog + prices are unauthenticated. Stop at the listing — never click a product card's `Add` button.
- **Cookie consent banner.** The first visit to `sameday.costco.ca` shows a `Cookie Preferences / Accept All / Review Preferences` banner that overlays the page bottom. It does not block scroll or content extraction, but if you click anywhere in its hit-box you derail your snapshot refs. Either ignore it or click `Accept All Cookies` once to dismiss for the session.

## Expected Output

```json
{
  "source_url": "https://sameday.costco.ca/store/costco-canada/collections/rc-weekly-savings",
  "captured_at": "2026-05-24T17:43:00Z",
  "postal_code": "H3A 3J5",
  "delivery_window": "2:43-3:13pm",
  "total_items": 247,
  "deals": [
    {
      "name": "Greek Chicken Souvlaki",
      "pack_size": "8 x 1 kg",
      "sale_price_cad": 17.59,
      "regular_price_cad": 21.59,
      "discount_cad": 4.0,
      "discount_pct": 18.5,
      "instacart_plus_price_cad": 16.39,
      "instacart_plus_regular_cad": 20.39,
      "category_guess": "meat-seafood",
      "product_url": "https://sameday.costco.ca/store/costco-canada/products/21021737-ecls16-10t6h-greek-chicken-souvlaki-1-kg",
      "last_chance": false
    },
    {
      "name": "Pom® Original Large Tortillas",
      "pack_size": "18 ct",
      "sale_price_cad": 4.69,
      "regular_price_cad": 6.69,
      "discount_cad": 2.0,
      "discount_pct": 29.9,
      "instacart_plus_price_cad": 4.39,
      "instacart_plus_regular_cad": 6.39,
      "category_guess": "bakery",
      "product_url": "https://sameday.costco.ca/store/costco-canada/products/25958340-pom-10-original-tortillas-18-ct",
      "last_chance": false
    }
  ]
}
```

When no grocery items match the user's category filter, return:

```json
{
  "source_url": "https://sameday.costco.ca/store/costco-canada/collections/rc-weekly-savings",
  "captured_at": "2026-05-24T17:43:00Z",
  "postal_code": "H3A 3J5",
  "total_items": 247,
  "deals": [],
  "note": "No grocery items currently on Warehouse Savings matched the requested category filter."
}
```

When the deals collection itself returns zero items (rare — typically only at the very start of a new flyer week before the catalog populates):

```json
{
  "source_url": "https://sameday.costco.ca/store/costco-canada/collections/rc-weekly-savings",
  "captured_at": "...",
  "total_items": 0,
  "deals": [],
  "warning": "Warehouse Savings collection is empty. Cross-check the rendered page header — Costco rotates the booklet weekly and the collection can be momentarily empty between flyer cycles."
}
```
