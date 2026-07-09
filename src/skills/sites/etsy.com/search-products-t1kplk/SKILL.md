---
name: search-products
title: Etsy Product Search
description: >-
  Search Etsy for listings matching a keyword query plus the full UI filter
  surface (category, price, item-type, color, shipping, ordering, badges) and
  return structured JSON per listing — ID, title, shop, price/sale, rating,
  badges, and a sponsored-ad flag. Read-only.
website: etsy.com
category: marketplace
tags:
  - marketplace
  - etsy
  - search
  - listings
  - datadome
  - read-only
source: 'browserbase: agent-runtime 2026-06-04'
updated: '2026-06-04'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      Etsy Open API v3 has a /listings/active search endpoint, but it is
      partner-gated — it requires an approved app and OAuth, so it is not usable
      ad-hoc. Confirmed not a viable general path.
  - method: fetch
    rationale: >-
      Plain HTTP fetch of /search (even with residential proxies) returns a
      DataDome 403 JS/CAPTCHA challenge. A stealthed browser session is required
      to clear DataDome, so fetch alone does not work.
verified: true
proxies: true
---

# Etsy Product Search

## Purpose

Search Etsy for listings matching a keyword query (optionally scoped by category, price, item-type, color, shipping, and the rest of Etsy's filter surface) and return the matching listings as structured JSON. For each listing it returns listing ID, title, shop name + shop ID, canonical listing URL, current/original price, sale discount, rating + review count, badges (Bestseller / Star Seller / Etsy's Pick), free-shipping flag, item-type, primary image, and — critically — an `is_ad` flag distinguishing organic results from sponsored "Etsy Ads" placements. **Read-only**: never add to cart, favorite, sign in, or trigger any purchase flow.

## When to Use

- "Find me hand-poured soy candles on Etsy under $50, sorted by top reviews."
- Monitoring price / availability / new listings for a query over time.
- Bulk catalog/competitive research across queries, categories, or a single shop.
- Anywhere you'd reach for the Etsy Open API but can't — the v3 API is partner-gated (requires an approved app + OAuth), so the consumer search page is the practical surface.

## Workflow

Etsy's Open API v3 is partner-gated and not usable ad-hoc, and Etsy is behind **DataDome** bot protection. The reliable surface is the consumer search page driven by a `browserless_agent` call with a **US residential proxy** (`proxy: { proxy: "residential", proxyCountry: "us" }`) plus the stealth that `browserless_agent` runs by default, and a `solve { type: "dataDome" }` command to clear the challenge. Because the DataDome clearance cookie lives in the session (which is keyed by the `proxy` config), keep the whole warm-up → search → filter → extract flow inside a **single** call's `commands` array so that cookie carries across the steps without you re-passing the config. Listing data is **not** in a single embedded JSON blob — it lives in the DOM result cards, which you fetch once and parse in code (in-page).

### 1. One call, US residential proxy + DataDome solve

Set the proxy at the top level; a bare or proxy-only HTTP `fetch` of `/search` returns a DataDome 403 challenge — the residential proxy plus stealth plus the `solve` command are what clear it. Every step below is a command in this one call:

```json
{
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [/* steps 2–4 */]
}
```

### 2. Warm up on the homepage, THEN search organically

Navigating directly to `/search?q=...` as the **first** request frequently draws DataDome's hard CAPTCHA (`t:bv`). Instead, clear DataDome on the lighter homepage first, then submit the search through the search box (organic navigation carries the clearance cookie + a real referer):

```json
{ "method": "goto", "params": { "url": "https://www.etsy.com/", "waitUntil": "load", "timeout": 45000 } },
{ "method": "solve", "params": { "type": "dataDome" } },
{ "method": "waitForTimeout", "params": { "time": 7000 } },
{ "method": "type", "params": { "selector": "input[name=\"search_query\"]", "text": "hand poured soy candle" } },
{ "method": "evaluate", "params": { "content": "document.querySelector('input[name=\"search_query\"]').form.submit()" } },
{ "method": "waitForTimeout", "params": { "time": 6000 } }
```

Verify cleared before extracting: read the page `<title>` (fold a check into your extract `evaluate`) — it must be `"Hand poured soy candle - Etsy"`, not `"etsy.com"`. If it still reads `etsy.com` (still challenged) or the body contains a `captcha-delivery.com` iframe, the proxy IP is flagged — **start a fresh `browserless_agent` session** (a genuinely new session draws a new proxy IP) — do not keep reloading a poisoned session.

### 3. Apply filters by URL (same call, now-cleared session)

Once DataDome is cleared, append a `goto` to the filtered URL as the next command — same-call navigation keeps the clearance cookie. Append any of:

| Filter                        | URL param                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Ordering                      | `&order=most_relevant` (default) · `most_recent` · `price_asc` · `price_desc` · `highest_reviews`                                      |
| Custom price                  | `&min=25&max=50` (whole dollars)                                                                                                       |
| Item type — Handmade          | `&is_handmade=true`                                                                                                                    |
| Item type — Vintage           | `&is_vintage=true`                                                                                                                     |
| Item type — Craft supply      | `&is_supply=true`                                                                                                                      |
| Digital downloads             | `&instant_download=true` (note: a bare search appends `&instant_download=false`)                                                       |
| Free shipping                 | `&free_shipping=true`                                                                                                                  |
| On sale                       | `&is_discounted=true`                                                                                                                  |
| Ships to country              | `&ship_to=US` (ISO country code)                                                                                                       |
| Customizable / Personalizable | `&customizable=true` / `&is_personalizable=true`                                                                                       |
| Color                         | `&attr_1=<colorId>` (color-swatch facet; IDs are surfaced in the left-rail filter links — read them off the page rather than guessing) |
| Category                      | navigate the taxonomy path, e.g. `/c/home-and-living/home-decor/candles`, or use the category facet links in the left rail             |
| Pagination                    | `&page=2` (~64 results per page)                                                                                                       |

Dynamic facets (material, occasion, recipient, style, holiday, room) appear per-category in the left rail; read their `href`s off the page and append them — they are multi-select.

```json
{ "method": "goto", "params": { "url": "https://www.etsy.com/search?q=hand+poured+soy+candle&order=highest_reviews&min=25&max=50&is_handmade=true&free_shipping=true", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 4000 } }
```

### 4. Parse all cards in-page with one `evaluate`

Do **not** use the `snapshot` method (errors/times out on the ~1.6MB results page) and do **not** fetch cards one at a time (`div[data-index='N']` costs a round-trip each and the index sequence breaks around ad slots). The raw results body is ~1.6MB — larger than the `browserless_agent` text-return cap (~200k chars) — so parse **in-page** with a final `evaluate` command that returns a compact JSON array (comes back under `.value`), rather than shipping the HTML back. Inside the eval, `querySelectorAll` the card roots (or split the `outerHTML` on the card-root token `<div class="js-merch-stash-check-listing v2-listing-card`), then per card extract (dedupe by `data-listing-id` — each ID repeats ~6× across nested nodes; ~59 unique cards/page):

| Field                      | Pattern (per card chunk)                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `listing_id`               | `data-listing-id="(\d+)"`                                                                                                                       |
| `shop_id`                  | `data-shop-id="(\d+)"`                                                                                                                          |
| `listing_url` + `title`    | anchor `<a class="v2-listing-card__img" ... href="(...)" aria-label="(...)">` — URL = href up to `?`; title = the `aria-label` (decode `&amp;`) |
| `image_url`                | `src="(https://i\.etsystatic\.com/.../il_300x300\.\d+_\w+\.jpg)"` (swap `300x300`→`640xN` for larger)                                           |
| `price`                    | `currency-symbol">([^<]+)<` + `currency-value">([\d.,]+)<`                                                                                      |
| `original_price` / on-sale | `Original Price[^$]*\$([\d.,]+)` (present only when discounted)                                                                                 |
| `rating` + `review_count`  | `aria-label="([\d.]+) star rating with ([\d.,kK]+) reviews"` (review counts are abbreviated/fuzzed, e.g. `3.8k`)                                |
| **`is_ad`**                | chunk contains `<span class="wt-screen-reader-only">Ad from shop ([^<]+)</span>` → sponsored Etsy Ad                                            |
| `bestseller`               | chunk contains `Bestseller` (the anchor href also carries `&bes=1`)                                                                             |
| `free_shipping`            | chunk contains `Free shipping`                                                                                                                  |

A secondary, very stable source for ID + canonical URL is the hidden `<form action="/cart/listing.php">` inside each card (`<input name="listing_id">`, `<input name="listing_url">`).

### 5. Emit JSON and release

Emit the schema in **Expected Output** (first ~12 listings unless more pages requested), flagging each sponsored placement with `is_ad: true`. There is **no session-release step**, and nothing to release — the session **persists across calls, keyed by the `proxy` config**; it does not tear down when a call returns. Keeping the entire warm-up → search → filter → extract flow in ONE call's `commands` array is the convenient way to hold the DataDome clearance cookie; a later call repeating the same `proxy` reconnects to that same cleared session, while dropping or changing it lands in a different, un-cleared session.

> **Why one call that parses in-page, not a bare LLM loop:** shipping 1.6MB of HTML back for ~59 cards blows the text-return cap and an in-context agent's token/turn budget. The recommended consumer is a single `browserless_agent` call (or a `browserless_function`) that runs steps 1–4 deterministically and does the card parsing inside the `evaluate`, returning only the compact projection.

## Site-Specific Gotchas

- **It's DataDome, not Akamai.** The task brief said Akamai Bot Manager; the live block is **DataDome** (`Server: DataDome`, `geo.captcha-delivery.com`). Two challenge flavors: interrogation (`rt:i`, auto-solves in a few seconds of JS) and CAPTCHA (`t:bv`, an unsolvable iframe). A US residential `proxy` plus stealth (default on `browserless_agent`) plus a `solve { type: "dataDome" }` command is mandatory; a proxied-but-not-stealthed raw `fetch` still gets 403.
- **Direct `/search` deep-link draws the hard CAPTCHA.** Hitting `/search?q=...` cold is much more likely to get the `t:bv` CAPTCHA than the homepage. Always warm up on `https://www.etsy.com/` first (it clears cleanly), then drive the search box. Once DataDome is cleared, filtered `/search?...` URLs navigate fine within the same call.
- **A `t:bv` CAPTCHA poisons the session.** Re-navigating won't fix it — the proxy IP is flagged, and `solve` can't clear the unsolvable `t:bv` iframe. Detect (page `<title>` == "etsy.com", or body has a `captcha-delivery` iframe) and rotate to a fresh `browserless_agent` session (a genuinely new session draws a new proxy IP). Success is partly IP-luck; budget 1–2 fresh-session retries.
- **No embedded listing JSON.** Despite expectations, there is no `application/json` script, no `__INITIAL_STATE__`, and no `ld+json` listing payload. The only embedded JSON is `Etsy.Context.data` (locale/currency config). Listings are DOM cards — parse the markup.
- **The `snapshot` method is useless here.** It errors/times out on the heavy results page. Parse the cards in-page with one `evaluate` instead.
- **The top of every result grid is ad-heavy.** ~23 of ~59 page-1 cards are sponsored ("Ad from shop …"). The first several organic-looking cards are usually ads — always set `is_ad` per card; never assume position implies organic.
- **Result count is no longer surfaced numerically.** The old "X,XXX results, with Ads" string isn't in current markup (the H1 is a screen-reader-only "Search results"). Emit `result_count_text: null` when absent; don't fail the task over it. Review counts on cards are also abbreviated/fuzzed (`3.8k`, `45.7k`).
- **`data-listing-id` repeats ~6× per card** (nested nodes). Dedupe by ID. `data-index` is sequential only over organic-ish slots and breaks around ads — don't iterate it.
- **`instant_download`** is appended as `=false` on a normal search; set `=true` to filter to digital downloads.
- **Color / dynamic facets use opaque IDs.** Color swatches and material/occasion/etc. facets map to `attr_*=<id>` params whose IDs vary by category. Read the facet `href`s off the left rail rather than hardcoding.
- **Read-only.** Never click Add to Cart, Buy it Now, the heart/Favorite, or Sign In.

## Expected Output

```json
{
  "success": true,
  "query": "hand poured soy candle",
  "search_url": "https://www.etsy.com/search?q=hand+poured+soy+candle&ref=search_bar",
  "active_filters": [],
  "result_count_text": null,
  "page": 1,
  "listing_count": 12,
  "listings": [
    {
      "listing_id": "4368383654",
      "title": "Wooden Dough Bowl Candle with Wavy Wooden Wick – Hand Poured Soy Candle, Rustic Farmhouse Home Decor",
      "shop_id": "35558980",
      "shop_name": "AgabooCandles",
      "listing_url": "https://www.etsy.com/listing/4368383654/large-wooden-dough-bowl-candle-with-wavy",
      "image_url": "https://i.etsystatic.com/35558980/r/il/b92f48/7480882228/il_640xN.7480882228_hkui.jpg",
      "price_formatted": "$31.50",
      "price_raw": 31.5,
      "currency": "USD",
      "original_price_formatted": "$35.00",
      "discount_percent": 10,
      "rating": 4.9,
      "review_count": "3.8k",
      "badges": ["Bestseller"],
      "is_ad": true,
      "free_shipping": false,
      "item_type": "handmade"
    },
    {
      "listing_id": "631809416",
      "title": "Wild Huckleberry Soy Jar Candle",
      "shop_id": "16896953",
      "shop_name": "WildMontanaCandles",
      "listing_url": "https://www.etsy.com/listing/631809416/wild-huckleberry-soy-jar-candle",
      "image_url": "https://i.etsystatic.com/16896953/r/il/e80b70/6078678891/il_640xN.6078678891_abcd.jpg",
      "price_formatted": "$18.00",
      "price_raw": 18.0,
      "currency": "USD",
      "original_price_formatted": null,
      "discount_percent": null,
      "rating": 4.9,
      "review_count": "415",
      "badges": [],
      "is_ad": false,
      "free_shipping": true,
      "item_type": "handmade"
    }
  ]
}
```

Blocked / CAPTCHA outcome (after fresh-session retry still walled):

```json
{
  "success": false,
  "query": "hand poured soy candle",
  "search_url": "https://www.etsy.com/search?q=hand+poured+soy+candle",
  "listings": [],
  "error_reasoning": "DataDome CAPTCHA (t:bv) served on both initial and fresh-session attempts; proxy IP pool flagged."
}
```
