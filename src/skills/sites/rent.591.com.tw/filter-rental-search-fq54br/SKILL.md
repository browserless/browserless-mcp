---
name: filter-rental-search
title: 591租屋網 Filter Rental Search
description: >-
  Apply user-supplied filters (region, district, price, room count, property
  type, area, amenities, sort) on rent.591.com.tw and return matching rental
  listings with title, price, layout, area, floor, address, MRT distance, and
  detail URL.
website: rent.591.com.tw
category: real-estate
tags:
  - real-estate
  - rental
  - taiwan
  - '591'
  - search
  - filters
  - read-only
source: 'browserbase: agent-runtime 2026-05-20'
updated: '2026-05-20'
recommended_method: url-param
alternative_methods:
  - method: browser
    rationale: >-
      The filter UI is fully clickable via .item-info card extraction +
      label-text matching, but every UI click maps 1:1 to a URL query-string
      param — constructing the URL directly skips 5-10 click-then-snapshot
      turns. Use the click path only to discover an unknown filter slug, then
      prefer URL params for production.
  - method: api
    rationale: >-
      Direct API path /v3/web/rent/list observed in the SSR X-Server-Monitor
      header is 404 to external clients — only callable server-side from the
      Nuxt SSR layer. No public JSON endpoint exists for filtered listings; the
      SSR'd HTML is the canonical data surface.
verified: false
proxies: false
---

# 591租屋網 — Filter Rental Search

## Purpose

Apply user-supplied rental filters (city, district, price range, room count, property type, area, amenities, sort order) on `rent.591.com.tw` (Taiwan's largest rental listings site) and return the matching listings — title, price, layout, area (坪 / ping), floor, address, district, distance to nearest metro station, agent/owner, last-updated time, and the canonical detail-page URL. Read-only — never contacts landlords, never logs in.

## When to Use

- "Find me 2-bedroom apartments in Taipei 大安區 / 信義區 between NT$15,000 and NT$25,000."
- "Cheapest studios (套房) near a metro station in 新北市 板橋區."
- Rental-market monitoring: hourly/daily polling for new listings (`sort=posttime_desc&other=newPost`).
- Cross-region rent comparison (region 1 = Taipei, 3 = New Taipei, 8 = Taichung, 17 = Kaohsiung).
- Anywhere you would otherwise scrape 591 with brittle CSS selectors — **filter via URL params, then read `.item-info` cards**.

## Workflow

The recommended path is **URL-param filtering + DOM extraction** — every filter the site UI exposes is also a query-string param, so a single `browserless_agent` `goto` with the right URL replaces 5–10 click-then-snapshot turns. The page is server-rendered (Nuxt SSR) so `.item-info` cards are present in the initial DOM before any JS runs. **Anti-bot is minimal** — a plain `browserless_agent` (no `proxy` arg) loads and renders listings fine. Add a residential `proxy` only if you start seeing ratelimit pages.

### 1. Construct the filter URL

Base: `https://rent.591.com.tw/list?{params}`

| Param     | Meaning                       | Syntax                                      | Example                                                                   |
| --------- | ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `region`  | City (required, single value) | integer                                     | `region=1` (台北市)                                                       |
| `section` | District(s) within region     | comma-list of integers                      | `section=5,7` (大安+信義)                                                 |
| `kind`    | Rental type                   | comma-list of integers                      | `kind=2,1` (studio + whole apt)                                           |
| `price`   | Rent range NT$/month          | `MIN_MAX`; comma-join multiple ranges       | `price=15000_25000` or `price=0_5000,30000_40000`                         |
| `layout`  | Room count                    | comma-list of `1`–`4`                       | `layout=2,3` (2房 or 3房)                                                 |
| `shape`   | Building shape                | comma-list of integers                      | `shape=1,3,4` (公寓+透天+別墅)                                            |
| `acreage` | Floor area (坪 / ping)        | `MIN_MAX`                                   | `acreage=10_30`                                                           |
| `other`   | Amenity / status flags        | comma-list of slug strings (see enum below) | `other=near_subway,pet,lift`                                              |
| `sort`    | Result ordering               | slug                                        | `sort=posttime_desc` (newest first; default = "預設排序" = no sort param) |

**`region` enum** (Taiwan-wide; gaps `9, 16, 18, 20` are non-Taiwan codes that render an empty title):

| ID  | Region                | ID  | Region                  | ID  | Region                 |
| --- | --------------------- | --- | ----------------------- | --- | ---------------------- |
| 1   | 台北市 (Taipei City)  | 2   | 基隆市 (Keelung)        | 3   | 新北市 (New Taipei)    |
| 4   | 新竹市 (Hsinchu City) | 5   | 新竹縣 (Hsinchu County) | 6   | 桃園市 (Taoyuan)       |
| 7   | 苗栗縣 (Miaoli)       | 8   | 台中市 (Taichung)       | 10  | 彰化縣 (Changhua)      |
| 11  | 南投縣 (Nantou)       | 12  | 嘉義市 (Chiayi City)    | 13  | 嘉義縣 (Chiayi County) |
| 14  | 雲林縣 (Yunlin)       | 15  | 台南市 (Tainan)         | 17  | 高雄市 (Kaohsiung)     |
| 19  | 屏東縣 (Pingtung)     | 21  | 宜蘭縣 (Yilan)          | 22  | 台東縣 (Taitung)       |
| 23  | 花蓮縣 (Hualien)      | 24  | 澎湖縣 (Penghu)         | 25  | 金門縣 (Kinmen)        |

**`kind` enum** (only `1`–`4`, `8`–`10` are valid for `rent.591.com.tw`; `5/6/7/11` redirect to other 591 properties — `store.591`, `office.591`, factory listings, sale-only land — and lose the rent filter UI):

| ID  | Type                                                             |
| --- | ---------------------------------------------------------------- |
| 0   | 不限 — all rental types (default; equivalent to omitting `kind`) |
| 1   | 整層住家 — whole apartment                                       |
| 2   | 獨立套房 — independent studio (own bath/kitchen)                 |
| 3   | 分租套房 — sublet studio (own bath, shared common area)          |
| 4   | 雅房 — private bedroom with shared bath                          |
| 8   | 車位 — parking space                                             |
| 9   | 住宅 — residential aggregate                                     |
| 10  | 套房 — studio aggregate (covers `2` + `3`)                       |

**`section` enum** (region-specific; **always re-derive per region** — IDs are not stable across regions and you cannot port a Taipei `section=5` to a New Taipei query). For 台北市 (region 1), discovered:

| ID  | District | ID  | District | ID  | District |
| --- | -------- | --- | -------- | --- | -------- |
| 1   | 中正區   | 2   | 大同區   | 3   | 中山區   |
| 4   | 松山區   | 5   | 大安區   | 6   | 萬華區   |
| 7   | 信義區   | 8   | 士林區   | 9   | 北投區   |
| 10  | 內湖區   | 11  | 南港區   | 12  | 文山區   |

For other regions, derive the mapping by clicking each district checkbox once and reading the URL — see the click-and-read snippet in **Browser fallback**.

**`other` enum** (amenity / status flags, comma-joined):

| Slug               | Label                                    |
| ------------------ | ---------------------------------------- |
| `newPost`          | 新上架 (newly listed)                    |
| `near_subway`      | 近捷運 (near MRT/metro)                  |
| `pet`              | 可養寵物 (pet-friendly)                  |
| `cook`             | 可開伙 (cooking allowed)                 |
| `cartplace`        | 有車位 (parking included)                |
| `lift`             | 有電梯 (elevator)                        |
| `balcony_1`        | 有陽台 (balcony)                         |
| `lease`            | 可短期租賃 (short-term OK)               |
| `social-housing`   | 社會住宅 (social housing)                |
| `rental-subsidy`   | 租金補貼 (subsidy-eligible)              |
| `elderly-friendly` | 高齡友善 (elderly-friendly)              |
| `tax-deductible`   | 可報稅 (tax-deductible)                  |
| `naturalization`   | 可入籍 (household-registration eligible) |

**`shape` enum** (partial — derived by multi-select reverse-mapping `shape=1,3,4` → 公寓 + 透天厝 + 別墅):

| ID  | Type                               |
| --- | ---------------------------------- |
| 1   | 公寓 (walk-up apartment)           |
| 3   | 透天厝 (townhouse / single-family) |
| 4   | 別墅 (villa)                       |

(2 and 5+ exist but were not exhaustively probed; click-and-read the UI if you need them.)

### 2. Open the URL

One `browserless_agent` call, no proxy. Batching the `goto` and the two `evaluate` extractions below in this ONE call's `commands` array is the convenient default — the session persists across calls (keyed by `proxy`/`profile`), so there's no separate create/release step:

```json
{
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://rent.591.com.tw/list?region=1&kind=2,1&price=15000_25000&layout=2&sort=posttime_desc",
        "waitUntil": "load",
        "timeout": 45000
      }
    }
  ]
}
```

Listings are SSR'd into the initial HTML, so `waitUntil: "load"` is enough — no extra wait usually needed. Add a `{ "method": "waitForTimeout", "params": { "time": 2000 } }` before your evaluates only if the popup tooltip is blocking them.

The site auto-rewrites legacy param names (`multiPrice` → `price`, `multiRoom` → `layout`, etc.) — don't rely on the auto-rewrite, just send the canonical names from the table above.

### 3. Extract the total count

Add an `evaluate` command to the same call's `commands` array. Its return value comes back under `.value`:

```json
{
  "method": "evaluate",
  "params": {
    "content": "(()=>JSON.stringify({total: (document.body.innerText.match(/已為你找到\\s*([0-9,]+)\\s*間/) || [])[1]}))()"
  }
}
```

`.value` → `{ "total": "1,525" }`. (Inside a JSON `content` string the regex backslashes are doubled — `\\s` — but the pattern is otherwise identical.)

The total reflects the full filtered match across all pages (not just the 30 cards rendered on page 1).

### 4. Extract the listing cards

The first page of the SSR'd response renders **30 listing cards** in `.item-info`. Each card has a child `<a>` whose `href` is the canonical detail URL.

A second `evaluate` command in the same call harvests the cards (the JS body is unchanged; it's wrapped in an IIFE that returns the stringified projection under `.value`):

```json
{
  "method": "evaluate",
  "params": {
    "content": "(()=>{ const total = (document.body.innerText.match(/已為你找到\\s*([0-9,]+)\\s*間/) || [])[1]; const cards = [...document.querySelectorAll('.item-info')]; const listings = cards.map(c => { const lines = (c.innerText || '').split('\\n').map(l=>l.trim()).filter(Boolean); const url = c.href || c.querySelector('a')?.href; const id = url?.match(/\\/(\\d{6,})$/)?.[1]; const priceMatch = c.innerText.match(/([0-9,]+)\\s*元\\/月/); const sizeLine = lines.find(l => /\\d+(\\.\\d+)?坪/.test(l)) || ''; const ping = parseFloat((sizeLine.match(/(\\d+(\\.\\d+)?)坪/) || [])[1]) || null; const floor = (sizeLine.match(/([0-9頂樓加蓋]+F\\/\\d+F)/) || [])[1] || null; const layoutStr = (sizeLine.match(/(\\d+房\\d*廳\\d*衛|獨立套房|分租套房|雅房|整層住家|開放式|樓中樓)/) || [])[1] || null; const address = lines.find(l => /區-/.test(l)) || null; const distance = lines.find(l => l.startsWith('距')) || null; return { id, url, title: lines[0], layout: layoutStr, area_ping: ping, floor, address, distance, price_ntd: priceMatch ? +priceMatch[1].replace(/,/g, '') : null }; }); return JSON.stringify({total, count: listings.length, listings}); })()"
  }
}
```

Field logic (same as above): `sizeLine` is the line matching `坪` — it carries layout/area/floor (e.g. `"獨立套房14.9坪6F/7F"` or `"整層住家2房1廳1衛20坪3F/5F"`); `address` is the line containing `"區-"` (district-street); `distance` is the line starting with `"距"` (distance to MRT).

The first line of `c.innerText` is the listing title; the **last** line containing the substring `元/月` is the price; one line near the bottom of the card has the agent/owner + last-updated stamp + "昨日 X 人瀏覽" view counter (skip if not needed).

### 5. Pagination (if needed)

To paginate beyond the first 30 cards, issue another `browserless_agent` call whose `goto` URL appends `&firstRow=N` with `N` in steps of 30: `firstRow=30`, `firstRow=60`, etc. (Some 591 mirrors call this `pg=` or `page=`, but `firstRow` is the canonical for `rent.591`.) The total count from step 3 tells you how many pages to walk. Keep each page's `goto` + card `evaluate` in ONE call's `commands` array.

### 6. No session to release

The session persists across calls (keyed by `proxy`/`profile`) — there's no session-release step. Batch a page's `goto` + extraction `evaluate`s into one call's `commands` array (warm-up → nav → extract); you can start a fresh call per page, carrying the same config to stay in the same session (or, with no proxy here, each page is an independent read anyway).

### Browser fallback (when you need a filter slug you don't have)

If the user asks for a filter you don't yet have a URL slug for (e.g., a `section` value in 台中市), open the bare filter page, click the checkbox via `evaluate`, and read the URL back — all in one `browserless_agent` call:

```json
{
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://rent.591.com.tw/list?region=8",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    { "method": "waitForTimeout", "params": { "time": 2000 } },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ [...document.querySelectorAll('label')].find(l=>l.innerText?.trim()==='北屯區')?.click(); return 'ok'; })()"
      }
    },
    { "method": "waitForTimeout", "params": { "time": 1000 } },
    { "method": "evaluate", "params": { "content": "(()=>location.search)()" } }
  ]
}
```

The final `evaluate` returns `...&section=NN` under `.value`. This same recipe works for any filter chip — `kind`, `shape`, `other`, etc. The Vue store mutation is what builds the URL, so the canonical slug always appears in `window.location.search` immediately after the click. (Doing the click via `evaluate` avoids relying on a discrete click command; if you'd rather use a `{ "method": "click", "params": { "selector": "..." } }` command, confirm the label's selector via `snapshot` first.)

## Site-Specific Gotchas

- **The a11y `snapshot` method is unreliable on this site** (its parser choked repeatedly during testing). Use `evaluate` DOM queries for extraction directly — the accessibility-tree path is not viable here; the explicit DOM-query path is.
- **No serious anti-bot.** A plain `browserless_agent` (no `proxy` arg) loads filtered pages and renders the full `.item-info` grid. The metadata for this skill reflects that — `verified: false, proxies: false`. Add a residential `proxy` only if you observe Cloudfront 403s during sustained polling.
- **A "RoboForm 密碼管理工具" tooltip popup overlays the right side of the viewport** on first page load. It does NOT block DOM evaluation, but it WILL show up in screenshots. Dismiss programmatically before screenshotting:
  ```js
  [...document.querySelectorAll('*')]
    .filter(
      (e) =>
        e.children.length === 0 && e.innerText?.trim() === '我知道了，不再提示',
    )[0]
    ?.click();
  ```
- **Param auto-rewrite.** Sending `multiPrice=15000_25000&multiRoom=2&kind=2,1` rewrites to `kind=2,1&price=15000_25000&layout=2` on the next render. Don't rely on legacy names — use the canonical `price`, `layout`, `section`, `shape`, `acreage`, `other`, `sort` listed in the table.
- **`section` IDs are region-scoped and NOT portable.** A Taipei `section=5` (大安區) is meaningless in another region. Always re-derive `section` IDs per region with the click-and-read fallback recipe.
- **`region` codes 9, 16, 18, 20 render a generic "租屋 | 房屋出租" title with no city name** — these slots are reserved (probably for outlying Taiwan municipalities not listed in the rental flow). Only use the regions in the enum table; treat anything else as undefined.
- **`kind` 5/6/7/11 redirect to sibling 591 properties** (`store.591` for retail/storefront, separate office/factory/land sites) and lose the rental filter UI. The valid rental kinds are 0, 1, 2, 3, 4, 8, 9, 10.
- **First page returns 30 cards regardless of filter strictness** (vs. typical 12–20 elsewhere). Page 2 starts at `firstRow=30`. Don't assume Craigslist-style 360-card batches.
- **Bare `https://rent.591.com.tw/`** sets a `urlJumpIp` cookie and 301-redirects to `/list?region=N` based on the request IP (in our trace, region=1 from any non-Taiwan IP — Taipei is the global default). Pass `region=` explicitly to lock the city. The redirect chain is: `/` → `/list` → `/list?region=1`.
- **Sort param's "默認" (default) is the empty value** — sending `sort=` or omitting `sort` both yield the site's blended-relevance ordering (which up-ranks "優選好屋" promoted listings). Use `sort=posttime_desc` if you want true newest-first across the whole result set.
- **Listing IDs in `https://rent.591.com.tw/{id}` are 7–8 digit integers**, not slugs. The detail page itself lives at `rent.591.com.tw/{id}` with no slug, no path segments.
- **Total count is in localized text only.** Use the regex `/已為你找到\s*([0-9,]+)\s*間/` against `document.body.innerText` — there is no `data-*` attribute exposing the integer count cleanly. The count includes the comma thousand-separator and you must strip it before parsing.
- **Card innerText is multi-line and order-sensitive.** Title is `lines[0]`. Size/floor/type is the line matching `/\d+坪/`. Address is the line matching `/區-/`. Don't rely on line indices — match by content shape.
- **Direct API path tried and failed.** `GET https://rent.591.com.tw/v3/web/rent/list?region=1` (the path observed in the Cloudfront `X-Server-Monitor` header) returns a 404 to external clients — it's only callable server-side from the SSR layer. Don't waste turns trying to find a JSON endpoint; the SSR'd HTML is the canonical data surface.

## Expected Output

```json
{
  "success": true,
  "filters_applied": {
    "region": 1,
    "region_name": "台北市",
    "section": [5, 7],
    "section_names": ["大安區", "信義區"],
    "kind": [1, 2],
    "kind_names": ["整層住家", "獨立套房"],
    "price_min": 15000,
    "price_max": 25000,
    "layout": [2],
    "other": ["near_subway", "lift"],
    "sort": "posttime_desc"
  },
  "url": "https://rent.591.com.tw/list?region=1&section=5,7&kind=2,1&price=15000_25000&layout=2&other=near_subway,lift&sort=posttime_desc",
  "total_matches": 1525,
  "page_size": 30,
  "listings": [
    {
      "id": "21297268",
      "url": "https://rent.591.com.tw/21297268",
      "title": "中山站、電梯套房、台水電、獨洗、有陽台、代收垃圾",
      "layout": "獨立套房",
      "area_ping": 14.9,
      "floor": "6F/7F",
      "address": "中山區-林森北路259巷",
      "distance": "距中山459公尺",
      "price_ntd": 23500
    }
  ],
  "error_reasoning": null
}
```

**Outcome shapes:**

```json
// Zero matches (filter combination too restrictive)
{ "success": true, "total_matches": 0, "listings": [], "url": "...", "filters_applied": {...} }

// kind redirected to a sibling property (e.g. user passed kind=5 / store)
{ "success": false, "reason": "kind_not_supported_by_rent_591", "redirected_to": "store.591.com.tw" }

// region code in the reserved-but-unused slots (9/16/18/20)
{ "success": false, "reason": "invalid_region", "region": 16 }
```
