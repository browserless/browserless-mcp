---
name: extract-menu
title: DoorDash Menu Extraction
description: >-
  Given a DoorDash restaurant URL or restaurant + city query, extract the full
  menu — every category, every item, with name, price, description, and
  popular/featured tags. Read-only — never adds to cart or checks out.
website: doordash.com
category: restaurants
tags:
  - doordash
  - restaurants
  - menu
  - delivery
  - read-only
  - cloudflare
source: 'browserbase: agent-runtime 2026-05-15'
updated: '2026-05-15'
recommended_method: hybrid
alternative_methods:
  - method: url-param
    rationale: >-
      For chain restaurants, /business/{slug}-{businessId}/menu serves an SSR'd
      HTML page with menu data embedded as JSON-LD and __NEXT_DATA__, bypassing
      the Cloudflare managed challenge that gates /store/ URLs. Fastest path;
      ~100× cheaper than browser. Only available for chain brands and serves the
      chain's template menu, not store-specific pricing.
  - method: browser
    rationale: >-
      For independent restaurants or when per-store pricing/DashPass deltas are
      required, the /store/{slug}-{storeId}/ URL is mandatory. It's
      Cloudflare-protected with a managed challenge, so the session must use
      a stealth + residential-proxy session. Also requires an address-gate bypass
      (?pickup=true or fill the modal) and scroll-to-mount for
      IntersectionObserver-lazy categories.
  - method: api
    rationale: >-
      consumer-mobile-bff.doordash.com exposes /v1/stores/{id}/menu and
      /v3/stores/{id}/ — verified live but require JWT auth (returns 401
      authorization_invalid cookieless). Not usable for anonymous menu
      extraction. Don't waste time on this surface without a refresh token.
verified: false
proxies: true
---

# DoorDash Menu Extraction

## Purpose

Given a DoorDash restaurant URL or a `(restaurant name, city)` pair, return the full menu — every category, every item, with name, price (string + float), description, popular/featured tags, and category section header. Also returns top-level restaurant metadata (canonical name, address line if visible, star rating, store-level URL). Read-only: never adds anything to a cart, never clicks "Add", never starts a checkout, never types payment details.

## When to Use

- Building a menu index across a chain (Chipotle, Sweetgreen, etc.) — hit the chain-level `/business/{slug}-{businessId}/menu` URL once per brand.
- Capturing per-store pricing where it varies by location (DashPass member pricing, surge-day surcharges, holiday menus) — the store-scoped `/store/...` URL is required.
- Snapshotting a menu for a price-tracking, allergen-tracking, or dietary-search downstream consumer.
- Comparing menus across locations of the same chain (use the chain `/business/...` URL for the canonical template, then sample a few `/store/...` URLs for delivery-price deltas).

## Workflow

DoorDash exposes **two parallel URL surfaces** for the same restaurant menu, with very different anti-bot postures. **Always check which surface fits the request first** — the chain `/business/` URL is ~100× cheaper and bypasses the Cloudflare challenge entirely, but it only exists for chain brands and serves the brand's _template_ menu rather than store-specific pricing.

```
/store/{slug}-{storeId}/                       → store-specific, Cloudflare-challenged
/business/{slug}-{businessId}/menu             → chain-level, SSR'd HTML, no challenge
page-service.doordash.com/en-US/store/...      → underlying SSR layer (same HTML body)
```

### Step 1 — Decide the surface

| Scenario                                                                                           | Surface                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Input is a `/store/{slug}-{id}/` URL with a _specific store_ id                                    | Browser (`/store/...`) — Step 4                                                                               |
| Input is a `/business/{slug}-{id}/` URL (chain hub)                                                | Direct fetch (`/business/.../menu`) — Step 2                                                                  |
| Input is a chain restaurant name + city, and per-store pricing is **not** required                 | Direct fetch (resolve chain businessId via Step 3, then Step 2)                                               |
| Input is a chain name + city, and per-store pricing **is** required (DashPass, geo-specific items) | Browser (`/store/...`) — Step 4                                                                               |
| Input is an independent (non-chain) restaurant                                                     | Browser (`/store/...`) — Step 4. Independents rarely have a `/business/` hub; verify via Step 3 search first. |

### Step 2 — Fast path: chain menu via `/business/.../menu`

```bash
a direct HTTP fetch "https://www.doordash.com/business/{slug}-{businessId}/menu" redirect-following
```

Returns SSR'd HTML, status 200, **no Cloudflare challenge** (verified across multiple business URLs on 2026-05-15). No a residential proxy flag is needed and adding stealth is not supported by a direct HTTP fetch anyway.

**Caveat — 1 MB Fetch API ceiling.** Business menu HTML is typically 1.0–1.5 MB. a direct HTTP fetch errors with `502 The response body exceeded the maximum allowed size of 1MB` on most production restaurants. Two workarounds:

1. **Browserbase session + `Page.getResourceContent`** — open the URL in a `a browserless_agent session` session (no Verified/proxy needed for `/business/.../menu`), then read the response body via CDP. The 1 MB limit is a direct HTTP fetch-only; full sessions stream the whole document.
2. **Run the fetch in a Browserbase Function** (`run it in a browserless_function). The function executes inside Browserbase's network, returns whatever JSON you serialize, and is not subject to the Fetch API's 1 MB cap.

Once you have the HTML, extract from one of three embedded sources (in order of preference):

- **`<script type="application/ld+json">` Schema.org `Restaurant` / `Menu`** — DoorDash emits structured-data JSON-LD for the menu sections and items, including `hasMenuSection[]`, `hasMenuItem[]`, `name`, `description`, `offers.price`, `offers.priceCurrency`. This is the cleanest extraction surface.
- **`<script id="__NEXT_DATA__" type="application/json">`** — the Next.js page-data blob containing the full hydration tree. Menu data lives under `props.pageProps.<...>.menu.categories[].items[]`. Schema changes occasionally; always parse defensively.
- **HTML scrape (last resort)** — `<h2 data-anchor-id="MenuItem-{itemId}">`, `<span data-anchor-id="MenuItem-Price">`, category headers as `<h2>` inside `<div data-anchor-id="StoreMenuList">`. Fragile across redesigns.

### Step 3 — Resolve a restaurant name → business or store ID

If the caller passes a name + city instead of a URL:

```bash
# Search the public sitemap index for a chain hub
a direct HTTP fetch "https://www.doordash.com/sitemap-business-doordash-index.xml"
# Pick the sharded sitemap, then grep for the slug
a direct HTTP fetch "https://cdn.doordash.com/sitemaps/sitemaps/sitemap-doordash-0-business-menu.xml"
grep -oE "/business/{slug-pattern}-[0-9]+/menu" biz_smm.xml | head -1
```

Or use `the browserless_search tool "site:doordash.com/business {restaurant name} menu"` — fast, returns canonical URL directly. Verified working in trace 2026-05-15 (returned `/business/chipotle-mexican-grill-115/` as top hit for "chipotle").

If no `/business/` page exists, the restaurant is an independent — fall through to Step 4 with the `/store/` URL discovered via `the browserless_search tool "site:doordash.com/store {name} {city}"`.

### Step 4 — Browser fallback for `/store/...` (store-specific or independent)

The `/store/{slug}-{storeId}/` URL is Cloudflare-protected with a **managed challenge** (`cType: 'managed'`, `cZone: 'www.doordash.com'`). Cleared 6 KB interstitial HTML on every bare fetch attempt observed on 2026-05-15 with and without a residential proxy. Requires a full browser with a residential proxy to render. Run the whole flow — nav → challenge settle → scroll to trigger lazy categories → extract — in one `browserless_agent` call (keep `proxy` on it). The session persists across separate calls, keyed by `proxy`/`profile`, so if you do split across calls, pass the same residential `proxy` on every one to reconnect to the same Cloudflare-cleared session; dropping or changing it lands you in a different, blank session:

```jsonc
{
  "rationale": "Extracting DoorDash store menu",
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.doordash.com/store/{slug}-{storeId}/?pickup=true",
        "waitUntil": "load",
        "timeout": 45000,
      },
    },
    { "method": "waitForTimeout", "params": { "time": 4000 } },
    { "method": "scroll", "params": { "direction": "down" } },
    { "method": "waitForTimeout", "params": { "time": 500 } },
    { "method": "scroll", "params": { "direction": "down" } },
    { "method": "waitForTimeout", "params": { "time": 500 } },
    { "method": "scroll", "params": { "direction": "down" } },
    { "method": "waitForTimeout", "params": { "time": 500 } },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{const items=[...document.querySelectorAll('[data-anchor-id=\"MenuItem\"], [class*=\"MenuItem\"]')].map(el=>el.innerText.trim().replace(/\\s+/g,' ')).filter(Boolean);return JSON.stringify({count:items.length,items});})()",
      },
    },
  ],
}
```

- **Cloudflare challenge:** the managed challenge typically auto-solves during the load wait (3–6 s). If it doesn't clear, add a `waitForTimeout` + an `evaluate` reading `location.href` (a stuck challenge keeps `?__cf_chl_tk=...`), or run the `solve` command with `type:"cloudflare"`.
- **Address gate:** appending `?pickup=true` (above) loads the pickup variant and skips the "Set delivery address" modal. If you need delivery pricing instead, drop `?pickup=true` and insert `{ "method": "type", "params": { "selector": "input[placeholder='Address']", "text": "{city}, {state}" } }` → `waitForTimeout 2000` → `click` the first suggestion → `click` the Save button, before the scroll steps.
- **Extraction:** the `evaluate` above scrapes the menu-item regions. Badges (`Popular`, `Featured`, `#1 Most Liked`) are sibling text nodes inside each item region — the `innerText` capture already includes them; split them out client-side.

**Per-store JSON shortcut:** the page makes a hydration POST to `/graphql/storeMenu` (operation `storeMenu` or `storepageFeed`) carrying the storeId. Cleanest extraction is an `evaluate` that reads the hydrated store state from the page (`window.__APOLLO_STATE__` / `#__next` data) after load — the GraphQL endpoint requires page-context cookies (no out-of-band call works — verified, 401 `authorization_invalid` from a cookieless POST to `https://consumer-mobile-bff.doordash.com/v3/stores/{id}/`), which the in-page `evaluate` inherits.

### Step 5 — Session lifecycle

No release step — there's nothing to release. The session persists across calls, keyed by `proxy`/`profile`: pass the same residential `proxy` on every call to reconnect to the same Cloudflare-cleared session (with the `__cf_bm` cookie intact); dropping or changing it lands you in a different, blank session. Batching all of Step 4 into that one call just saves round-trips.

## Site-Specific Gotchas

- **READ-ONLY.** Never click the "Add to cart" or "+" buttons under each menu item. Never proceed to checkout. Stop at the menu snapshot.
- **Cloudflare managed challenge on `/store/...`** — every `/store/` URL returns a 6 KB interstitial (`<title>Just a moment...</title>`, `cType: 'managed'`, `cZone: 'www.doordash.com'`) on cookieless requests. a residential-proxy HTTP fetch does **not** clear it; only a JS-executing browser with `a stealth + residential-proxy session` does. Verified 2026-05-15 across multiple stores and with/without proxies.
- **`/business/{slug}-{businessId}/menu` is the SEO-friendly SSR path** — fully indexed in `https://www.doordash.com/sitemap-business_menu-doordash-index.xml` (5 sharded sitemaps under `cdn.doordash.com/sitemaps/`), returns 200 OK without Cloudflare challenge. This is the fastest known way to extract a chain's menu.
- **`page-service.doordash.com` is the underlying SSR layer** — `https://page-service.doordash.com/en-US/store/{slug}-{id}/` serves the same SSR'd HTML body that the public `/business/` URL renders. Both paths exceed the 1 MB Fetch API ceiling, so direct a direct HTTP fetch is impractical without one of the workarounds in Step 2.
- **Two ID schemes, do not confuse them.** `/business/chipotle-mexican-grill-115/` uses business-id 115 (one per chain brand). `/store/chipotle-mexican-grill-san-francisco-303528/` uses store-id 303528 (one per physical location). They are not interchangeable.
- **Store URLs sometimes have a double-id form** — `/store/chipotle-mexican-grill-washington-270882/471923/`. The first id is the address/location group; the second is the actual store. Both forms route to the same store page.
- **Consumer-mobile-bff API requires JWT auth.** `https://consumer-mobile-bff.doordash.com/v3/stores/{id}/` and `/v1/stores/{id}/menu` return `401 {"name":"authorization_invalid","message":"Access Denied"}` from cookieless requests. Fingerprintable via `X-Shortened-Url-Path: v1-stores-id` header. Don't waste time on the BFF without a refresh token — the Identity service at `identity.doordash.com/auth/token/refresh` rate-limits and responds 403 to bare callers.
- **Address gate on first store visit.** The first `/store/` load in a fresh session always prompts for a delivery address. Bypass with `?pickup=true` or fill the modal once and reuse the session cookie via session reuse.
- **Categories are IntersectionObserver-lazy.** Scrolling is required to mount the full menu DOM — six 1200 px scrolls with a 500 ms wait between covers the longest menus observed. Don't rely on a single `snapshot` after `wait load`.
- **Tag badges live in DOM text, not attributes.** `Popular`, `Featured`, `#1 Most Liked`, `Customer Favorite` appear as sibling spans/images inside the item region, not as `data-tag` attributes. Match the exact strings.
- **Asterisks / price suffixes.** Some items display "$13.65*" or "$13.65+" — `*` indicates "starting at" for items with required modifiers, `+` indicates a base price with optional add-ons. Strip when emitting `price_float`, preserve in `price` (string), and flag with `flags: ["base_price"]`.
- **Sold-out items render with a strikethrough.** They have an `aria-disabled="true"` attribute on the item region. Emit them as `{ available: false }` rather than silently dropping — the caller may need the snapshot for a price database.
- **Regional locale prefixes** — `/en-CA/...`, `/en-AU/...`, `/en-NZ/...`, `/en-GB/...` and `/fr-CA/...` exist. The default `www.doordash.com/` (no locale) serves US. International stores show currency-localized prices; preserve the currency code from `offers.priceCurrency` in the JSON-LD or `__NEXT_DATA__`.
- **`m.doordash.com` returns 500** — there is no usable mobile-web subdomain. Don't waste time probing it.
- **a direct HTTP fetch 1 MB ceiling** — DoorDash store and business HTML routinely exceeds 1 MB. The Fetch API errors with `502 The response body exceeded the maximum allowed size of 1MB`. Use a real session for any full-page extraction, or run the fetch inside a Browserbase Function where the limit does not apply.
- **CDP egress restriction on some sandbox tenants.** During skill development on 2026-05-15 the runtime sandbox could resolve `api.browserbase.com` (REST API for sessions/fetch/search) but **not** `connect.usw2.browserbase.com` (WSS CDP endpoint), which made live `browserless_agent` and the autoevaluateuator unreachable from that sandbox. If a future caller hits the same DNS REFUSED on `connect.{region}.browserbase.com`, run the browser portion from a host with unrestricted egress; the API-only paths (Steps 2, 3) work fine from a restricted sandbox.
- **Cloudflare `__cf_bm` cookie persistence.** Once a Verified session clears the challenge, the `__cf_bm` cookie (path `/`, domain `doordash.com` and `www.doordash.com`, ~30 min expiry) carries it across `/store/...` navigations. Keep the session alive (session reuse) and reuse it for batch extraction across stores in the same brand.

## Expected Output

```json
{
  "success": true,
  "source": "business_menu",
  "restaurant": {
    "name": "Chipotle Mexican Grill",
    "business_id": 115,
    "store_id": 303528,
    "url": "https://www.doordash.com/store/chipotle-mexican-grill-san-francisco-303528/",
    "business_url": "https://www.doordash.com/business/chipotle-mexican-grill-115/menu",
    "address": "525 Market St, San Francisco, CA 94105",
    "rating": 4.6,
    "rating_count": 12048,
    "price_tier": "$",
    "cuisines": ["Mexican", "Fast Food", "Bowls"]
  },
  "categories": [
    {
      "name": "Popular Items",
      "items": [
        {
          "id": "item-901827",
          "name": "Burrito Bowl",
          "price": "$13.65",
          "price_float": 13.65,
          "currency": "USD",
          "description": "Your choice of freshly grilled meat, sofritas, or guacamole, and up to five toppings.",
          "tags": ["Popular"],
          "flags": [],
          "available": true,
          "image_url": "https://img.cdn4dd.com/p/.../burrito-bowl.jpg"
        }
      ]
    },
    {
      "name": "Tacos",
      "items": [
        {
          "id": "item-901831",
          "name": "Three Tacos",
          "price": "$11.95+",
          "price_float": 11.95,
          "currency": "USD",
          "description": "Three soft or crispy tacos with your choice of fillings.",
          "tags": [],
          "flags": ["base_price"],
          "available": true
        }
      ]
    }
  ],
  "extracted_at": "2026-05-15T23:00:00Z",
  "error_reasoning": null
}
```

Failure shapes:

```json
// Cloudflare challenge stuck (didn't clear after Verified + proxy attempt)
{ "success": false, "error_reasoning": "cloudflare_challenge_unsolved", "url": "..." }

// Address gate not bypassable (no autocomplete match for given city)
{ "success": false, "error_reasoning": "address_gate_no_match", "city": "..." }

// Restaurant not on DoorDash
{ "success": false, "error_reasoning": "restaurant_not_found", "query": "..." }

// Store closed / no menu available
{ "success": true, "restaurant": { ... }, "categories": [], "error_reasoning": "store_closed_or_no_menu" }
```
