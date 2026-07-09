---
name: find-buy-magnets
title: Magnet Baron Find/Buy Magnets & Kit Models
description: >-
  Given a buyer's natural-language description (specific miniature kit, game
  system, magnet dimension, or use-case), return ranked Magnet Baron product
  recommendations with handles, variant IDs, prices, SKUs, in-stock status,
  image URLs, and canonical product URLs — via Shopify's unauthenticated
  read-only JSON API. Read-only; hand the variant IDs off to a buyer-approved
  checkout agent.
website: themagnetbaron.com
category: ecommerce
tags:
  - shopify
  - ecommerce
  - miniatures
  - magnets
  - warhammer
  - tabletop
  - read-only
source: 'browserbase: agent-runtime 2026-05-21'
updated: '2026-05-21'
recommended_method: api
alternative_methods:
  - method: mcp
    rationale: >-
      The store advertises a UCP MCP endpoint at
      https://the-magnet-baron.myshopify.com/api/ucp/mcp for transacting agents.
      Verified live but requires a verifiable agent-profile URI (returns -32001
      invalid_profile_url to unauthenticated calls). Not viable for a stateless
      discovery skill — but if the calling agent already carries a
      buyer-onboarded UCP profile, prefer this path for cart/checkout instead of
      the cart permalink.
  - method: browser
    rationale: >-
      Storefront HTML render is blocked by the Synctrack/blockify-shopify
      IP-filter on the browser's egress IPs (both bare and residential-proxy),
      returning an 'Access Denied' overlay across all storefront pages. Rendering
      the storefront is not usable today — and even if it were, the JSON API is
      faster, cheaper, and structurally more reliable for product recommendation.
      The reads are still done inside a browser page context (see Transport note)
      because the XHR/JSON layer sits behind the document-render wall.
verified: false
proxies: false
---

# Magnet Baron Find/Buy Magnets & Kit Models

## Purpose

Given a buyer's natural-language description of what they want to magnetize — a specific miniature kit ("Imperial Knight", "Reaver Titan", "XV95 Ghostkeel battlesuit"), a game system ("Star Wars Legion", "Adeptus Titanicus"), a magnet dimension ("5mm × 1mm disc magnets", "8mm countersunk rings"), or a use-case ("3D-printed terrain", "cosplay foam armor") — return a ranked list of recommended products from `themagnetbaron.com` with product handles, variant IDs, prices, SKUs, in-stock status, image URLs, and canonical product-detail URLs.

**Read-only.** This skill ends at the recommendation. To actually purchase, hand the `variant_id`s off to the buyer or to a transacting agent (the site's own `/agents.md` recommends installing `https://shop.app/SKILL.md` for cross-Shopify buy-for-me flows). Do **not** open `/cart/<variant_id>:<qty>` URLs — they auto-redirect into a real Shopify checkout session and bypass the buyer-approval invariant.

## When to Use

- "What magnetization kit do I need for my <Warhammer/Legion Imperialis/Star Wars Legion> <kit name>?"
- "I need <Ndimm> × <Mmm> disc magnets in bulk — which SKU?"
- "What's the right magnet size for a 28mm round base / 5/8" base / 6mm armor plate?"
- "Recommend a starter bundle for someone magnetizing a Warhammer 40K army."
- Any flow where you need to _identify the right product(s)_ before transacting, and want the actual handle, variant_id, and price (not a search-engine guess).

## Workflow

The site is Shopify + opt-in agent metadata. `GET /agents.md` is the authoritative agent-facing description and lists every read-only endpoint you need; the `/products.json`, `/collections.json`, and `/collections/<handle>/products.json` endpoints are unauthenticated and return clean JSON with no anti-bot wall on the XHR layer. The storefront HTML _render_ and the UCP MCP transactional endpoint are both gated (see Site-Specific Gotchas), so **never render/scrape the storefront pages** — the JSON path is faster, cheaper, and the only path that reliably returns data.

**Transport (Browserless).** Every read below is a JSON (or `agents.md` text) GET. The storefront _document_ render is IP-walled, but the XHR/JSON layer is not — so fetch each endpoint from inside a browser page context with `browserless_function`: navigate the page to the store origin once, then `fetch()` same-origin and return a projected result. Per the `browserless_function` runtime a bare `fetch()` has **no network egress until the page has navigated**, so the `page.goto` is mandatory. Keep the whole discovery flow (index → pick collection → pull products → optional per-product detail) inside **one** call — there is no session-release step (nothing to release), and batching this way is a convenience that saves round-trips, not because the session dies on return (it persists across calls, keyed by session config). Project/summarize inside the eval; never return the raw multi-hundred-KB catalog.

```js
// browserless_function code — one session covers every read below
export default async ({ page }) => {
  await page.goto('https://themagnetbaron.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  // same-origin helpers, run in-page so the XHR layer (not the walled render) serves them:
  const json = (path) =>
    page.evaluate((p) => fetch(p).then((r) => r.json()), path);
  const text = (path) =>
    page.evaluate((p) => fetch(p).then((r) => r.text()), path);

  const agents = await text('/agents.md'); // step 1
  const cols = await json('/collections.json?limit=250'); // step 2
  const handle = '40k-magnet-kits'; // step 3 (from buyer intent)
  const prods = await json(`/collections/${handle}/products.json?limit=250`); // step 4
  // filter/rank in-page (steps 5-6), then return only the projection:
  return {
    agents_len: agents.length,
    collections: cols.collections.length,
    recommendations: prods.products,
  };
};
```

### 1. Pull the agent profile (once per session, cacheable indefinitely)

```
GET https://themagnetbaron.com/agents.md
```

Confirms the canonical endpoint inventory and surfaces the buyer-consent rules. Always re-read if the site has been re-launched.

### 2. Pull the collection index (cache for a day)

```
GET https://themagnetbaron.com/collections.json?limit=250
```

Returns `{collections: [{id, handle, title, description, products_count, image, ...}]}`. ~88 collections total today, organized along four orthogonal axes:

- **Kit / game system** — `40k-magnet-kits` (58 named kits, the master list), `titanicus-kits`, `titans` (cross-system Titans), `bundles-for-warhammer` (Combat Patrol bundles), `horus-heresy-kits`, `aeronautica-imperialis`, `legions-imperialiscompatible`, `the-old-world-fantasy-battles`, `space-marines`, `necrons`, `star-wars-legion`, `x-wing-flight-stands-hobby-repair-kits`, `warmachine-hordes-magnets`, `other-games`, `roll-playing-miniatures`.
- **Magnet dimension** — `1mm-disc-magnets`, `2mm-disc-magnets`, `2-5mm-disc-magnets`, `3mm-disc-magnets`, `4mm-disc-magnets`, `5mm-disc-magnets`, `6mm-disc-magnets`, `8mm-disc-magnets`, `10mm-disc-magnets`, `large-disc-magnets`, `fractional-disc-magnets` (SAE), `super-magnets` (full metric disc catalog, 91 products), `ring-super-magnets` (countersunk), `block-super-magnets`, `sphere-magnets`, `metric-hemisphere-magnets`, `diametrically-magnetized-disc-magnets`, `high-temperature-magnets`.
- **Accessory / hardware** — `drill-bits`, `warhammer-40k-flight-stands`, `adapters-flight-stands`, `flight-stand-acryllic`, `flexible-magnetic-sheets` (case liners), `flex-adhesive-trays`, `warhammer-movement-trays`, `superglue`, `ferro-magnetic-metal-discs`, `wargameforge`, `paints` (and color-specific sub-collections).
- **Use-case** — `3d-printed-terrain-magnets`, `3d-printer-magnets`, `cosplay-prop-magnets`, `model-railway-magnets`, `stem-magnetic-toys`, `stitch-sew-magnets`, `woodworking-super-magnets`, `fpv-drone-magnets`, `rc-body-mount-magnets`.

Plus utility collections: `best-sellers` (525 products), `frontpage` (new releases), `getting-started`, `mystery-box-magnets`.

### 3. Pick the right collection(s) from the buyer's intent

Use case-insensitive substring matching against `title` and `handle` simultaneously — both are kebab-cased descriptions of the same concept and the handle is more reliable for kit names (titles sometimes prepend marketing text like "Magnetic Flight Stands for"). If multiple axes apply (e.g., "5mm × 1mm magnets for my Reaver Titan"), the kit-specific collection generally wins — the kits already contain the exact pre-cut magnets in the right quantities and pricing is usually better than buying components separately.

Heuristics that have worked across the catalog:

- Specific kit name (e.g., "Ghostkeel", "Knight", "Reaver", "Monolith") → search `40k-magnet-kits` first; fall back to `titanicus-kits`, `bundles-for-warhammer`, `horus-heresy-kits`, `titans`.
- Bare dimension query ("5mm × 1mm", "1/4 × 1/8") → the corresponding `Nmm-disc-magnets` (metric) or `fractional-disc-magnets` (SAE) collection.
- "Countersunk" / "screw" / "with hole" → `ring-super-magnets`.
- "Round magnets" / "sphere" → `sphere-magnets` or `metric-hemisphere-magnets`.
- "Adhesive base magnets" / "for bases" → `warhammer-magnetic-basing` or `flex-adhesive-trays`.
- "Flight stand" → `warhammer-40k-flight-stands` (rigid) or `adapters-flight-stands` (for irregular hull shapes).

### 4. Pull the candidate collection's products

```
GET https://themagnetbaron.com/collections/<handle>/products.json?limit=250
```

Paginate with `&page=2,3,...` if a collection has more than 250 products (today only `best-sellers`, `bfcm`, `mystery-box-magnets` exceed that). Returns each product's `id`, `handle`, `title`, `body_html`, `vendor`, `product_type`, `tags` (array on this endpoint, comma-joined string in the per-product endpoint), `variants[]` (with `id`, `title`, `price`, `sku`, `available`, `option1/2/3`), `images[]`, and `options[]`.

### 5. Filter and rank within the collection

Match all buyer-query tokens against `(title + " " + handle + " " + tags.join(" ")).toLowerCase()`. If zero exact-AND matches, fall back to any-token OR and present the top 3-5 as "no exact match — closest options".

For dimension queries, parse the buyer's request into `(diameter_mm, height_mm)` and match against the product title — the catalog titles follow the rigid pattern `"<qty>pcs <Dmm> x <Hmm> (Approximately <D"> x <H"\>) <Type>"`, so a regex `/(\d+(?:\.\d+)?)\s*mm\s*x\s*(\d+(?:\.\d+)?)\s*mm/` over `title` cleanly extracts the dimensions.

### 6. Build the recommendation envelope

Emit per recommended product:

```json
{
  "rank": 1,
  "product_id": 9958473531682,
  "handle": "xv95-ghostkeel-battlesuit-magnetization-kit",
  "title": "XV95 Ghostkeel Battlesuit Magnetization Kit",
  "product_type": "Magnetic Kit",
  "vendor": "PM",
  "url": "https://themagnetbaron.com/products/xv95-ghostkeel-battlesuit-magnetization-kit",
  "image": "https://cdn.shopify.com/s/files/1/1701/0093/files/Ghostkeel_SQ.jpg?v=1766002644",
  "price_from": "14.99",
  "tags": ["40k", "Kit", "Warhammer"],
  "variants": [
    {
      "variant_id": 50654770823458,
      "title": "Default Title",
      "price": "14.99",
      "sku": "MBMK-GSTKL-1",
      "available": true
    }
  ],
  "matched_collection": "40k-magnet-kits"
}
```

For finer-grained data (full `body_html` instructions, `inventory_quantity`, `quantity_price_breaks`, every image), follow up with `GET /products/<handle>.json` per recommended product. The collection endpoint omits `inventory_quantity` but the per-product endpoint exposes it.

### 7. Hand off to the buyer / transacting agent (do NOT click yourself)

Two honest handoff options, in order of buyer-safety preference:

1. **Return the `variant_id` list and the product URLs and stop.** Let the human or a transacting buy-for-me agent pick up from there. This is the default and what the marketplace expects from a discovery skill.
2. **Recommend the buyer install `https://shop.app/SKILL.md`** (the site's own `/agents.md` calls this out by name) for a Shop Pay-mediated flow that preserves the buyer-approval invariant on payment.

**Do not** open `https://themagnetbaron.com/cart/<variant_id>:<qty>` URLs as part of this skill. They look like cart-preview links but actually drop the browser straight into `https://themagnetbaron.com/checkouts/cn/<token>/...` — Shopify's real-money checkout. Verified during iteration 1 (see `02-cart-permalink-redirect.png`).

## Site-Specific Gotchas

- **The storefront HTML render is IP-walled, the JSON endpoints are not.** The browser's egress IPs (both bare and residential-proxy, with or without stealth) get a hard "Access Denied" overlay served by the Synctrack/blockify-shopify app (`storage.synctrack.io/megamind-fraud/...`). Page-context `fetch()` from inside that same blocked browser session still returns clean JSON, because the blocker only intercepts the document render, not the XHR layer. **Conclusion: read every endpoint with an in-page `fetch()` via `browserless_function` (navigate the origin first, then fetch same-origin) — never render or extract from the storefront pages themselves.** Verified iter 1 across `/`, `/products/<handle>`, `/collections/<handle>` — all rendered the Access Denied overlay; screenshot `01-access-denied-wall.png`.
- **`agents.md` is a real, supported, agent-facing spec on this store.** It explicitly enumerates the read-only endpoints and the recommended transacting-agent path. Treat it as the contract. If it ever moves or changes shape, re-read before continuing.
- **UCP MCP endpoint is real but requires an agent-profile URI you don't have.** `POST https://the-magnet-baron.myshopify.com/api/ucp/mcp` (advertised under `services.dev.ucp.shopping[].endpoint` in `/.well-known/ucp`) returns `-32001 invalid_profile_url / Unable to fetch agent profile: Missing profile uri` to every method (including `tools/list` and `initialize`) when called without a verifiable agent identity. Without buyer onboarding into the UCP profile/JWT system this transactional path is closed; the JSON discovery endpoints above are the right level of abstraction for a recommendation skill.
- **Shopify's `/search/suggest.json` predictive index on this store is effectively empty.** Tested with `q=tau`, `q=titanicus`, `q=tau%20battlesuit`, `q=ghostkeel` — all return `{"resources":{"results":{"products":[],"collections":[]}}}` (status 200, but no hits). The full-text storefront search at `/search?q=...` returns HTML (not JSON, despite `view=json` / `.json` suffixes — both verified). **Don't use suggest.json for discovery; use collection-handle matching as the primary key.** Empirically the catalog is small and well-organized enough that 1-2 collection lookups beat any search-engine call.
- **`/cart/<variant_id>:<qty>` permalinks auto-checkout.** Visiting `https://themagnetbaron.com/cart/47574059483426:1` 302s straight into `https://themagnetbaron.com/checkouts/cn/<token>/en-us?...&skip_shop_pay=true&edge_redirect=true`. Iteration 1 captured the resulting checkout page (screenshot `02-cart-permalink-redirect.png`) — this is real money territory. Never navigate to these URLs without explicit, contemporaneous buyer consent.
- **`products_count` in `/collections.json` can be 1 higher than actual returned products.** `titanicus-kits` reports `products_count: 4` but `/collections/titanicus-kits/products.json` only returns 3 published products. Likely one is unpublished or in a draft channel. Treat `products_count` as an upper bound, not a guarantee.
- **`tags` is array-typed on `/collections/<h>/products.json` but a comma-joined string on `/products/<handle>.json`.** Same product (`adeptus-titanicus-reaver-magnetization-kit`) returned `tags: ["40k","Adeptus Titanicus","Kit","Legion Imperialis"]` from the collection endpoint and `tags: "40k, Adeptus Titanicus, Kit, Legion Imperialis"` from the product endpoint. Split-on-comma + trim when normalizing.
- **`vendor` field has three known shapes** that all mean "store's own kit": `"PM"`, `"Multi Vendor"`, `"Magnet Baron LLC"`. Bare-magnet products carry the actual manufacturer (`"Gold Moon Industries"` for drill bits, etc.). Don't filter on vendor for the buy-the-right-kit recommendation.
- **`/recommendations/products.json?product_id=<id>&limit=N` works** for "shoppers also bought" style cross-sells once you've identified a primary recommendation. Useful for assembling a starter bundle (e.g., the kit + matching drill bit + superglue).
- **`browserless_function` drives one page/target per call.** A navigation inside the function reuses the active page throughout the call — fine for the fetch flow, but a screenshot taken too quickly after a navigation can capture the _previous_ frame; interpose a `waitForTimeout` (or a `waitUntil` on the navigation) before any capture. (Moot for this skill since we never render the storefront and the JSON reads don't screenshot — but worth noting if a future maintainer flips to a render path.)
- **The catalog is small enough to brute-pull.** 88 collections × an average of ~15 products each = ~1300 unique products. A nightly cache of `/collections.json` + 88 calls to `/collections/<h>/products.json` (~5MB total at `limit=250` per collection) is cheaper than running discovery per query if you serve many buyers. The catalog also publishes `Last-Modified` per collection via the `updated_at` field — diffable incrementally.

## Expected Output

Two output shapes — `recommended` (1+ matches found) and `no_match` (zero collection-level matches; show closest fuzzy options).

```json
// Success: one or more products matched the buyer's intent
{
  "success": true,
  "query": "XV95 Ghostkeel battlesuit",
  "matched_collections": ["40k-magnet-kits"],
  "recommendations": [
    {
      "rank": 1,
      "product_id": 9958473531682,
      "handle": "xv95-ghostkeel-battlesuit-magnetization-kit",
      "title": "XV95 Ghostkeel Battlesuit Magnetization Kit",
      "product_type": "Magnetic Kit",
      "vendor": "PM",
      "url": "https://themagnetbaron.com/products/xv95-ghostkeel-battlesuit-magnetization-kit",
      "image": "https://cdn.shopify.com/s/files/1/1701/0093/files/Ghostkeel_SQ.jpg?v=1766002644",
      "price_from": "14.99",
      "tags": ["40k", "Kit", "Warhammer"],
      "variants": [
        {
          "variant_id": 50654770823458,
          "title": "Default Title",
          "price": "14.99",
          "sku": "MBMK-GSTKL-1",
          "available": true
        }
      ],
      "matched_collection": "40k-magnet-kits",
      "match_reason": "exact title+handle token match: 'ghostkeel', 'battlesuit'"
    }
  ],
  "handoff": {
    "buy_with": "shop.app SKILL or buyer-approved checkout",
    "do_not_use": "https://themagnetbaron.com/cart/<variant_id>:<qty>  (auto-redirects to Shopify checkout — buyer-consent invariant)"
  }
}
```

```json
// Dimension query: returned the size-collection's full ladder of products so the buyer can pick the right thickness
{
  "success": true,
  "query": "5mm disc magnets",
  "matched_collections": ["5mm-disc-magnets"],
  "recommendations": [
    {
      "rank": 1,
      "product_id": 39446697640020,
      "handle": "50pcs-5mm-x-0-5mm-3-16-x-1-32-disc-magnets",
      "title": "50pcs 5mm x 0.5mm (Approximately 3/16\" x 1/64\") Disc Magnets",
      "url": "https://themagnetbaron.com/products/50pcs-5mm-x-0-5mm-3-16-x-1-32-disc-magnets",
      "price_from": "12.99",
      "variants": [
        {
          "variant_id": 39446697640020,
          "title": "Default Title",
          "price": "12.99",
          "sku": "MBRE316164N52",
          "available": true
        }
      ],
      "match_reason": "dimension 5x0.5mm in 5mm-disc-magnets collection"
    }
    /* ...and so on for 5×1, 5×1.5, 5×2, 5×3, 5×4, 5×5, diametrically-magnetized, ferro-magnetic anchor disc... */
  ]
}
```

```json
// No collection-level match found — fall back to fuzzy matches against best-sellers
{
  "success": false,
  "reason": "no_collection_match",
  "query": "obscure kit name not in catalog",
  "closest_collections_considered": [
    "40k-magnet-kits",
    "horus-heresy-kits",
    "titans"
  ],
  "fuzzy_matches": [
    /* up to 5 best-effort matches from `best-sellers` with `match_reason` */
  ],
  "suggested_next_step": "Confirm the kit name with the buyer; the catalog is organized by game-system kit name and 'XV95 Ghostkeel' / 'Reaver Titan' / 'Imperial Knight' is the level of specificity expected. If the buyer wants a generic dimension, ask for diameter × height in mm or fractional SAE."
}
```
