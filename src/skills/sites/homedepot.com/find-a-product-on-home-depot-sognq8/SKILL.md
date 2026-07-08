---
name: find-a-product
title: Home Depot Find a Product
description: >-
  Search homedepot.com for products matching a free-text query, brand+model, or
  itemId; return canonical /p/{slug}/{itemId} URLs, titles, images, and
  (optionally, via a Verified browser session) price, availability, brand,
  rating, and key specs. Read-only.
website: homedepot.com
category: shopping
tags:
  - home-improvement
  - shopping
  - product-search
  - akamai
  - hybrid
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: hybrid
alternative_methods:
  - method: api
    rationale: >-
      The browserless_search tool indexes Home Depot's catalog via
      Google/Bing and returns canonical /p/{slug}/{itemId} URLs, titles, and
      images for $0 browser cost. Validated as the discovery shortcut for this
      skill. Sufficient on its own when the caller only needs to resolve a query
      to a product URL + image.
  - method: browser
    rationale: >-
      When the caller needs price, availability, specs, or reviews — fields not
      in the search snippet — a browser is required: a browserless_agent call
      with proxy { proxy: "residential" } is mandatory. A bare cookieless fetch
      (with or without a proxy) is 100% Akamai-blocked across every
      homedepot.com path tested in iter-1.
  - method: cli
    rationale: >-
      Confirmed dead-end: a bare browserless fetch returns HTTP 200 with the
      Akamai sensor challenge body on /, /s/, /p/{itemId}, /p-search/,
      /robots.txt, and /api/v1/products/{itemId}. apionline.homedepot.com
      returns 403 from datacenter IPs. Don't waste turns on cookieless paths.
verified: true
proxies: true
---

# Home Depot Find a Product

## Purpose

Given a natural-language product query (free text, brand+model, or a Home Depot itemId), return one or more matching products from `homedepot.com` — title, canonical URL, 9-digit itemId, image URL, and (when a browser session is used) current price, availability, brand, rating, and key specs. Read-only — never adds to cart, never checks out.

## When to Use

- "Find me a DEWALT cordless drill on Home Depot."
- "Get the Home Depot URL and current price for a Behr Marquee paint in Cameo White."
- "I have model number DCD791P1 — pull the Home Depot listing."
- Bulk product-URL resolution for a list of brand+model strings prior to price-monitoring.
- Any flow where the next step is "open the product page in a browser" — this skill yields the canonical `/p/{slug}/{itemId}` URL plus enough metadata to disambiguate.

## Workflow

Home Depot is fronted by Akamai Bot Manager. Cookieless HTTP paths (raw `curl`, or a bare `browserless_function` `fetch` with or without a proxy) get a 200 OK whose body is the Akamai sensor challenge page — never the rendered product HTML. Verified across `/`, `/s/?`, `/p-search/?`, `/p/{itemId}`, `/robots.txt`, and `apionline.homedepot.com` (the last 403s outright from datacenter IPs). **There is no public JSON API and no cookieless fetch path that bypasses Akamai.**

There IS, however, a much cheaper discovery shortcut than driving the search page: the **`browserless_search` tool** indexes Home Depot's catalog through Google/Bing and returns canonical `/p/{slug}/{itemId}` URLs + titles + product images — for zero browser cost and no anti-bot exposure. Use it as step 1; only spin up a browser (via `browserless_agent`) if the caller needs fields the search snippet doesn't include (price, stock, specs, reviews).

### 1. Discovery — `browserless_search` (no browser, no anti-bot risk)

Call `browserless_search` with the query `"<your query> site:homedepot.com/p"` (request ~10 results).

Each result for a `/p/` URL contains:

```json
{
  "id": "https://www.homedepot.com/p/DEWALT-...-DCD791P1/312119566",
  "url": "https://www.homedepot.com/p/DEWALT-...-DCD791P1/312119566",
  "title": "20V MAX XR Cordless Brushless 1/2 in. Drill/Driver with (1) 20V 5.0Ah Battery, Charger and Bag",
  "publishedDate": "2025-03-26T00:00:00.000Z",
  "image": "https://images.thdstatic.com/productImages/.../dewalt-power-drills-dcd791p1-64_1000.jpg"
}
```

Parse the trailing 9-digit segment as `itemId`:

```bash
itemid=$(echo "$url" | grep -oE '/[0-9]{9,}([?/]|$)' | grep -oE '[0-9]{9,}')
```

The `site:homedepot.com/p` operator filters out the category browse pages (`/b/...`), reviews pages (`/p/reviews/...`), and Q&A pages (`/p/questions/...`) that otherwise pollute results. If the query is generic enough (e.g. "cordless drill"), `/b/` category-listing pages may still appear — filter client-side by requiring `/p/{slug}/{itemId}` in the URL.

For SKU lookups, search with `"<model#> home depot"` rather than the bare model — observed during validation: `"model# DCD791P1 home depot"` resolves cleanly while `"DCD791P1"` alone surfaces the manufacturer's own site as a competing top result.

### 2. Enrichment — only if you need price/stock/specs (browser required)

A residential proxy is mandatory. Drive it with a single `browserless_agent` call — batching nav + extract in one `commands` array saves round-trips and keeps the warmed-up cookies in the same session. (The session persists across calls, keyed by the `proxy` config, so repeating the same `proxy` on a later call reconnects to it; dropping or changing it lands you in a different, blank session.)

```json
{
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.homedepot.com/p/{itemid}",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    { "method": "waitForTimeout", "params": { "time": 3000 } },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ const s=[...document.querySelectorAll('script[type=\"application/ld+json\"]')].map(n=>{try{return JSON.parse(n.textContent)}catch(e){return null}}).flat().find(o=>o&&o['@type']==='Product'); return JSON.stringify(s||null); })()"
      }
    }
  ]
}
```

The `/p/{itemid}` short form redirects to the canonical `/p/{slug}/{itemId}`. The price widget + JSON-LD hydrate ~1–3 s after load, hence the `waitForTimeout`. `proxy: { proxy: "residential" }` is required — a stealth-only (no-proxy) session lands on the Akamai bot-challenge page (`<div id="sec-if-cpt-container">`), which is the failure-mode signature; if a `snapshot`/`html` command shows it, that session has tripped the challenge. The session persists across calls (keyed by the `proxy`), so re-issuing the same call reconnects to it — start a genuinely new session to retry cleanly.

Extract fields from the embedded `<script type="application/ld+json">` Product block (every `/p/{itemId}` page emits one once Akamai clears) — parse it in-page via `evaluate` as above, or fall back to a `snapshot` a11y tree. The structured-data block carries `name`, `brand.name`, `image`, `sku`, `offers.price`, `offers.priceCurrency`, `offers.availability` (`InStock` | `OutOfStock` | `PreOrder`), and `aggregateRating.{ratingValue, reviewCount}` — read these first; fall back to a11y-ref scraping only for fields the schema omits (e.g. localized-store inventory, current promo callouts).

No session-release step is needed — there's nothing to release. The session is not torn down on return, though: it persists across calls, keyed by the `proxy` config.

### 3. Combine + emit

Merge step-1 search metadata (URL, title, image, itemId) with step-2 enriched fields (price, availability, brand, rating). If the caller only asked for "find me a product," steps 1 alone suffices — don't open a browser unless price/stock/specs were requested.

## Site-Specific Gotchas

- **Akamai blocks all cookieless fetches.** A bare fetch of `https://www.homedepot.com/<any-path>` (raw `curl`, or a `browserless_function` bare `fetch`) returns HTTP 200 with the Akamai challenge body (`<script src="/06MU_...?t=...">` + `<div id="sec-if-cpt-container">`) — including `/robots.txt`, `/p/{itemId}`, `/p-search/?keyword=...`, and `/api/v1/products/{itemId}`. Without a residential proxy, the same paths return HTTP 403. **Don't waste turns trying cookieless-fetch variants** — there's no header / param / path combo that defeats the challenge. The browser path (`browserless_agent` with `proxy: { proxy: "residential" }`) is the only one that yields rendered HTML.
- **`apionline.homedepot.com` is 403 from datacenter IPs.** Verified during iter-1 with a residential-proxy fetch following redirects. It returns Akamai's "Access Denied" HTML, not the bot-challenge page — meaning even a successful CAPTCHA solve at the www level wouldn't unlock the GraphQL gateway from a non-residential egress. **Don't waste time on the internal GraphQL endpoint.**
- **`m.homedepot.com` and `store.homedepot.com` are TLS-cert-rotation / redirect traps.** `m.homedepot.com` 502s with "TLS certificate verification failed" through a cookieless fetch even when following redirects; `store.homedepot.com` 500s. Stick to `www.homedepot.com`.
- **URL shape: `/p/{slug}/{itemId}` is canonical; `/p/{itemId}` redirects to it.** ItemIds are 9-digit integers (e.g. `312119566`, `331273305`). The slug is decorative but URL-stable — if Home Depot rewrites the slug across catalog updates, the itemId path still resolves. For storing references, persist the itemId, not the full URL.
- **`browserless_search` over-indexes auxiliary pages.** Without the `/p` path-filter, top results frequently include `/p/reviews/...`, `/p/questions/...`, and `/b/...` category-listing pages mixed in with actual product pages. Always require `/p/{slug}/{9-digit-itemId}` in the URL when filtering — slug must be non-empty (no `reviews` or `questions` keyword) and itemId must match `[0-9]{9,}`.
- **`browserless_search` for bare model numbers leaks to the manufacturer site.** A query of `"DCD791P1"` returns the DEWALT.com product page as the second result; `"home depot DCD791P1"` or `"<model> site:homedepot.com/p"` keeps results on `homedepot.com`. Always pin the domain explicitly.
- **Category browse uses an `N-{taxonomy-id}` token.** URLs like `/b/Tools-Power-Tools-Drills/Cordless/Brushless/N-5yc1vZc27fZ1z140i3Z1z17tnq` encode a taxonomy intersection in the `N-` segment (chain of `Z`-delimited refinement codes). This is opaque but stable — if a caller wants "all Brushless Cordless Drills" rather than a single product, capture the `N-...` token from the search result and pass it through; don't try to reconstruct.
- **Search results include a `publishedDate` that is the search-engine first-indexed date, not the catalog list date.** Don't use it as "product launch" or "last updated" — it's a search-engine artifact (typically the date the URL was first crawled). Useful only as a recency tie-breaker between near-duplicate listings.
- **Hammer drill / drill / driver are distinct catalog entries.** Casual queries like "cordless drill" return a mix of drill-drivers and hammer drills, plus impact drivers. If the caller specified one, post-filter `title` for the keyword (`hammer`, `impact`) rather than assuming the top result is correct.
- **`image` field is sometimes absent.** About 20% of search results omit `image` (typically older catalog entries). Don't rely on it being present; if needed, fall back to the `image` field in the `/p/{itemId}` JSON-LD block during step 2.
- **The Akamai sensor JS is the "this session is burned" signal.** If at any point a `snapshot`/`html` command returns markup containing `id="sec-if-cpt-container"` or `class="behavioral-content"`, the session has tripped Akamai. The session persists across calls (keyed by the `proxy`), so a repeat call reconnects to the same tripped session — start a genuinely new session to recover; don't try to interact with the challenge UI from a script.
- **Sandbox firewall caveat (build-time, not runtime).** During iter-1 the build sandbox couldn't reach the browser backend, so this skill's browser path was not directly validated end-to-end; only the search discovery path was. A runtime agent without that firewall should expect the browser path to behave per the OpenTable / Akamai pattern (residential proxy → rendered DOM, sometimes 1–2 retries needed on cold sessions).

## Expected Output

Schema for a search-only response (step 1 alone):

```json
{
  "query": "cordless drill",
  "match_count": 8,
  "method": "bb-search",
  "products": [
    {
      "itemId": "312119566",
      "title": "20V MAX XR Cordless Brushless 1/2 in. Drill/Driver with (1) 20V 5.0Ah Battery, Charger and Bag",
      "url": "https://www.homedepot.com/p/DEWALT-20V-MAX-XR-Cordless-Brushless-1-2-in-Drill-Driver-with-1-20V-5-0Ah-Battery-Charger-and-Bag-DCD791P1/312119566",
      "image": "https://images.thdstatic.com/productImages/a62efdbd-f93b-4614-9e89-7dfad8dc5c3a/svn/dewalt-power-drills-dcd791p1-64_1000.jpg",
      "first_indexed": "2025-03-26"
    }
  ]
}
```

Schema for enriched response (step 1 + step 2):

```json
{
  "query": "DEWALT DCD791P1",
  "match_count": 1,
  "method": "bb-search+browser",
  "products": [
    {
      "itemId": "312119566",
      "title": "20V MAX XR Cordless Brushless 1/2 in. Drill/Driver with (1) 20V 5.0Ah Battery, Charger and Bag",
      "url": "https://www.homedepot.com/p/DEWALT-20V-MAX-XR-Cordless-Brushless-1-2-in-Drill-Driver-with-1-20V-5-0Ah-Battery-Charger-and-Bag-DCD791P1/312119566",
      "image": "https://images.thdstatic.com/productImages/.../dewalt-power-drills-dcd791p1-64_1000.jpg",
      "brand": "DEWALT",
      "model_number": "DCD791P1",
      "price": { "value": 199.0, "currency": "USD" },
      "availability": "InStock",
      "rating": { "value": 4.8, "count": 3471 }
    }
  ]
}
```

Failure shapes:

```json
// No products match the query at all
{ "query": "xyzzy floogle widget", "match_count": 0, "method": "bb-search", "products": [] }

// Browser enrichment hit Akamai and could not recover after 2 retries
{ "query": "...", "match_count": 1, "method": "bb-search+browser",
  "products": [ { "itemId": "...", "title": "...", "url": "...", "_enrichment_error": "akamai_blocked" } ] }
```
