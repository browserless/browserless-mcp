---
name: add-items-to-cart
title: Add Grocery Items to King Soopers Cart
description: >-
  Resolve a free-text grocery list to specific King Soopers products (UPC,
  brand, size, price), ask follow-up questions for ambiguous items, then add the
  confirmed products to the signed-in user's cart for pickup or delivery.
website: kingsoopers.com
category: shopping
tags:
  - shopping
  - grocery
  - cart
  - kroger
  - king-soopers
  - add-to-cart
source: 'browserbase: agent-runtime 2026-06-07'
updated: '2026-06-07'
recommended_method: hybrid
alternative_methods:
  - method: fetch
    rationale: >-
      Residential-proxy fetch of /search returns full SSR HTML with products[]
      (upc, brand, description) embedded in window.__INITIAL state — the
      reliable read path for item resolution and disambiguation. Cannot write to
      the cart.
  - method: browser
    rationale: >-
      The cart is account-bound, so the add-to-cart write needs an authenticated
      stealth browser session. Headless sessions are Akamai-blocked for
      sustained interaction, so this path is required but not guaranteed in a
      headless/cloud environment.
  - method: api
    rationale: >-
      Official api.kroger.com requires OAuth client credentials not available
      here; the site's internal /cart/modify endpoint requires authenticated
      session cookies + CSRF. Not usable anonymously.
verified: true
proxies: true
---

# Add Grocery Items to King Soopers Cart

## Purpose

Given a free-text shopping list, this skill resolves each item to a concrete King Soopers product (UPC + brand + size + price), surfaces clarifying questions for anything ambiguous, and then adds the confirmed products to the signed-in user's cart. King Soopers is a Kroger-family banner, so the cart is **account-bound and write-only after sign-in** — there is no anonymous cart. Item _resolution_ (search) is read-only and reliable; the _add-to-cart_ step is a stateful, authenticated write. This skill is **hybrid**: use a residential-proxy HTTP fetch to find products and drive disambiguation, then an authenticated browser to perform the cart write.

## When to Use

- A user hands you a grocery list ("a gallon of 2% milk, a dozen large eggs, bananas, sourdough bread") and wants it added to their King Soopers cart for pickup or delivery.
- You need to map vague item names to specific purchasable products before adding them.
- You need to decide _which_ product variant to add when a query returns many (fat %, size, brand, organic vs. conventional) and must ask the user before committing.
- You want to pre-build a cart the user will later review and check out themselves (this skill never checks out).

## Workflow

The optimal path splits the task into a read phase (single-load SSR read) and a write phase (authenticated browser). **Do not try to drive the whole flow with a long-lived browser session** — kingsoopers.com sits behind Akamai Bot Manager and blocks sustained interaction after the first document loads (see Gotchas). The SSR HTML on that first load, however, is fully readable through a residential-proxy `browserless_agent` `goto`.

### Phase 1 — Resolve each list item (read-only, reliable)

For every item on the user's list:

1. `browserless_agent` with a residential proxy (`proxy: { proxy: "residential" }`), a single `goto` of the search page (URL-encode the query), then read the SSR state in-page before any further navigation:
   ```json
   { "method": "goto", "params": { "url": "https://www.kingsoopers.com/search?query=2%25%20milk", "waitUntil": "load", "timeout": 45000 } }
   { "method": "evaluate", "params": { "content": "JSON.stringify((window.__INITIAL_STATE__||window.__INITIAL__||{}))" } }
   ```
   The **first HTML document renders fine** even though sustained browser interaction is Akamai-blocked (see Gotchas) — so read `window.__INITIAL...` off that first load and do not chain more navigations in the same read. Project just the fields you need inside the `evaluate` (the raw state blob is large; the text return is capped).
2. Parse the embedded `window.__INITIAL...` state JSON returned under `.value`. The `products[]` array holds objects shaped like:
   ```json
   {
     "upc": "0001111050224",
     "brandName": "king soopers city market",
     "description": "king soopers® city market® 2% reduced fat milk gallon",
     "subCommodityCode": ["0200100012"],
     "relevanceScore": 0.878
   }
   ```
   Capture `upc`, `brandName`, `description` for each candidate. (`price` is present but is store-specific and only populated once a store/modality is set — see Gotchas.)
3. Rank candidates by `relevanceScore` / `searchEngineRank` and the user's stated constraints (size, brand, organic, count).

### Phase 2 — Ask follow-up questions for ambiguity

A single query routinely returns many variants. Example: `query=milk` returns _vitamin D whole / 2% reduced fat / 1% lowfat_ each in _gallon_ and _half-gallon_. **Before adding anything, ask the user a concise disambiguation question for each unresolved item** instead of guessing. Trigger a question when any of these is true:

- The list item omits a dimension the products differ on: **size/volume, fat % or variety, brand, organic vs. conventional, count/pack**.
- No quantity was specified (ask "how many?").
- Top candidates have near-tied relevance scores.
- The query returns zero products (ask the user to rephrase or confirm the item).

Surface the top 2–4 candidates with brand, size, and price so the user can pick. Only items with exactly one sensible match (or an explicit user choice) proceed to Phase 3.

### Phase 3 — Add confirmed products to the cart (authenticated browser write)

This is the stateful write and **requires user-supplied King Soopers credentials**; the cart cannot be modified anonymously.

Run this as a single `browserless_agent` call with a residential proxy (`proxy: { proxy: "residential" }`) and the user's saved King Soopers **profile** (pass it on every call; dropping it lands you in a logged-out session). Because login is involved, load the `autonomous-login` skill first (via `browserless_skill`) and follow its gates; supply vault creds with `loadSecret` (never put credentials in `type`/context).

1. `goto` `https://www.kingsoopers.com/` (`waitUntil: "load"`).
2. Dismiss the "Improving Your Experience" consent modal if present (`click`).
3. **Set store + fulfillment modality.** The site geo-defaults a store from the (proxy) IP — confirm or change it via the "Pickup / Delivery" selector and the user's ZIP. Prices and availability are store-scoped.
4. **Sign in** with the user's account (top-right "Sign In") per the autonomous-login gates. Cart contents persist to the account/profile.
5. For each confirmed UPC, `goto` its product page (`https://www.kingsoopers.com/p/<slug>/<upc>` or re-search), `click` **Add to Cart**, and set the quantity. Internally the page POSTs to `/cart/modify`.
6. `goto` the cart (`/cart`) and read it back (`text`/`evaluate`); report what was added vs. what failed. Keep all of the above in one call's `commands` array so the authenticated session persists across the steps.

> ⚠️ Read-only boundary: add items and stop at the populated cart. **Never** proceed to `/checkout` or place an order (also `Disallow`-ed in robots.txt).

### Browser fallback note

There is no pure-browser fallback that reliably bypasses Akamai for sustained interaction — the document loads but the product/cart XHRs can be blocked (you'll see "We're sorry, but there was a problem"). The single-`goto` SSR read in Phase 1 is the reliable path for _reading_; the authenticated browser in Phase 3 is the only path for _writing_, and it depends on the session surviving Akamai (not guaranteed — see Gotchas).

## Site-Specific Gotchas

- **Akamai Bot Manager wall.** Browser sessions (even with a residential proxy) render the first HTML document, then get blocked: subsequent navigations return an **"Access Denied" page served as HTTP 200** (body from `errors.edgesuite.net`, `Akamai-Grn`/`X-Akamai-Transformed` headers), not a 403. The SPA shell can also load while its client-side product XHRs are silently blocked, producing "We're sorry, but there was a problem." Don't treat a 200 as success — check the title/body for "Access Denied". This wall is why the add-to-cart write could not be fully verified during skill creation.
- **A single residential-proxy `goto` is NOT blocked.** A `browserless_agent` `goto` over a residential proxy returns full SSR HTML (200) for `/`, `/search?query=...`, and `/robots.txt` on the first load — read `window.__INITIAL...` off it. Use this for all product resolution. Plain `curl`/datacenter IPs will be blocked; the block bites on sustained navigation, not the first document.
- **Product data lives in SSR state, not a clean JSON API.** Parse `window.__INITIAL...` from the search HTML for `products[]` (upc, brandName, description, subCommodityCode). A `query=eggs` page embedded ~88 product UPCs. There is no documented public search JSON endpoint reachable without auth; the official `api.kroger.com` requires OAuth client credentials you won't have.
- **Cart is account-bound; no guest cart.** `/cart`, `/cart/modify`, `/products/start-my-cart`, and `/cart/addAllToCartFromOrder/` all require an authenticated session + CSRF/session cookies. Without user credentials the add step cannot complete.
- **Store + modality gate prices and availability.** The site picks a default store from IP geolocation (a residential proxy defaulted to "Dell Range Cheyenne, 3702 Dell Range Blvd", WY). `price` fields are empty until a store/modality is chosen, and stock differs per store — always set the user's real ZIP/store first.
- **Built-in "Shopping Assistant" widget** appears bottom-right on search pages. It's a Kroger-native list/assistant feature; it may help bulk-add but still requires sign-in and is itself behind the same anti-bot layer.
- **robots.txt disallows** `/checkout*`, `/scheduling*`, `/clickstream*`, `/recipes/api/v1/*`, `/locations*`. Adding to cart is not disallowed, but **checkout is** — respect the read-only-up-to-cart boundary.
- **Disambiguation is core, not optional.** Grocery terms are inherently underspecified; the same query ("milk", "bread", "cheese") returns many valid variants. The correct behavior is to ask the user, not to pick the top relevance hit silently.

## Expected Output

```json
{
  "success": true,
  "store": {
    "name": "Dell Range Cheyenne",
    "address": "3702 Dell Range Blvd",
    "modality": "pickup"
  },
  "added": [
    {
      "query": "2% milk",
      "upc": "0001111050224",
      "description": "king soopers® city market® 2% reduced fat milk gallon",
      "brand": "king soopers city market",
      "quantity": 1,
      "status": "added"
    }
  ],
  "clarifications_needed": [
    {
      "query": "milk",
      "reason": "multiple variants",
      "candidates": [
        {
          "upc": "0001111050240",
          "description": "vitamin d whole milk gallon"
        },
        { "upc": "0001111050224", "description": "2% reduced fat milk gallon" },
        { "upc": "0001111050217", "description": "1% lowfat milk gallon" }
      ],
      "question": "Which milk would you like — whole, 2%, or 1%? And gallon or half-gallon?"
    }
  ],
  "not_found": [
    {
      "query": "fresh truffles",
      "reason": "no products returned for this query"
    }
  ],
  "requires_auth": false,
  "error_reasoning": null
}
```

Outcome shapes you may emit:

- **`requires_auth: true`** with `added: []` and `error_reasoning: "King Soopers cart requires a signed-in account; no credentials supplied."` — when item resolution succeeded but no login is available to perform the write.
- **`success: false`** with `error_reasoning: "Akamai Access Denied (HTTP 200 block) — headless browser could not sustain the session to add items."` — when the browser write phase is blocked.
- **`clarifications_needed`** non-empty — when the run paused to ask the user; `added` holds only unambiguous items resolved so far.
- **`not_found`** non-empty — queries that returned zero products.
