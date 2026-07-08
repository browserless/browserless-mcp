---
name: explore-products-specs
title: ifm Products & Technical Specifications Explorer
description: >-
  Discover ifm sensors/automation products by search and retrieve full technical
  specifications (datasheet attributes) for any article number via ifm's public
  REST API, with a browser fallback.
website: ifm.com
category: industrial-automation
tags:
  - ifm
  - sensors
  - datasheet
  - specifications
  - product-catalog
  - industrial
  - rest-api
source: 'browserbase: agent-runtime 2026-06-01'
updated: '2026-06-01'
recommended_method: fetch
alternative_methods:
  - method: api
    rationale: >-
      The /restservices/{cc}/{lang}/ endpoints ARE the public REST API the
      site's own Vue front-end calls; 'fetch' and 'api' are the same path here —
      plain HTTPS GETs returning JSON, no auth/cookies/tokens required.
  - method: browser
    rationale: >-
      Fallback only. The product page is a Vue SPA: the raw HTML shell contains
      NO spec values (they hydrate client-side from the same REST API). A
      rendered browser session reads the full spec table from the DOM but costs
      ~100x the REST path. Drive it with a plain `browserless_agent` call; add
      `proxy: { proxy: "residential" }` only if the REST/SPA host ever starts
      blocking direct fetches.
verified: true
proxies: true
---

# ifm Products & Technical Specifications Explorer

## Purpose

Discover ifm electronic products (sensors, IO-Link devices, connectors, controllers, accessories) and retrieve their full technical specifications. ifm's public website (`www.ifm.com`) is a Vue single-page app that hydrates entirely from an unauthenticated REST API at `/restservices/{country}/{lang}/…`. This skill leads with that API: a search call to find product article numbers, then per-article calls for product metadata and the complete datasheet (every spec attribute, grouped into sections, with units). Read-only — no login, cart, or order actions.

## When to Use

- Look up the full technical datasheet for a known ifm article number (e.g. `PN2043`, `TN7531`, `O5D100`).
- Search the catalog for products matching a query ("pressure sensor", "IO-Link master") and return the matching article numbers + headlines.
- Bulk-extract specs across many products (the API is faster, cheaper, and structurally cleaner than scraping the rendered page).
- Compare spec attributes across a product family or category.
- Anywhere you'd otherwise drive the ifm SPA UI to read a spec table — the REST JSON is the same data the UI renders.

## Workflow

**Optimal path = direct REST calls.** The product page's raw HTML is a shell — it does **not** contain spec values (confirmed: a static fetch of `/us/en/product/PN2043` has no "Measuring range", "Operating voltage", etc.). Those values hydrate client-side from `/restservices/...`. Hit that API directly and skip the browser entirely.

Base path: `https://www.ifm.com/restservices/{cc}/{lang}/` where `{cc}` is the lowercase country code and `{lang}` the language (e.g. `us/en`, `de/de`, `gb/en`, `fr/fr`). Use `us/en` for the US English catalog.

All calls are plain HTTPS `GET`, return `application/json`, and need **no auth, cookies, or token** — run them from any HTTP client. Under restricted egress, route via `browserless_function`: because it runs in a browser page context (bare `fetch` has no egress until the page navigates), `page.goto('https://www.ifm.com/')` first, then `page.evaluate(async () => fetch('/restservices/us/en/...').then(r => r.json()))` (same-origin). The bare ifm homepage returns 403 to naive clients, so if a raw fetch is blocked add `proxy: { proxy: "residential" }` for resilience — though the REST endpoints themselves returned 200 even without a proxy in testing.

1. **Find products (search).**

   ```
   GET /restservices/us/en/search?q={url-encoded query}
   ```

   Returns: `resultList[]` (default ~12 product hits), `productCount` (total products matching, e.g. 1420), `solutionCount`, `otherCount` (accessories/downloads), and `facetResult.facets[]` for drill-down. Each `resultList[]` item carries `id` (the article number, e.g. `PN7094`), `productHeadline` (display name, e.g. "Pressure sensor with display"), `url` (`/us/en/product/{id}`), `shortDescription`, `bulletPoints[]`, `searchResultType` ("product"), `gtin`, and an image URL. Use `id` for the detail/datasheet calls below.

2. **Get product metadata.**

   ```
   GET /restservices/us/en/productdetail/{ARTICLE}
   ```

   Returns the product header object: `title` (= article number), `productHeadline` (descriptive name — **this, not `title`, is the human-readable product name**), `shortDescription`, `bulletPoints[]`, `productType` (the long ifm type string, e.g. `PN-040-SER14-MFRKG/US/ /V`), `gtin`, `countryOfOrigin`, `ioLinkUri`, `variantIds[]`/`variants[]`, `hasAccessories`, and image URLs. Note `price`/`formattedPrice` are usually `null` (US list/customer prices require a logged-in my-ifm session — see gotchas).

3. **Get the full technical specifications (datasheet).**

   ```
   GET /restservices/us/en/productdetail/datasheetTab/{ARTICLE}
   ```

   This is the core call. Returns:
   - `datasheetResultDocument.datasheetSections[]` — ordered spec sections. Each section has `sectionName` (e.g. "Product characteristics", "Electrical data", "Measuring/setting range", "Operating conditions", "Tests / approvals", "Mechanical data") and `datasheetSubSectionList[]`, each holding `dataSheetAttributesList[]`.
   - Every attribute is `{ "name": "Measuring range", "value": "0...40 bar", "uom": "", "type": "string", "key": "at_...", "valueList": null, "tableValue": null }`. Multi-unit values (bar/psi/MPa) may appear as separate adjacent attributes with the same `name`.
   - `defaultPdfDatasheetUrl` — direct link to the official PDF datasheet.
   - `scaleDrawingUrl` / `scaleDrawingRef` — dimensional drawing image.
   - `certificateImages[]`, `connections`, `diagramSections`, `freeTableSection`, `footerAddress`, `footerDate`, `madeInRemark`.
     To flatten: iterate `datasheetSections → datasheetSubSectionList → dataSheetAttributesList` and collect `{section, name, value, uom}`.

4. **(Optional) Related sub-resources** — same `productdetail/{tab}/{ARTICLE}` pattern, all JSON:
   - `productdetail/variants/{ARTICLE}` — variant list.
   - `productdetail/accessories/{ARTICLE}` — compatible accessories.
   - `productdetail/pdfDatasheets/{ARTICLE}` — datasheet PDFs in all languages.
   - `availability/{ARTICLE}/availability/1/ST?includeStock=true` — stock/availability.

### Browser fallback

Only if the REST host ever starts blocking direct fetches. Drive it with a single `browserless_agent` call (the homepage is behind Akamai and returns 403 to unstealthed clients; add `proxy: { proxy: "residential" }` on the call if a plain session gets blocked). Keep the whole flow in one call's `commands` array:

1. `{ "method": "goto", "params": { "url": "https://www.ifm.com/us/en/product/{ARTICLE}", "waitUntil": "load", "timeout": 45000 } }`, then `{ "method": "waitForTimeout", "params": { "time": 5000 } }` (let the SPA hydrate). Never use `networkidle`.
2. Dismiss the Usercentrics cookie banner — it lives in a **shadow DOM**, so a `{ "method": "click", "params": { "selector": "button" } }` won't find "Accept All". Click it by coordinate instead (roughly x=905, y=667 at a 1288×711 viewport) via an `evaluate` that dispatches a click at those coordinates, or `{ "method": "click", "params": { "x": 905, "y": 667 } }`; confirm via `snapshot` if the coordinate misses.
3. The page lazy-loads the spec table when the **"Technical details"** tab is in view. `{ "method": "text", "params": { "selector": "body" } }` returns the entire rendered datasheet inline (section headers + name/value pairs), even before manual scrolling. Parse the text, or click the "Technical details" tab and read the rendered `<table>`s via an `evaluate`.
4. Note the rendered page reaches the same `/restservices/.../datasheetTab/{ARTICLE}` XHR — confirm the endpoint from inside an `evaluate` via `performance.getEntriesByType('resource')` if you need to rediscover it.

## Site-Specific Gotchas

- **The product page HTML has NO spec data.** `/us/en/product/{ART}` is a Vue SPA shell; specs hydrate from `/restservices/.../datasheetTab/{ART}`. Don't parse the static product HTML for specs — it only has `<meta>`/`og:` tags and the JS bundle. Hit the REST API.
- **`title` ≠ product name.** In `productdetail/{ART}`, `title` is just the article number (`"PN2043"`). The human-readable name ("Pressure sensor with display") is in **`productHeadline`**. The verbose ifm catalog type string is `productType`.
- **Locale is in the path, not a header.** `{cc}/{lang}` (e.g. `us/en`) selects catalog, language, units, and price region. `de/de`, `gb/en`, `fr/fr`, etc. all work. The same article returns localized spec strings per locale.
- **robots.txt disallows many locales' indexable pages** and query-string category URLs (`Disallow: /*/*/category/*/*/*?*`, plus most non-US/non-DE `/{cc}/en/` trees), but explicitly **Allows ClaudeBot / GPTBot / anthropic-ai / CCBot**. The `/restservices/` API is not disallowed. `us/en` and `de/en` are crawlable.
- **Search returns only ~12 results per call and there is no working offset/page param.** `productCount`/`hits` report the true total (e.g. 1420), but `page=`, `offset=`, `pageSize=`, `p=`, `count=` all returned **HTTP 503** in testing — do not rely on them. To enumerate a full category, either (a) narrow the query / use `facetResult.facets[]` buckets (e.g. `productProgram` → Sensors/Accessories with counts) to slice the result set, or (b) pull article numbers from the locale sitemap (see below).
- **Sitemap = the bulk product index.** `https://www.ifm.com/us/en/sitemap.xml` lists ~10,450 `/us/en/product/{ARTICLE}` URLs and ~800 `/us/en/category/{HIERARCHICAL_ID}` URLs (IDs like `200_010_020_010_010`). This is the most reliable way to enumerate every article number; the per-product REST calls then fetch metadata + specs. Other Sitemaps are listed in `robots.txt` (one per locale).
- **There is no `restservices/.../category/{id}` JSON endpoint** — `/restservices/us/en/category/230` returns 404. Category browsing is done via the SPA `/{cc}/{lang}/category/{id}` pages or via `search` + facets, not a clean category REST call.
- **Prices are usually `null` in the API.** `productdetail.price` / `formattedPrice` came back `null` for US; the rendered search UI shows a "List price" but "Your price" requires a logged-in my-ifm account. Treat pricing as out of scope / login-gated.
- **Multi-unit spec values are duplicated, not nested.** A pressure range appears as three sibling attributes (`0...40 bar`, `0...580 psi`, `0...4 MPa`) all named "Measuring range", rather than one attribute with a unit array. Group by `name` if you need them merged.
- **Homepage/anti-bot:** the bare `www.ifm.com` homepage is behind Akamai and returned **403** to the pre-run probe. A `browserless_function` fetch (with or without a residential proxy) reached both the product HTML and the REST JSON at **200** in testing; the `browserless_agent` browser fallback loads the SPA reliably as a plain stealth session, and can add `proxy: { proxy: "residential" }` if blocked. Add a residential proxy to REST fetches for resilience if a raw fetch is refused.
- **Cookie banner is in a shadow DOM** (Usercentrics) and sets `overflowHidden` on `<body>`, blocking scroll until dismissed. Only relevant to the browser fallback — click "Accept All" by coordinates, then clear the class / set `body.style.overflow='auto'`.

## Expected Output

Recommended shape after combining `search` + `productdetail` + `datasheetTab`:

```json
{
  "article": "PN2043",
  "name": "Pressure sensor with display",
  "type": "PN-040-SER14-MFRKG/US/ /V",
  "url": "https://www.ifm.com/us/en/product/PN2043",
  "gtin": "4021179320511",
  "country_of_origin": "RO",
  "bullet_points": [
    "Two switching outputs, one of them programmable as IO-Link and one as analog output",
    "Red/green display for clear identification of the acceptable range",
    "The process connection can be rotated for optimum alignment"
  ],
  "datasheet_pdf": "https://media.ifm.com/dam/.../PN2043-00_EN-US.pdf",
  "scale_drawing": "https://media.ifm.com/dam/.../P_MZ_500_0139.png",
  "specifications": [
    {
      "section": "Product characteristics",
      "name": "Number of inputs and outputs",
      "value": "Number of digital outputs: 2; Number of analog outputs: 1",
      "uom": ""
    },
    {
      "section": "Product characteristics",
      "name": "Measuring range",
      "value": "0...40 bar",
      "uom": ""
    },
    {
      "section": "Product characteristics",
      "name": "Measuring range",
      "value": "0...580 psi",
      "uom": ""
    },
    {
      "section": "Product characteristics",
      "name": "Process connection",
      "value": "threaded connection G 1/4 Internal thread (DIN EN ISO 1179-2)",
      "uom": ""
    },
    {
      "section": "Electrical data",
      "name": "Operating voltage",
      "value": "18...30 DC; (to SELV/PELV)",
      "uom": "V"
    },
    {
      "section": "Operating conditions",
      "name": "Ambient temperature",
      "value": "-25...80",
      "uom": "°C"
    },
    {
      "section": "Mechanical data",
      "name": "Weight",
      "value": "282.5",
      "uom": "g"
    }
  ],
  "section_names": [
    "Product characteristics",
    "Application",
    "Electrical data",
    "Inputs / outputs",
    "Outputs",
    "Measuring/setting range",
    "Accuracy / deviations",
    "Reaction times",
    "Software / programming",
    "Interfaces",
    "Operating conditions",
    "Tests / approvals",
    "Mechanical data",
    "Displays / operating elements",
    "Remarks",
    "Electrical connection"
  ]
}
```

Search-result shape (`GET /restservices/us/en/search?q=pressure+sensor`):

```json
{
  "productCount": 1420,
  "solutionCount": 98,
  "otherCount": 0,
  "hits": 1846,
  "resultList": [
    {
      "id": "PN7094",
      "productHeadline": "Pressure sensor with display",
      "url": "/us/en/product/PN7094",
      "searchResultType": "product",
      "shortDescription": "Electronic pressure sensor; -1...10 bar; ...",
      "bulletPoints": ["..."],
      "gtin": "..."
    }
  ],
  "facetResult": {
    "facets": [
      {
        "type": "CSETermsFacet",
        "name": "productProgram",
        "buckets": [
          { "label": "Sensors", "count": 1064 },
          { "label": "Accessories", "count": 329 }
        ]
      }
    ]
  }
}
```

Not-found / bad article (`productdetail` or `datasheetTab` for an unknown article) returns an RFC-7807 problem document:

```json
{
  "title": "Not Found",
  "status": 404,
  "detail": "HTTP 404 Not Found",
  "instance": "/site/restservices/us/en/category/230"
}
```
