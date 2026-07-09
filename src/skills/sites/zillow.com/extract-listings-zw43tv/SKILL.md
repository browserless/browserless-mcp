---
name: extract-listings
title: Zillow Filtered Listing Extraction
description: >-
  Search Zillow for-sale listings with the full filter surface (property type,
  price, beds/baths, sqft, lot size, year built, days-on-market, amenities, HOA,
  monthly payment) by constructing a searchQueryState URL and parsing the
  embedded __NEXT_DATA__ JSON. Read-only.
website: zillow.com
category: real-estate
tags:
  - real-estate
  - listings
  - zillow
  - search
  - scraping
  - json-api
source: 'browserbase: agent-runtime 2026-06-04'
updated: '2026-06-04'
recommended_method: fetch
alternative_methods:
  - method: browser
    rationale: >-
      Rendering the SRP in a real browser (even a stealthed `browserless_agent`
      session on a residential proxy) triggers the PerimeterX 'Press & Hold'
      captcha, and Zillow's SRP DOM is too large for reliable a11y snapshotting.
      Use only as a last resort; the data still lives in the page's
      __NEXT_DATA__ script if you can get past the wall.
  - method: api
    rationale: >-
      Zillow's internal GetSearchPageState.htm / async-create-search-page-state
      JSON endpoints exist but return 404/403 on plain GETs without internal
      x-caller-id/referer headers — confirmed not usable from outside. Parse
      __NEXT_DATA__ from the SRP HTML instead.
verified: false
proxies: true
---

# Zillow Filtered Listing Extraction

## Purpose

Search Zillow for for-sale properties matching an arbitrarily complex query and
return the active listings as structured JSON, plus the region-wide total and
pagination state. The skill supports Zillow's **full filter surface** (property
type, listing status, price, beds, baths, square footage, lot size, year built,
days on market, amenities, HOA fee, monthly payment) by constructing a
`searchQueryState` URL so filtering happens **server-side** — never fetch
unfiltered results and post-filter. It is strictly **read-only**: it reads the
search results page (SRP), never clicks Save, Tour, Contact agent, or any
mutation control.

## When to Use

- "Find condos OR townhouses in Austin, TX between $300k and $700k with 2+ beds."
- "List single-family homes in 30307 with a pool and a garage under $900k."
- "What lots/land of 1–10 acres are for sale near Boulder, CO?"
- "Show new-construction homes in the Mission, San Francisco."
- "Get foreclosures / pre-foreclosures / auctions in a ZIP."
- "Pull every for-sale listing matching this Zillow search URL and return the
  structured data (zpid, price, beds, baths, address, detail URL, photo, …)."
- Any time a caller hands you a location (city+state, ZIP, neighborhood,
  free-form region, or a full Zillow URL) plus a set of filters and wants the
  matching listings as data.

## Workflow

**Recommended method: `fetch` (raw HTML — no SRP render).** Zillow's SRP is a
Next.js page that embeds the _entire_ search result set as JSON in a
`<script id="__NEXT_DATA__">` tag. Drive it with **`browserless_function`** on a
residential proxy: `page.goto('https://www.zillow.com/')` once to warm a
proxied, cookied session, then `page.evaluate` a **same-origin `fetch`** of the
SRP path — that returns HTTP 200 with the raw HTML, which you parse **in-page**
(`__NEXT_DATA__` → JSON) and return only the projected listings. A full
**browser navigation** (rendering the SRP itself) instead hits a PerimeterX
captcha (see Gotchas), so do **not** `goto` the SRP directly; fetch its HTML.

> `browserless_function` runs in a **browser page context, not Node** — a bare
> `fetch(url)` has no network egress until the page has navigated to that
> origin, so the `page.goto('https://www.zillow.com/')` warm-up is required. The
> SRP payload is ~1.4 MB and the function's text return is capped (~200k chars),
> so parse and project **inside** the `evaluate` — never return the raw HTML.
>
> Set `proxy: { proxy: "residential", proxyCountry: "us" }` on **every**
> `browserless_function` call — residential proxies are **mandatory** (datacenter
> IPs get blocked), and the session is keyed by that `proxy`, so repeating it on
> every call keeps you in the same warmed, proxied session (drop or change it and
> you land in a different, unproxied session that gets blocked). No login,
> cookies, or API key is required.

### Step 1 — Resolve the location to a Zillow region

Skip this step if the caller gave you a full Zillow search URL — reuse its
embedded `queryState` directly (Step 2 just augments `filterState`).

Otherwise fetch the resolver URL (works for city+state, ZIP, neighborhood, and
free-form regions — slugify spaces/commas to hyphens). `browserless_function`,
with `proxy: { proxy: "residential", proxyCountry: "us" }`:

```js
export default async function ({ page }) {
  // Warm a proxied, cookied session on the origin (required before same-origin fetch).
  await page.goto('https://www.zillow.com/', {
    waitUntil: 'load',
    timeout: 45000,
  });
  return await page.evaluate(async () => {
    const query = 'Austin-TX'; // slugified <QUERY>
    const html = await (
      await fetch(`/homes/${query}_rb/`, { headers: { accept: 'text/html' } })
    ).text();
    const m = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    const qs = JSON.parse(m[1]).props.pageProps.searchPageState.queryState;
    return { regionSelection: qs.regionSelection, mapBounds: qs.mapBounds };
  });
}
```

Examples of `<QUERY>`: `Austin-TX`, `30307`, `Capitol-Hill-Seattle-WA`,
`Boulder-CO`, `Mission-San-Francisco-CA`.

Parse `__NEXT_DATA__` (the JSON inside `<script id="__NEXT_DATA__">`) and read:

- `props.pageProps.searchPageState.queryState.regionSelection` → `[{regionId, regionType}]`
- `props.pageProps.searchPageState.queryState.mapBounds` → `{west,east,south,north}`

`regionType` codes observed: **2**=state, **4**=county, **6**=city, **7**=ZIP,
**8**=neighborhood. Keep BOTH `regionSelection` and `mapBounds` — pass them both
through to Step 2.

### Step 2 — Build the `searchQueryState` with your filters

```jsonc
{
  "isMapVisible": false,
  "isListVisible": true,
  "mapBounds": {/* from Step 1 */},
  "regionSelection": [/* from Step 1 */],
  "filterState": {/* mapped filters — see schema below */},
  "pagination": { "currentPage": 1 },
}
```

**`filterState` schema (LONG-key form — verified working).** Use these keys, NOT
the deprecated short aliases (`con`, `mp`, `lau`, …) from Zillow's old
querystring format. Range filters are `{min,max}` (use `null` for an open end);
boolean/amenity filters are `{value:bool}`; choice filters are `{value:"…"}`.

| Dimension                          | filterState key(s)                                                                                                                                                           | Shape / notes                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Property type (multi-select)       | `isSingleFamily`, `isCondo`, `isTownhouse`, `isMultiFamily`, `isApartment`, `isManufactured`, `isLotLand`                                                                    | `{value:bool}`. Set the chosen types **true** and the rest **false**. Zillow auto-couples condo+apartment via `isApartmentOrCondo` (it appears in the echoed state — don't set it yourself). |
| Listing status (for-sale, default) | `isForSaleByAgent`, `isForSaleByOwner` (FSBO), `isNewConstruction`, `isForSaleForeclosure`, `isAuction`, `isComingSoon`                                                      | `{value:bool}`, all default **true**. To restrict to one status, set it true and the others false.                                                                                           |
| Other statuses                     | `isPreMarketForeclosure`, `isPreMarketPreForeclosure`, `isPendingListingsSelected` (pending), `isAcceptingBackupOffersSelected`, `isRecentlySold` (sold), `isOpenHousesOnly` | `{value:bool}`                                                                                                                                                                               |
| Price (USD)                        | `price`                                                                                                                                                                      | `{min,max}`                                                                                                                                                                                  |
| Beds                               | `beds`                                                                                                                                                                       | `{min,max}`. Exact N → `{min:N,max:N}`                                                                                                                                                       |
| Baths (full+half)                  | `baths`                                                                                                                                                                      | `{min,max}`. Accepts halves, e.g. `{min:1.5}`                                                                                                                                                |
| Interior sqft                      | `sqft`                                                                                                                                                                       | `{min,max}`                                                                                                                                                                                  |
| Lot size                           | `lotSize`                                                                                                                                                                    | `{min,max,units:"sqft"\|"acres"}`. Values are in the chosen unit. (1 acre = 43,560 sqft.)                                                                                                    |
| Year built                         | `built`                                                                                                                                                                      | `{min,max}`                                                                                                                                                                                  |
| Days on market                     | `doz`                                                                                                                                                                        | `{value:"1"\|"7"\|"14"\|"30"\|"90"\|"6m"\|"12m"\|"24m"\|"36m"\|"any"}`                                                                                                                       |
| HOA fee (max monthly)              | `hoa` + `includeHomesWithNoHoaData`                                                                                                                                          | `hoa:{min,max}`, `includeHomesWithNoHoaData:{value:bool}`                                                                                                                                    |
| Monthly payment (max)              | `monthlyPayment` + cost inputs                                                                                                                                               | `monthlyPayment:{min,max}`; tune the estimate with `monthlyCostDownPayment`, `monthlyCostLoanTerm`, `monthlyCostInterestRate`, `monthlyCostCreditScore`                                      |
| Single story                       | `singleStory`                                                                                                                                                                | `{value:true}`                                                                                                                                                                               |
| Garage                             | `hasGarage` (or `parkingSpots:{min}`)                                                                                                                                        | `{value:true}`                                                                                                                                                                               |
| Pool                               | `hasPool`                                                                                                                                                                    | `{value:true}`                                                                                                                                                                               |
| A/C                                | `hasAirConditioning`                                                                                                                                                         | `{value:true}`                                                                                                                                                                               |
| Basement                           | `hasBasement` / `isBasementFinished` / `isBasementUnfinished`                                                                                                                | `{value:true}`                                                                                                                                                                               |
| Waterfront                         | `isWaterfront`                                                                                                                                                               | `{value:true}`                                                                                                                                                                               |
| Accessible                         | `hasDisabledAccess`                                                                                                                                                          | `{value:true}`                                                                                                                                                                               |
| 55+ community                      | `ageRestricted55Plus`                                                                                                                                                        | `{value:true}`                                                                                                                                                                               |
| Keywords (free text)               | `keywords`                                                                                                                                                                   | `{value:"..."}` — best-effort match against listing text                                                                                                                                     |
| Sort                               | `sortSelection`                                                                                                                                                              | `{value:"globalrelevanceex"}` (default). Others: `days`, `pricea` (low→high), `pricedd` (high→low), `lot`, `size`, `beds`.                                                                   |

> **In-unit laundry has no for-sale filter on Zillow** — `onlyRentalInUnitLaundry`
> is a _rental-only_ filter and is ignored for for-sale searches. If a caller
> asks for it, return matching listings and note it can't be filtered server-side.

### Step 3 — Fetch the filtered SRP and parse

URL-encode the `searchQueryState` JSON and fetch it the same way — a same-origin
`fetch` inside `browserless_function` (`proxy: { proxy: "residential",
proxyCountry: "us" }`). Fold the resolve (Step 1), the filtered fetch, **and** the
parse/projection into **one** call — batching keeps the warmed, proxied session and
its cookies across both fetches without an extra round-trip and avoids accidentally
dropping the `proxy`. The session persists across separate calls too, keyed by the
call's `proxy`/`profile` (a follow-up call carrying the same `proxy` reconnects to
it), so there is no session to release:

```js
export default async function ({ page }) {
  await page.goto('https://www.zillow.com/', {
    waitUntil: 'load',
    timeout: 45000,
  });
  return await page.evaluate(async () => {
    const query = 'Austin-TX';
    const searchQueryState = {
      /* built in Step 2 — regionSelection, mapBounds, filterState, pagination */
    };
    const url = `/homes/${query}_rb/?searchQueryState=${encodeURIComponent(JSON.stringify(searchQueryState))}`;
    const html = await (
      await fetch(url, { headers: { accept: 'text/html' } })
    ).text();
    const m = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    const sps = JSON.parse(m[1]).props.pageProps.searchPageState;
    // Project in-page — the raw payload is ~1.4 MB; return only what Step 4 needs.
    return {
      appliedFilterState: sps.queryState.filterState,
      totalResultCount: sps.categoryTotals.cat1.totalResultCount,
      listings: sps.cat1.searchResults.listResults.map((r) => ({
        r,
        homeInfo: r.hdpData?.homeInfo,
      })),
    };
  });
}
```

Parse `__NEXT_DATA__` and read:

- `props.pageProps.searchPageState.cat1.searchResults.listResults` → matching listings (≈41 per page)
- `props.pageProps.searchPageState.categoryTotals.cat1.totalResultCount` → region-wide total
- `props.pageProps.searchPageState.queryState.filterState` → the filters **the server actually applied** (echoed back; confirm your filters survived — Zillow silently drops malformed keys)

### Step 4 — Map each `listResult` → output

Read fields from the row `r` and `r.hdpData.homeInfo`:

| Output field                 | Source                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `zpid`                       | `r.zpid`                                                                                                                                |
| `price` / `unformattedPrice` | `r.price` (formatted) / `r.unformattedPrice`                                                                                            |
| `beds`, `baths`              | `r.beds`, `r.baths` (baths includes halves, e.g. `2.5`)                                                                                 |
| `livingAreaSqft`             | `r.area` (or `homeInfo.livingArea`)                                                                                                     |
| `lotSize`                    | `{value: homeInfo.lotAreaValue, unit: homeInfo.lotAreaUnit}` (unit is per-listing: `acres` or `sqft`)                                   |
| `address`                    | `r.addressStreet` / `r.addressCity` / `r.addressState` / `r.addressZipcode`                                                             |
| `propertyType`               | `homeInfo.homeType` (e.g. `SINGLE_FAMILY`, `CONDO`, `TOWNHOUSE`, `LOT`)                                                                 |
| `listingStatus`              | `r.statusType` (`FOR_SALE`, `PENDING`, `SOLD`, …) + `r.statusText`                                                                      |
| `daysOnZillow`               | `homeInfo.daysOnZillow`                                                                                                                 |
| `zestimate`                  | `r.zestimate` (present on only ~10% of SRP rows; else `null`)                                                                           |
| `taxAssessedValue`           | `homeInfo.taxAssessedValue` (when present)                                                                                              |
| `hoaFee`, `monthlyPayment`   | **Not in SRP rows → `null`.** The filters still apply server-side, but the per-listing HOA/payment values live only on the detail page. |
| `primaryPhoto`               | `r.imgSrc`                                                                                                                              |
| `detailUrl`                  | `r.detailUrl` (canonical `.../homedetails/.../<zpid>_zpid/`)                                                                            |

### Step 5 — Pagination

Each page returns ≈41 `listResults`. Estimate `totalPages ≈ ceil(totalResultCount / 41)`.
To page, set `pagination.currentPage = N` (N≥2) in the `searchQueryState` and
re-fetch Step 3. **Zillow hard-caps the SRP at ~20 pages (~820 listings)**
regardless of how large `totalResultCount` is — when `totalResultCount` exceeds
what you can page through, report the returned set as a partial slice (narrow the
filters or split the region to capture the rest).

### Browser fallback (last resort — usually blocked)

If you must render the SRP, use `browserless_agent` with a residential proxy
(`proxy: { proxy: "residential", proxyCountry: "us" }`) and drive everything in
one `commands` array:

```jsonc
[
  {
    "method": "goto",
    "params": {
      "url": "<filtered URL>",
      "waitUntil": "load",
      "timeout": 45000,
    },
  },
  { "method": "solve", "params": { "type": "perimeterx" } }, // "Press & Hold" — often not solvable
  {
    "method": "evaluate",
    "params": {
      "content": "(()=>{ const m=document.getElementById('__NEXT_DATA__').textContent; const sps=JSON.parse(m).props.pageProps.searchPageState; return JSON.stringify({ total: sps.categoryTotals.cat1.totalResultCount, rows: sps.cat1.searchResults.listResults.length }); })()",
    },
  },
]
```

Expect the PerimeterX "Press & Hold" challenge (see Gotchas); if `solve` can't
clear it the navigation is a dead end. Even when you get past it, pull the data
by reading `#__NEXT_DATA__` inside an `evaluate` (the `evaluate` return is capped,
so project in-page) — a `text` command on `script#__NEXT_DATA__` may truncate the
huge payload and a `snapshot` blows past the result-size limit on the giant DOM,
so the fetch path above is strongly preferred.

## Site-Specific Gotchas

- **A residential proxy is mandatory.** Without `proxy: { proxy: "residential" }`
  the fetch returns a PerimeterX `px-captcha` page instead of listing data.
- **The browser-rendering path is captcha-walled.** Rendering the SRP with
  `browserless_agent` hits PerimeterX's "Press & Hold" challenge **even on a
  stealthed session over a residential proxy** (confirmed during testing — see
  screenshot). The lightweight same-origin `fetch` of the SRP HTML (inside
  `browserless_function`) is _not_ challenged, which is exactly why
  `recommended_method` is `fetch`, not `browser`.
- **Don't use the JSON endpoints.** `https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=…`
  and `async-create-search-page-state` return **404/403** on plain GETs (they
  need internal `x-caller-id`/referer headers). Confirmed dead end — parse
  `__NEXT_DATA__` from the SRP HTML instead. Don't waste time on them.
- **Use LONG filter keys** (`isCondo`, `monthlyPayment`, `hasPool`). The short
  legacy aliases (`con`, `mp`, `lau`) belong to a deprecated querystring format
  and are ignored by the current Next.js searchQueryState.
- **Always read back `queryState.filterState` from the response.** Zillow
  silently drops malformed/unknown filter keys, so confirm your filters were
  actually applied (the `totalResultCount` should drop versus unfiltered).
- **`isApartmentOrCondo` is auto-managed.** Setting `isCondo`/`isApartment`
  causes Zillow to also echo `isApartmentOrCondo` — don't fight it.
- **A `text` command on `script#__NEXT_DATA__` truncates** large payloads, and a
  `snapshot` fails on the SRP's 3,600+ a11y nodes — neither is a viable
  extraction path. Fetch the HTML and parse it as a string in-page.
- **Parse in-page, don't ship raw HTML.** The SRP payload is ~1.4 MB and
  `browserless_function`/`evaluate` returns are capped (~200k chars), so match
  out `__NEXT_DATA__`, `JSON.parse` it, and project just the listing fields
  **inside** the `evaluate` — returning the raw HTML overflows the cap. Extraction
  needs the code/parse step; a plain click-through can't cleanly pull listings
  from that payload.
- **Per-listing `lotAreaUnit` varies** (`acres` for larger lots, `sqft` for
  smaller) — always read the unit alongside the value, don't assume.
- **HOA fee and monthly payment are filterable but not echoed per-listing** on
  the SRP; report them as `null` unless you also load each detail page.
- **`_rb` resolver slug** accepts almost any location text; `Mission-San-Francisco-CA`
  and `30307` both resolve. If a slug resolves to the wrong region, fall back to
  the bare `https://www.zillow.com/homes/_rb/?searchQueryState=…` form and rely
  on `regionSelection`/`mapBounds` from a prior resolve.

## Expected Output

```json
{
  "success": true,
  "query": {
    "location": "Austin, TX",
    "regionSelection": [{ "regionId": 10221, "regionType": 6 }],
    "appliedFilterState": {
      "isCondo": { "value": true },
      "isTownhouse": { "value": true },
      "price": { "min": 300000, "max": 700000 },
      "beds": { "min": 2, "max": null },
      "baths": { "min": 2, "max": null }
    }
  },
  "totalResultCount": 590,
  "returnedCount": 41,
  "currentPage": 1,
  "totalPages": 15,
  "resultsArePartial": true,
  "listings": [
    {
      "zpid": "29377187",
      "price": "$595,500",
      "unformattedPrice": 595500,
      "beds": 3,
      "baths": 3,
      "livingAreaSqft": 2259,
      "lotSize": { "value": 6046.128, "unit": "sqft" },
      "address": {
        "street": "13109 Sinton Ln",
        "city": "Austin",
        "state": "TX",
        "zip": "78729"
      },
      "propertyType": "CONDO",
      "listingStatus": "FOR_SALE",
      "statusText": "Active",
      "daysOnZillow": 7,
      "zestimate": null,
      "taxAssessedValue": 440680,
      "hoaFee": null,
      "monthlyPayment": null,
      "primaryPhoto": "https://photos.zillowstatic.com/fp/433057efa69a13194bca68f2417e6465-p_e.jpg",
      "detailUrl": "https://www.zillow.com/homedetails/13109-Sinton-Ln-Austin-TX-78729/29377187_zpid/"
    }
  ]
}
```

Listing with a Zestimate present (≈10% of SRP rows) and a lot measured in acres:

```json
{
  "zpid": "29371835",
  "price": "$899,000",
  "unformattedPrice": 899000,
  "beds": 4,
  "baths": 2,
  "livingAreaSqft": 1837,
  "lotSize": { "value": 0.254, "unit": "acres" },
  "address": {
    "street": "11809 Charing Cross Rd",
    "city": "Austin",
    "state": "TX",
    "zip": "78759"
  },
  "propertyType": "SINGLE_FAMILY",
  "listingStatus": "FOR_SALE",
  "statusText": "Active",
  "daysOnZillow": 5,
  "zestimate": 872100,
  "hoaFee": null,
  "monthlyPayment": null,
  "primaryPhoto": "https://photos.zillowstatic.com/fp/…-p_e.jpg",
  "detailUrl": "https://www.zillow.com/homedetails/…/29371835_zpid/"
}
```

Blocked / anti-bot outcome (browser path, or fetch without proxies):

```json
{
  "success": false,
  "error_reasoning": "PerimeterX 'Press & Hold' captcha returned instead of listing data. Retry with a same-origin fetch inside browserless_function on a residential proxy; do not render the SRP in a browser session.",
  "totalResultCount": null,
  "listings": []
}
```
