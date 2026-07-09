---
name: scrape-products-read-posts
title: Vinted Product Scraping & Post Reading
description: >-
  Search the Vinted France catalog and return product listings via the public
  JSON API, then read any single listing's full post (description, condition,
  size, color, seller, location) from the rendered item page. Read-only.
website: vinted.fr
category: marketplace
tags:
  - marketplace
  - vinted
  - scraping
  - second-hand
  - read-only
  - cloudflare
  - datadome
source: 'browserbase: agent-runtime 2026-06-20'
updated: '2026-06-20'
recommended_method: hybrid
alternative_methods:
  - method: api
    rationale: >-
      The /api/v2/catalog/items JSON endpoint does the real work, but it is
      bearer-gated and the auth cookies (_vinted_fr_session, access_token_web)
      are HttpOnly and only minted by a real page load. A cookieless fetch
      returns 401, so a pure-API path is not viable without first bootstrapping
      a browser session — hence hybrid.
  - method: fetch
    rationale: >-
      Confirmed non-viable for the catalog API: a cookieless one-shot HTTP fetch
      (even with a residential proxy) has no session cookies and returns 401
      Www-Authenticate: Bearer. Only usable for static assets like robots.txt.
  - method: browser
    rationale: >-
      Full browser DOM scraping works but is far slower/costlier than the API
      for product lists; reserve browser DOM reads for single-post detail
      (ld+json + data-testid), where the API endpoint /api/v2/items/{id} is
      unusable (404).
verified: true
proxies: true
---

# Vinted Product Scraping & Post Reading

## Purpose

Search the Vinted France (`vinted.fr`) catalog for a query and return a page of product listings (id, title, price, brand, size, condition, seller, photos, favourite/view counts, canonical URL), then optionally open any single listing and read its full "post" — the seller's free-text description plus structured attributes (condition, color, size, category, upload date, seller name + location). The product list comes from Vinted's public JSON catalog API; individual post details come from the server-rendered item page (`ld+json` + DOM). **Read-only** — never buys, messages a seller, makes an offer, or logs in. (Vinted's `robots.txt` permits search/discovery but explicitly prohibits automated transactions, cart, and checkout — this skill stays on the allowed side.)

## When to Use

- Monitoring or bulk-collecting second-hand listings matching a query (e.g. "nike air max", a brand, a model).
- Price research / market scans across the catalog with filters (price range, sort order, brand, size).
- Pulling the full detail of one specific listing — description, condition, seller, location, photos — given its item URL or ID.
- Anywhere you'd otherwise scrape Vinted search HTML: the JSON catalog API is faster and structurally cleaner than parsing the JS-rendered grid.

## Workflow

Vinted's web UI is a thin client over a JSON API at `/api/v2/...`, but that API is **bearer-gated** — a cookieless request to `/api/v2/catalog/items` returns `401` with `Www-Authenticate: Bearer realm="Vinted"`. The bearer/session cookies (`_vinted_fr_session`, `access_token_web`) are **HttpOnly** and are minted automatically when a browser loads any `vinted.fr` page. So the reliable pattern is **hybrid**: bootstrap auth by loading the homepage in a real browser, then call the JSON API from page context (a same-origin `fetch` inside an `evaluate`) — cookies persist across navigations within the same session. A cookieless one-shot HTTP fetch will **not** work for the API (no cookies → 401).

**Batching the whole flow into ONE `browserless_agent` call is the convenient default.** A `browserless_agent` session persists across separate calls, keyed by the call's `proxy`/`profile` config — a later call carrying the same config reconnects to the same warmed browser with the HttpOnly cookies intact, while a call that drops or changes it lands in a different, cookieless session that 401s. Keeping the homepage bootstrap (which mints the HttpOnly cookies) and the API `fetch` in the same call's `commands` array is the simplest way to guarantee they share cookies — it saves round-trips and avoids accidentally dropping the session config. Set `proxy: { proxy: "residential" }` on the call (repeat it on every call you make), because `vinted.fr` sits behind **Cloudflare + DataDome**.

### 1. Bootstrap auth + scrape the catalog API — one call

Load the homepage (sets the HttpOnly cookies), then `evaluate` a same-origin `fetch` of the catalog API so the cookies attach automatically:

```json
{
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.vinted.fr/",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(async()=>{const r=await fetch('/api/v2/catalog/items?search_text=nike+air+max&per_page=20&page=1&order=price_low_to_high&currency=EUR',{headers:{Accept:'application/json'}});return JSON.stringify(await r.json());})()"
      }
    }
  ]
}
```

The homepage 302-redirects through Cloudflare on a cold request; the residential proxy + stealth clears it. If DataDome throws an interstitial instead of loading, add a `{ "method": "solve", "params": { "type": "dataDome" } }` command after the `goto` and before the `evaluate`. The `evaluate` return comes back under `.value`.

Endpoint:

```
GET /api/v2/catalog/items
    ?search_text={url+encoded query}
    &per_page={1-96}
    &page={1..}
    &order={relevance|newest_first|price_low_to_high|price_high_to_low}
    &currency=EUR
```

Useful filters (append as query args; unrecognized ones are ignored): `price_from`, `price_to`, `brand_ids[]`, `catalog_ids[]`, `size_ids[]`, `status_ids[]` (condition), `color_ids[]`.

Response shape:

- `items[]` — each item has `id`, `title`, `price:{amount,currency_code}`, `total_item_price:{amount,...}` (incl. buyer-protection fee), `brand_title`, `size_title`, `status` (condition), `url`, `path`, `photo`/`photos[]` (with `thumbnails[]`), `favourite_count`, `view_count`, `user:{id,login,profile_url}`.
- `pagination` — `{current_page, total_pages, total_entries, per_page, time}`.

### 2. Read a single post

The item page (`/items/{id}-slug`) is server-rendered — loading it directly mints the same HttpOnly cookies and carries the `ld+json` in its HTML, so a single `browserless_agent` call handles it. `goto` the item URL, then two `evaluate` commands read the two complementary sources on the page:

```json
{
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.vinted.fr/items/9216822059-nike-air-max-neuves-jamais-portees",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>document.querySelector('script[type=\"application/ld+json\"]').textContent)()"
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{const g=t=>{const e=document.querySelector('[data-testid=\"'+t+'\"]');return e?e.innerText.trim().replace(/\\s+/g,' '):null};const d=document.querySelector('[itemprop=\"description\"]');return JSON.stringify({price:g('item-price'),total:g('total-combined-price'),size:g('item-attributes-size'),condition:g('item-attributes-status'),color:g('item-attributes-color'),upload_date:g('item-attributes-upload_date'),seller:g('profile-username'),seller_location:g('seller-location'),favourites:g('favourite-button'),description:d?d.innerText.trim():null});})()"
      }
    }
  ]
}
```

Each `evaluate` return comes back under `.value`. (a) is the clean structured data (seller's description + product facts); (b) is the richer DOM facts not in `ld+json` (views/favourites/seller/dates).

- The `application/ld+json` `Product` block gives: `name`, `description` (seller's free text), `brand.name`, `offers.price`/`priceCurrency`/`availability`/`itemCondition`, `category`, `color`, `image`.
- The DOM `data-testid` fields give the human-facing extras: `item-price`, `total-combined-price`, `item-attributes-size`, `item-attributes-status` (condition), `item-attributes-color`, `item-attributes-upload_date`, `profile-username`, `seller-location`, `favourite-button` (favourite count). The description also lives at `[itemprop="description"]`.

No session-release step is needed — there is nothing to release. Batching any multi-step flow (bootstrap → API scrape, or item load → both reads) into ONE call's `commands` array is the simplest way to keep the minted cookies live across the steps; a later call reusing the same `proxy`/`profile` reconnects to the same session anyway.

## Site-Specific Gotchas

- **The catalog API is bearer-gated, cookies are HttpOnly.** A cookieless request to `/api/v2/catalog/items` → `401 Www-Authenticate: Bearer realm="Vinted"`. The `_vinted_fr_session` + `access_token_web` cookies are HttpOnly (invisible to `document.cookie`) and are set on the first page load. **You must call the API from page context inside the same session that loaded a vinted.fr page** — an `evaluate` running a same-origin `fetch`, all in one `browserless_agent` call's `commands` (goto homepage → evaluate the API fetch). A cookieless one-shot HTTP fetch (no page load first) gets 401 — it can't reach the API.
- **`/api/v2/items/{id}` returns `404` even for valid, live items.** Do NOT use it to read a post — it's the wrong/deprecated endpoint and returns an HTML error page. Read post detail from the item _page_ instead (`ld+json` + DOM as in step 3). Confirmed 404 across multiple valid item IDs and from both homepage and item-page contexts.
- **Two anti-bot layers: Cloudflare + DataDome.** The homepage cold-loads via a `302` Cloudflare redirect, and a `datadome` cookie is issued. Setting `proxy: { proxy: "residential" }` on the `browserless_agent` call is the recommended/validated config; if DataDome throws an interstitial, add a `{ "method": "solve", "params": { "type": "dataDome" } }` command after the `goto`. (A bare session occasionally got through during one validation run, but Cloudflare+DataDome posture changes — keep the residential proxy on for reliability.)
- **Prices are strings inside objects.** `price` is `{"amount":"20.0","currency_code":"EUR"}` — `amount` is a string, not a number. `total_item_price` is the price **plus** Vinted's buyer-protection service fee (it's larger than `price`); use `price.amount` for the listing price and `total_item_price.amount` for what the buyer actually pays.
- **Pagination is effectively capped.** `pagination.total_entries` reflects the filtered result count, but Vinted caps how deep you can page (deep `page=` values stop returning new items). For large result sets, narrow with filters (`price_from`/`price_to`, `brand_ids[]`, `catalog_ids[]`) rather than paging thousands deep.
- **`order` values are enums** — `relevance` (default), `newest_first`, `price_low_to_high`, `price_high_to_low`. Arbitrary strings are silently ignored (falls back to relevance).
- **Content is French.** Titles, descriptions, condition labels ("État Neuf sans étiquette"), and upload dates ("Ajouté Il y a 4 heures") render in French. The `ld+json` `itemCondition` is a normalized schema.org value (`NewCondition`, etc.); prefer it if you need a language-neutral condition.
- **The `item-attributes-brand-menu-button` testid is sometimes empty.** Fall back to `ld+json` `brand.name` or the catalog item's `brand_title` for the brand.
- **Read-only.** `robots.txt` allows search/catalog crawling (`Content-Signal: search=yes`) but explicitly prohibits automated account creation, carts, checkouts, and any transaction simulation. Stop at the listing/post view — never click buy/offer/message.

## Expected Output

Two outcome shapes (scrape list + read post), plus a blocked-failure shape.

```json
// 1. Catalog scrape (step 2)
{
  "success": true,
  "query": "nike air max",
  "order": "price_low_to_high",
  "pagination": {
    "current_page": 1,
    "total_pages": 480,
    "total_entries": 960,
    "per_page": 20
  },
  "products": [
    {
      "id": 9216822059,
      "title": "Nike air max neuves jamais portées",
      "price": "20.0",
      "total_item_price": "21.70",
      "currency": "EUR",
      "brand": "Nike",
      "size": "35.5",
      "condition": "Neuf sans étiquette",
      "favourite_count": 15,
      "view_count": 0,
      "seller": {
        "id": 41477397,
        "login": "em.ch",
        "profile_url": "https://www.vinted.fr/member/41477397-emch"
      },
      "photo": "https://images1.vinted.net/t/.../f800/....jpeg",
      "url": "https://www.vinted.fr/items/9216822059-nike-air-max-neuves-jamais-portees"
    }
  ]
}
```

```json
// 2. Read post (step 3)
{
  "success": true,
  "post": {
    "id": 9216822059,
    "title": "Nike air max neuves jamais portées",
    "description": "Erreur de commande sur la pointure, elles n'ont jamais été portées, modèle beige et rose",
    "price": "20,00 €",
    "total_price": "21,70 €",
    "currency": "EUR",
    "brand": "Nike",
    "size": "35.5",
    "condition": "Neuf sans étiquette",
    "item_condition_schema": "NewCondition",
    "color": "Beige, Rose",
    "category": "Femmes Baskets",
    "upload_date": "Il y a 4 heures",
    "favourites": 15,
    "seller": "em.ch",
    "seller_location": "Paris, France",
    "image": "https://images1.vinted.net/t/.../f800/....webp",
    "url": "https://www.vinted.fr/items/9216822059-nike-air-max-neuves-jamais-portees"
  }
}
```

```json
// 3. Blocked / unauthenticated (no live session cookies, or anti-bot wall)
{
  "success": false,
  "error_reasoning": "GET /api/v2/catalog/items returned 401 Www-Authenticate: Bearer — no _vinted_fr_session/access_token_web cookies. Bootstrap a stealth browser session on https://www.vinted.fr/ first, then call the API from page context."
}
```
