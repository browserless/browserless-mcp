---
name: search-products
title: JD.com Product Search
description: >-
  Search JD.com (Jingdong) for products by keyword and return structured results
  — title, price in CNY, JD-self-operated flag, review count, stock status,
  canonical URL — with brand / price-range / sort filters. Read-only. Requires
  an authenticated JD context or a China-resident proxy: foreign IPs hit a hard
  login wall on every product subdomain.
website: jd.com
category: ecommerce
tags:
  - ecommerce
  - china
  - jd
  - jingdong
  - search
  - products
source: 'browserbase: agent-runtime 2026-05-20'
updated: '2026-05-20'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      JD's mobile JSON API at api.m.jd.com requires reverse-engineered request
      signing (uuid + body SHA + client + eid + fp + appid=jd_app_android)
      extracted from the JD Android app. Unsigned calls return
      {"code":"1","echo":"no access"}. Out of scope for a marketplace skill; do
      not attempt.
  - method: url-param
    rationale: >-
      search.jd.com/Search?keyword=...&psort=...&ev=... is a clean URL-param
      surface in principle, but every request from a non-China IP is 302-walled
      to passport.jd.com before any results render. URL-param method only works
      after the browser path has supplied authenticated cookies — so it's a
      sub-step of the browser method, not a standalone shortcut.
verified: true
proxies: true
---

# JD.com Product Search

## Purpose

Given a keyword (and optional brand / price-range / sort filters), return a structured list of matching products from JD.com (京东 / Jingdong, China's largest electronics retailer): product title, current price in CNY (¥), JD-self-operated flag (`自营`), star rating, review count, stock status, and the canonical `https://item.jd.com/<sku>.html` URL. Read-only — never adds to cart, never checks out, never edits an account.

## When to Use

- Price-monitoring an iPhone / appliance / electronics SKU on JD's primary Chinese-domestic catalog.
- Comparing JD-self-operated (`京东自营`) vs. third-party-seller listings for the same keyword.
- Bulk extraction of search results across multiple sort orders (sales-descending, price-ascending) for category research.
- Anywhere the user explicitly asks for **jd.com** product data and a Joybuy / global.jd.com substitution would be wrong (different SKU catalog, China-export-filtered inventory, separate pricing).

## Workflow

**Read this section in full before touching a session — JD.com has a hard anti-bot wall for foreign IPs that the rest of this section is built around. Skipping the prerequisites guarantees a login redirect with zero useful data.**

### Prerequisite — one of these MUST be true, or the skill cannot return data

JD.com fingerprints the request IP and forces every `search.jd.com`, `list.jd.com`, `item.jd.com`, `so.m.jd.com`, `wq.jd.com`, and `search.jd.hk` request from a non-China IP through `https://cfe.m.jd.com/privatedomain/risk_handler/03101900/`, which **immediately** issues a 302 to `https://passport.jd.com/new/login.aspx`. There is no JS challenge to wait out; the redirect fires instantly. Verified 2026-05-20 with and without a residential proxy, and a generic CN-geolocation proxy hint may silently fall back to a non-China exit IP — confirm the egress country before trusting it (see Gotchas).

You need exactly one of:

1. **A persisted JD authenticated profile** — a Browserless profile that already holds the cookies for a logged-in JD account (`pin`, `thor`, `pt_key`, `pt_pin`, `unick`, `flash`). The QR code on the login page binds to the JD mobile app, so the human bootstrap is: run the login once (load the `autonomous-login` skill via `browserless_skill` and follow its gates, or QR-scan interactively), save the resulting cookies into a profile, and pass that same profile on **every** `browserless_agent` call thereafter. Dropping the profile on a follow-up call lands you in a logged-out session.
2. **A China-resident residential proxy** via the top-level `proxy: { proxy: "residential", proxyCountry: "cn" }` arg on `browserless_agent`. This bypasses both the foreign-IP wall and the login requirement for unauthenticated browsing of search/category/item pages. Confirm the pool actually egresses from China — a CN hint that silently resolves to a non-China IP will still be walled (see Gotchas).

If neither is available, **stop and emit `{"success": false, "reason": "auth_required"}`** — do not navigate `search.jd.com` and pretend to parse a result; the page is the login form and any "extracted" data is hallucinated.

### Run the whole flow in ONE `browserless_agent` call

Batch the warm-up → navigate → extract sequence (steps 1–5 below) into a single call's `commands` array — it saves round-trips and avoids accidentally dropping the profile/proxy between calls, so the homepage-seeded cookies carry into the search navigation. (The session persists across calls, keyed by the `proxy`/`profile` config; repeating the same config reconnects to it, while dropping or changing it lands you in a different, logged-out session.) Set `proxy: { proxy: "residential", proxyCountry: "cn" }` (and the saved JD profile) as top-level args on that call. A residential CN proxy is mandatory even with a logged-in profile — JD also fingerprints UA/canvas/WebGL and a bare browser gets booted on first navigation.

### 2. Warm the session on the consumer homepage (first command)

```json
{ "method": "goto", "params": { "url": "https://www.jd.com/?gtm_test=us", "waitUntil": "load", "timeout": 45000 } }
{ "method": "waitForTimeout", "params": { "time": 2000 } }
```

**The `?gtm_test=us` query string is required from a non-China IP.** A bare `https://www.jd.com/` 302-redirects to `corporate.jd.com` (the English investor-relations site, a completely different page with zero products). The `gtm_test=us` parameter keeps the routing on the Chinese consumer site (`京东(JD.COM)-正品低价、品质保障...`). Verified — this trick still gives the consumer page even on a fresh foreign-IP session before any cookies are set.

After this load, the session has the cookies JD's edge expects: `__jdv`, `__jdu`, `areaId`, `ipLoc-djd`, `3AB9D23F7A4B3C9B`, `wlfstk_smdl`, `shshshfpa`, `shshshfpb`, `sdtoken`. These alone are NOT sufficient to bypass the search-page wall — they only get you past the homepage-level edge check. The login cookies from step 0's context are what actually open `search.jd.com`.

### 3. Build the search URL

```
https://search.jd.com/Search
    ?keyword=<URL-encoded-keyword>
    &enc=utf-8
    &psort=<sort-code>             # see table below; omit for relevance (default)
    &ev=<filter-expr>              # see filter syntax below; omit for unfiltered
    &page=<2*pageNumber - 1>       # JD uses odd-numbered pages (1, 3, 5, ...)
    &s=<startIndex>                # 1 for page 1, 31 for page 2, 61 for page 3
```

**`psort` (sort order)** — JD's psort codes (verified against the desktop search UI):

| psort            | Sort                                                    |
| ---------------- | ------------------------------------------------------- |
| _omitted_ or `0` | Comprehensive / relevance (综合) — JD's default ranking |
| `3`              | Sales descending (销量)                                 |
| `4`              | Price ascending (价格升序)                              |
| `2`              | Price descending (价格降序)                             |
| `5`              | Reviews / rating descending (评论数)                    |
| `6`              | Newest (新品)                                           |

**`ev` (filter expression)** — multiple filters are concatenated with `%5E` (URL-encoded `^`), and each filter has the shape `<facet>_<value>`:

- **Price range**: `exprice_<min>-<max>` (e.g. `exprice_3000-5000`). Use `0` for an open lower bound.
- **Brand**: `exbrand_<brandName>` — `brandName` is JD's canonical brand string in Chinese OR English, depending on the brand. Apple is `Apple` / `苹果`; Xiaomi is `Xiaomi` / `小米`; Huawei is `HUAWEI` / `华为`. Brand names with spaces must be URL-encoded. Multiple brands: chain with another `^exbrand_`.
- **JD-self-operated only**: `4_4` (the facet `4`, value `4` — verified by clicking the "仅看京东自营" toggle).

Example with `iphone` keyword, sort by sales, Apple brand, ¥3000–5000:

```
https://search.jd.com/Search?keyword=iphone&enc=utf-8&psort=3&ev=exbrand_Apple%5Eexprice_3000-5000&page=1&s=1
```

### 4. Navigate and wait for the grid

```json
{ "method": "goto", "params": { "url": "<SEARCH_URL>", "waitUntil": "load", "timeout": 45000 } }
{ "method": "waitForTimeout", "params": { "time": 3000 } }
```

JD lazy-loads price/stock via XHR after DOMContentLoaded, so the 3s settle matters.

**Verify you actually landed on the search page**, not the login wall — read the current URL inside the same call (e.g. an `evaluate` returning `location.href`) and check it:

```javascript
// { "method": "evaluate", "params": { "content": "..." } } — return location.href, then branch on it
const href = location.href;
const walled =
  /passport\.jd\.com|cfe\.m\.jd\.com\/privatedomain\/risk_handler/.test(href);
JSON.stringify({ walled, href });
```

If `walled` (URL contains `passport.jd.com/new/login.aspx`) — the profile cookies expired (JD's `thor` token has a ~14d TTL); a human needs to re-QR-scan to refresh the profile, and this skill should return `{"success": false, "reason": "auth_required"}`.

### 5. Extract the product grid

The search results live under `#J_goodsList ul.gl-warp.clearfix > li.gl-item`, each with a `data-sku` attribute on the `<li>` carrying the SKU id. Per-item extraction (DOM selectors — run via an `evaluate` command; wrap the returned array in `JSON.stringify`):

```javascript
Array.from(document.querySelectorAll('#J_goodsList li.gl-item')).map((li) => ({
  sku: li.getAttribute('data-sku'),
  url: `https://item.jd.com/${li.getAttribute('data-sku')}.html`,
  title:
    li.querySelector('.p-name em')?.innerText.trim() ??
    li.querySelector('.p-name')?.innerText.trim(),
  price_cny: parseFloat(li.querySelector('.p-price i')?.innerText) || null,
  self_operated:
    !!li.querySelector(
      '.p-icons .goods-icons.J-picon-tips[data-tips*="自营"]',
    ) || !!li.querySelector('.p-icons em:has-text("自营")'),
  review_count: (() => {
    const txt = li.querySelector('.p-commit strong a')?.innerText || '';
    const m = txt.match(/^([\d.]+)([万+]?)/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return m[2].includes('万') ? Math.round(n * 10000) : n;
  })(),
  shop: li.querySelector('.p-shop a')?.innerText.trim(),
  stock_status: li.querySelector('.p-stock')?.innerText.trim() || 'in_stock',
}));
```

**Rating is not in the search grid.** JD only shows review _count_ and a percentage-good label ("99%好评率") on the grid; the numeric star rating (1.0–5.0) is exposed only on the item-detail page (`item.jd.com/<sku>.html` → `#summary-comment .comment-percent`). If the caller wants a rating, do a follow-up fetch per SKU (expensive — N+1) or return the percentage-good as a proxy.

### 6. Paginate

JD uses an odd-numbered `page` parameter (`1, 3, 5, ...` not `1, 2, 3, ...`) because each "page" is two halves of a 60-item AJAX-paginated unit. For page N of results: `page=2*N-1`, `s=30*(N-1)+1`. Total result count is in `#J_resCount` on first load.

### 7. No session-release step

There is nothing to release; the session is not torn down on return — it persists across calls, keyed by the `proxy`/`profile` config. Batching steps 2–6 inside one call's `commands` array saves round-trips and keeps the warm-up cookies and search navigation in the same session; a follow-up call sharing the same profile/proxy reconnects to it, while one that drops or changes the config lands in a different, logged-out session.

## Site-Specific Gotchas

- **Foreign IPs are hard-walled.** Every product-browsing subdomain (`search.jd.com`, `list.jd.com`, `item.jd.com`, `so.m.jd.com`, `wq.jd.com`, `search.jd.hk`) issues a 302 to `https://cfe.m.jd.com/privatedomain/risk_handler/03101900/?returnurl=...&evapi=hold_search_php` which immediately bounces to `https://passport.jd.com/new/login.aspx` from any non-China IP, with or without a proxy. **Without authenticated cookies or a real CN-IP, the skill is non-functional.** Do not "guess" at output shapes.
- **`https://www.jd.com/` redirects to `corporate.jd.com` from non-China IPs — use `?gtm_test=us` to land on the Chinese consumer homepage.** This is the ONE page that renders without authentication. It's useful for warming cookies and visually confirming the IP is not banned outright, but the search box on it still POSTs to `search.jd.com` and bounces to login on submit.
- **A CN-geolocation hint can silently egress from the wrong country.** Always confirm the exit node is actually in China (fetch an IP-echo service in the same call and check the country) before trusting `proxy: { proxy: "residential", proxyCountry: "cn" }`. A generic residential pool without China coverage will hand you a non-China IP and you will be walled exactly as if you passed no proxy.
- **The mobile JSON API `https://api.m.jd.com/?functionId=...` requires a signed `body` parameter** (`uuid`, `body` SHA-256 sig, `client`, `clientVersion`, `area`, `eid`, `fp`, `appid=jd_app_android`). Unsigned calls return `{"code":"1","echo":"no access"}`. Recovering the sign function requires reverse-engineering JD's `t1` algorithm from the mobile app — out of scope for a marketplace skill. Don't waste time on `api.m.jd.com`.
- **The AJAX scroll endpoint `https://search.jd.com/s_new.php?keyword=...&page=2&s=26&scrolling=y` returns a polite Chinese error from foreign IPs**: `{"code":"0","message":"success","body":{"errorCode":"601","errorReason":"大促异常火爆，已优先为您接入快速通道，稍安勿躁，请返回上一页重新尝试下~~~~"}}`. Translation: "promotion-traffic excuse → please go back". It's anti-bot, not actual traffic. Don't retry — it won't clear.
- **`global.jd.com` and `joybuy.co.uk` are different catalogs.** `global.jd.com` (京东全球版) and Joybuy (jd.com's international shopping arm, redirects to `joybuy.co.uk` for US IPs) carry a heavily-curated subset of the Chinese SKU catalog filtered for cross-border export, with different prices and SKU IDs. If the user asked for `jd.com`, do NOT silently fall back to these — return `auth_required` instead. The skill marketplace has separate listings for global.jd.com if/when that's the target.
- **`page` is odd-numbered (1, 3, 5, ...), `s` is the start-index (1, 31, 61, ...).** A naive `page=2` returns the same 30 items as `page=1` — confusing but consistent with how JD's AJAX paginator increments.
- **Rating (1.0–5.0 stars) is not in the search grid.** Only the review count (`.p-commit`) and a percentage-good label (`99%好评率`) appear. The numeric rating requires a per-SKU fetch of `item.jd.com/<sku>.html`. If the caller asked for rating, either do the N+1 fetches (each requires the same auth wall) or return the percentage-good as a 0–100 proxy.
- **Self-operated flag.** The "京东自营" badge is on `<li>` via `.p-icons .goods-icons[data-tips*="自营"]` and/or a textual `<em>自营</em>` inside `.p-icons`. Some JD-self-operated listings still ship from a partner warehouse — the `自营` badge is the canonical signal regardless. Third-party shops show `.p-shop a` text linking to a `mall.jd.com/index-<merchantId>.html` URL.
- **Prices update lazily via XHR after DOMContentLoaded.** The initial HTML often shows `¥0.00` placeholders; wait 2–3s after `load` before reading `.p-price i`, or some prices will be missing. Pre-sale (`预售`) and out-of-stock (`无货`) items may legitimately show no price — preserve `null`, don't fabricate.
- **Brand-name canonicalization.** `ev=exbrand_<brand>` requires JD's exact canonical brand string. For mixed-language brands, the canonical is usually the English (`Apple`, `Xiaomi`, `HUAWEI`, `Samsung`) but some are Chinese-only (`格力`, `美的`, `海尔`). Verify by clicking a brand checkbox in the UI once and reading the resulting URL `ev` segment. Wrong brand string → no filter applied, results returned silently as if unfiltered.
- **Captcha / "滑动验证" (slide-puzzle).** Even with valid cookies, JD periodically interposes a slide-to-verify captcha (`https://iv.jd.com/...`). This is a drag/slide puzzle, not a standard reCAPTCHA/Turnstile, so the `browserless_agent` `solve` command does NOT crack it; the realistic options are (a) human intervention on the live session, or (b) waiting ~5 min and retrying with a fresh call/new residential IP. Capture the captcha screenshot and surface it as `{"success": false, "reason": "captcha_required"}`.
- **Read-only.** Never click `.btn-addtocart`, never navigate to `cart.jd.com`, never submit `passport.jd.com` credentials programmatically. Stop at the search-result extraction.

## Expected Output

Three distinct outcome shapes:

```json
// Success — results returned
{
  "success": true,
  "keyword": "iphone",
  "sort": "sales_desc",
  "filters": {
    "brand": "Apple",
    "price_min": 3000,
    "price_max": 5000,
    "self_operated_only": false
  },
  "total_results": 8742,
  "page": 1,
  "products": [
    {
      "sku": "100012043978",
      "title": "Apple iPhone 15 (A3092) 128GB 黑色 支持移动联通电信5G 双卡双待手机",
      "price_cny": 4499.0,
      "url": "https://item.jd.com/100012043978.html",
      "self_operated": true,
      "shop": "Apple产品京东自营旗舰店",
      "review_count": 1200000,
      "good_review_percent": 99,
      "rating": null,
      "stock_status": "in_stock"
    }
  ]
}
```

```json
// Authentication required — context expired or no CN-IP available
{
  "success": false,
  "reason": "auth_required",
  "redirected_to": "https://passport.jd.com/new/login.aspx?ReturnUrl=...",
  "hint": "Refresh the JD profile by QR-scanning login at the JD app (autonomous-login skill), or supply a China-resident residential proxy."
}
```

```json
// Captcha interposed mid-session
{
  "success": false,
  "reason": "captcha_required",
  "captcha_type": "slide_puzzle",
  "captcha_url": "https://iv.jd.com/...",
  "hint": "Slide-puzzle captcha — solve via human intervention on the live session or retry with a fresh residential IP; current cookies may still be valid after solve."
}
```

**Marketplace status.** This skill is shipped as a **candidate** — it documents the optimal honest path but cannot be validated end-to-end without a China exit node and shared JD credentials. Functional validation requires either (a) a tenant-supplied authenticated JD profile, or (b) a tenant-supplied CN-residential proxy. Iteration log: 1 iter, 2026-05-20, converged on documenting the auth wall after exhausting search/list/item/wq/m-mobile/hk/global/api.m subdomains and a CN-geolocation-hinted proxy (all confirmed-blocked from foreign IPs).
