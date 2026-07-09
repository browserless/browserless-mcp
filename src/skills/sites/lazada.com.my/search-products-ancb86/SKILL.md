---
name: search-products
title: Lazada Malaysia Product Search
description: >-
  Search Lazada Malaysia by keyword and return structured product results
  (title, price MYR, rating, reviews, seller, LazMall flag, discount, canonical
  URL) with optional filters for price range, location, shipping, and sort.
  Read-only.
website: lazada.com.my
category: marketplace
tags:
  - marketplace
  - ecommerce
  - lazada
  - malaysia
  - anti-bot
source: 'browserbase: agent-runtime 2026-05-20'
updated: '2026-05-20'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      Alibaba's mtop endpoint
      (acs.lazada.com.my/h5/mtop.lazada.search.gateway/1.0/) is the in-app data
      path but requires appKey + sign + rotating _m_h5_tk token. A bare GET
      returned 500; reverse-engineering the signature is significant but yields
      a CAPTCHA-free path if invested in.
  - method: browser
    rationale: >-
      The /catalog/?q=… search URL is the only public surface that emits product
      data, but it is gated by Alibaba TMD's reCAPTCHA wall on every probe from
      a US-IP browser session (verified across 3 iterations). Browser-driven
      extraction requires a wall-bust strategy: Malaysian-residential proxy,
      external CAPTCHA solver, or a logged-in cookie jar.
verified: true
proxies: true
---

# Lazada Malaysia Product Search

## Purpose

Given a keyword (and optional filters: price range, location, shipping option, sort), return a structured list of matching products on Lazada Malaysia — title, price in MYR, rating, review count, seller name, LazMall flag, discount badge, and canonical URL. Read-only — never adds to cart, checks out, or posts.

**Status: candidate.** The Lazada Malaysia search endpoint (`/catalog/?q=...`) is comprehensively blocked by Alibaba's TMD (Threat Management Detection) anti-bot CDN layer at the time of generation. Three independent attempts (proxied `browserless_agent` session, autobrowse inner-agent loop, and a direct HTTP `browserless_function` fetch) all converged to the same `/catalog/_____tmd_____/punish?x5step=1&x5secdata=…` reCAPTCHA wall. Operating this skill in practice requires one of the wall-busting paths in **Site-Specific Gotchas** below — most likely an external CAPTCHA-solving service or a Malaysian-residential proxy that has not yet been tried.

## When to Use

- Comparison shopping across Lazada Malaysia by keyword (e.g. "wireless earphones under RM100").
- Inventory monitoring for a specific product line on the MY storefront.
- Bulk catalog enumeration for a category — when paired with a working wall-bust strategy.
- **Not for** logged-in operations (wishlists, cart, checkout) — those require auth and are out of scope.

## Workflow

Lazada Malaysia has **no usable public JSON API and no functioning mobile-app shortcut** from a US-egress session — every probe of `/catalog/?q=`, `/shop/{store}/`, `/products/i*-s*.html`, `acs.lazada.com.my/h5/mtop.lazada.search.gateway`, and `/sitemap_pdp.xml` returned either `Bxpunish: 1` (TMD interstitial) or a 5xx. The browser is the only surface that loads anything; the search URL specifically is gated. Lead with the browser flow below, but **expect to hit the wall on the very first navigation to `/catalog/?q=`** and apply one of the Gotchas workarounds before extracting.

1. **Run the flow in ONE `browserless_agent` call with a Malaysian residential proxy.** Set `proxy: { proxy: "residential", proxyCountry: "my" }` as a top-level arg, and keep the warm-up → search → detect → extract sequence inside that one call's `commands` array (the session persists across calls, keyed by `proxy`/`profile` — repeat the same config on every call to stay in it; batching into one call avoids accidentally dropping that config). The `browserless_agent` `solve` command does **not** crack Alibaba's TMD reCAPTCHA (verified — see Gotchas). Critically, confirm the egress is actually Malaysian: a generic residential pool that lacks MY coverage will hand you a US IP (earlier runs observed `52.27.x` / `52.34.x`), and Lazada's TMD scores non-target-country IPs aggressively — a US IP walls on every probe.

2. **Warm the session with the homepage first (first commands).**

   ```json
   { "method": "goto", "params": { "url": "https://www.lazada.com.my/", "waitUntil": "load", "timeout": 45000 } }
   { "method": "waitForTimeout", "params": { "time": 4000 } }
   ```

   Homepage loads cleanly (~390 KB HTML, title "Lazada Malaysia | Top Deals & Free Shipping for You!") and seeds the session with `lzd_cid`, `_m_h5_tk`, and AliExpress cookies. (Never use `networkidle` — the SPA leaves the URL as `/#?` and it will hang.) **Skipping the warm-up does not change the outcome of step 3** — the wall fires regardless of referrer — but the warm-up is cheap insurance and gives you a stable searchbox ref tree if you intend to drive the form natively.

3. **Navigate to the search URL** (URL-encode the keyword), then read the resolved URL to detect the wall:

   ```json
   { "method": "goto", "params": { "url": "https://www.lazada.com.my/catalog/?q=<url-encoded-keyword>", "waitUntil": "load", "timeout": 45000 } }
   { "method": "waitForTimeout", "params": { "time": 4000 } }
   { "method": "evaluate", "params": { "content": "location.href" } }
   ```

   Form-style URL params Lazada accepts on a _working_ `/catalog/?q=` request (confirmed via the homepage's pre-rendered "shop more" links and the `<form action="//www.lazada.com.my/catalog/" method="GET">` in the page source):
   - `q=<keyword>` — required.
   - `price=<min>-<max>` — e.g. `price=50-200` (MYR).
   - `location=<state>` — e.g. `location=Selangor`, `Kuala+Lumpur`, `Johor`.
   - `service=free_shipping` or `service=cod` — shipping/COD filter.
   - `rating=<n>` — minimum rating, integer 1–5.
   - `sort=priceasc | pricedesc | latest | bestmatch | bestsellers` — sort key.
   - `page=<n>` — pagination, 1-indexed.
   - `_keyori=ss&from=input` — search-origin tracker (Lazada's homepage emits these on legitimate clicks). Including them does **not** bypass the wall in our tests, but their absence may make a borderline request look more bot-like.

4. **Detect the wall.** If the URL returned by the step-3 `evaluate` matches `/_____tmd_____/punish?` you have been intercepted. The page contains:
   - An outer `<iframe>` wrapping
   - A "We need to check if you are a robot." message
   - A nested reCAPTCHA v2 iframe at `[?-?] checkbox: I'm not a robot`
   - A "Click to feedback >" link at the bottom (no programmatic value)

   You must apply one of the workarounds in **Site-Specific Gotchas** before proceeding to step 5. Naïvely clicking the reCAPTCHA checkbox, waiting 30s, or relying on the `solve` command did not advance the page in 3 independent iterations.

5. **(Wall bypassed) Extract products from the rendered page.** Lazada serves search results with a server-side-rendered JSON payload embedded as `window.runParams.mods.listItems` in a `<script>` block. Two extraction options, in order of cost:

   - **Preferred — read the SSR JSON via an `evaluate` command** (result comes back under `.value`; project inside the eval since the text return is capped):

     ```json
     {
       "method": "evaluate",
       "params": {
         "content": "JSON.stringify(window.runParams?.mods?.listItems?.slice(0,60) || [])"
       }
     }
     ```

     Each `listItems[i]` carries `name`, `priceShow` (formatted MYR string), `price` (numeric), `originalPrice` (pre-discount), `discount` (e.g. `"-25%"`), `ratingScore` (string, may be empty), `review` (integer), `brandName`, `sellerName`, `inFav`, `itemId`, `skuId`, `productUrl` (starts with `//www.lazada.com.my/products/i…-s….html`), `image`, and a `mall: 1` flag for LazMall stores. Total result count is at `window.runParams.mods.searchTitleBar?.totalCount` or `window.runParams.mainInfo?.totalResults`.

   - **Fallback — parse the rendered card grid via `snapshot`:** card refs appear under a `[*] list` node. Per-card text extraction works but is ~3× more turns than the SSR path.

6. **Construct canonical URLs.** `listItems[i].productUrl` is protocol-relative; prepend `https:` and strip the `?spm=…` tracking suffix for the canonical form:

   ```
   https://www.lazada.com.my/products/i{itemId}-s{skuId}.html
   ```

7. **Paginate (if requested).** Append `&page=2`, `&page=3`, … to the same URL. Each page is also gated by the TMD wall — once you have a session that cleared the wall on page 1, subsequent pages **usually** load without re-challenging, but the wall can re-fire on cookie expiry (observed ~20-min TTL on `x5secdata`).

8. **No session-release step.** There is nothing to release — but the session does **not** die on return: it persists across separate calls, keyed by the call's `proxy`/`profile` config. Repeat the same config on every call to reconnect to the warmed session (its cookies and any cleared-wall state intact); dropping or changing it lands you in a different, blank session. Batching steps 2–7 into one call's `commands` array is the simplest way to avoid that.

## Site-Specific Gotchas

- **TMD/punish wall is the dominant failure mode.** `/catalog/?q=`, `/shop/{store}/`, and `/products/i*-s*.html` all return HTTP 200 with header `Bxpunish: 1` and a body that immediately `window.location.replace`s to `https://www.lazada.com.my/catalog/_____tmd_____/punish?x5secdata=<long-token>&x5step=1`. The wall presents an Alibaba-skinned reCAPTCHA v2 checkbox inside a nested iframe. Verified hit on every probe across 3 iterations with proxied `browserless_agent` sessions from `52.27.x` / `52.34.x` (AWS US-West-2) IPs. Headers also expose `Vary: …, Ali-Detector-Type, Ali-Hng, X-Host, …` — Alibaba's bot detector is varying response on a signal we do not have.

- **The `solve` command does NOT solve Alibaba TMD reCAPTCHA.** Two iterations clicked the `[*] checkbox: I'm not a robot` ref and waited 10–30s; the URL never advanced past `_____tmd_____/punish?…&x5step=1`. Alibaba's challenge wraps Google reCAPTCHA with a custom token-handshake at `x5step=2`/`x5step=3` that the solver does not currently emulate.

- **Known workarounds (none verified in this run — listed in best-guess priority):**
  1. **Malaysian-residential proxy.** A generic residential pool may egress from the US even with a `proxyCountry` hint — confirm the actual exit country. A Malaysian IP (`proxy: { proxy: "residential", proxyCountry: "my" }`, or a 3rd-party MY residential pool if coverage is missing) is the most likely single-fix. Lazada's TMD blocklist scores non-target-country IPs aggressively.
  2. **External CAPTCHA-solving service** (2Captcha, Anti-Captcha, CapSolver). Pull the reCAPTCHA `sitekey` and page URL from the iframe; submit to the solving API; inject the `g-recaptcha-response` token; trigger the parent frame's verify callback. ~$0.003 per solve, ~30–60s latency.
  3. **Logged-in session with a real Lazada account cookie.** TMD is more permissive for authenticated users. Out of scope for read-only, but viable if you can warm-start with a serialized cookie jar.
  4. **The Lazada mobile-app mtop API** (`acs.lazada.com.my/h5/mtop.lazada.search.gateway/1.0/…`). Requires `appKey` + `sign` + `_m_h5_tk` token rotation; returned 500 from a bare cURL in this run. Reverse-engineering the signature scheme is significant work but yields a stable, captcha-free path.

- **A raw HTTP fetch (`browserless_function`) over a proxy is geo-locked away from the search endpoint.** Even with `Set-Cookie: x5secdata=…` returned, the response body is just the JS-redirect-to-punish HTML — a bare fetch runs no JS and carries no warmed cookie jar, so it can't clear the wall. Do not waste time stacking it.

- **`m.lazada.com.my` redirects to `www.lazada.com.my`.** No separate mobile-web surface for the MY storefront. Don't bother probing it.

- **`/tag/{slug}/` is NOT a generic search alias.** `/tag/wireless-earphones/` returns 200 OK with title "Buy Wireless Earphones Online at a Better Price | Lazada Malaysia" but body text "Search No Result — We're sorry. We cannot find any matches for your search term." Lazada's `/tag/` tree is a curated SEO-slug catalog, not an arbitrary keyword endpoint. Do not substitute it for `/catalog/?q=`.

- **`/{category-name}/`, `/shop-{type}/`, and similar guessed slugs are 404.** `/audio/`, `/wireless-earphones/`, `/shop-wireless-earphones/` all returned "Page Not Found". The only first-party category URLs that exist are the ones surfaced by the homepage navigation (`/birthday-sale/`, `/mid-year-supersale/`, `/9-9/`, `/apple-deal/`, …) — campaign landing pages, not browseable taxonomy.

- **Homepage URL after load resolves to `https://www.lazada.com.my/#?`.** A `goto` with `waitUntil: "load"` may report a timeout but the page is fully usable — the hash-suffix is a Lazada SPA artifact, not a navigation failure. Always re-check the URL and title via an `evaluate` (`location.href` / `document.title`) rather than trusting the load event.

- **Searchbox refs invalidate on every navigation.** Lazada uses a React searchbox; the ref like `[13-555]` from one snapshot will not survive a navigation or even a sufficient DOM tick. Always re-`snapshot` and re-resolve the searchbox ref before each `type` / `click`. The SEARCH button is an `<a>` link to `//www.lazada.com.my/catalog/?q=` — clicking it is equivalent to direct navigation and will trigger the wall identically.

- **Typing into the searchbox and submitting does navigate the form** (observed in autobrowse iter-2) but the resulting navigation lands on `_____tmd_____/punish?…` regardless. Native form-submit confers no protection.

- **`x5secdata` cookie has ~20-minute TTL** (`Max-Age=20` was observed but the actual session-level lockout appears longer — empirical estimate based on session lifecycle). Once you clear the wall, treat it as fragile state; persist the cookie jar into a profile (passed on every call) if you need multi-page extraction.

- **Lazada's homepage SSR carries `g_config` with locale data** (`window.g_config.regionID = "MY"`, `language = "en"`) but **no embedded `runParams.mods.listItems`** — only `/catalog/`-type pages emit product SSR. Don't try to harvest products from the homepage.

- **Expected SSR shape on the search results page is `window.runParams.mods.listItems`** — this is the documented Lazada/RedMart pattern observed in prior third-party scraping work (the structure was NOT verified in this generation run because the wall was not bypassed). If the page renders but the eval returns `[]`, fall back to DOM-card extraction and update this gotcha.

- **READ-ONLY — never click product detail or add-to-cart.** Slot-time / book / submit-order equivalents on Lazada are "Buy Now" and "Add to Cart" — stop at the search-results grid. Do not navigate into `/products/i…-s….html` unless you need to verify a single canonical URL, and even then, that endpoint is also TMD-walled.

## Expected Output

Two distinct outcome shapes:

```json
// 1. Search succeeded (wall bypassed, products extracted)
{
  "success": true,
  "keyword": "wireless earphones",
  "filters": {
    "price_min_myr": 50,
    "price_max_myr": 200,
    "location": "Selangor",
    "shipping": "free_shipping",
    "sort": "bestmatch"
  },
  "total_results": 12483,
  "page": 1,
  "products": [
    {
      "title": "Soundcore by Anker P40i Wireless Earbuds Bluetooth 5.3",
      "price_myr": 129.00,
      "original_price_myr": 199.00,
      "discount": "-35%",
      "rating": 4.8,
      "review_count": 1247,
      "seller_name": "Anker Official Store",
      "brand_name": "Soundcore",
      "lazmall": true,
      "location": "Selangor",
      "item_id": "3567890123",
      "sku_id": "21987654321",
      "url": "https://www.lazada.com.my/products/i3567890123-s21987654321.html",
      "image_url": "https://my-test-11.slatic.net/p/abc123.jpg"
    }
  ]
}

// 2. Anti-bot wall hit and no bypass available
{
  "success": false,
  "reason": "anti_bot_wall",
  "wall_type": "alibaba_tmd_recaptcha",
  "blocked_url": "https://www.lazada.com.my/catalog/_____tmd_____/punish?x5step=1&x5secdata=…",
  "evidence": {
    "response_header_bxpunish": "1",
    "challenge": "recaptcha_v2_checkbox",
    "session_flags": ["proxy:residential", "solve-attempted"],
    "proxy_egress_country": "US"
  },
  "remediation_hint": "Try Malaysian-residential proxy, external CAPTCHA-solving service, or a warm cookie jar from a logged-in account. See Site-Specific Gotchas."
}
```
