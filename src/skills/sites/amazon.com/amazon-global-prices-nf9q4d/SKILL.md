---
name: amazon-global-prices
title: Amazon Global Price Comparison
description: >-
  Compare an Amazon product price across multiple country storefronts by routing
  each browserless_agent call through that country's residential proxy, then
  extract country, currency, price, title, and URL in-page.
  Read-only.
website: amazon.com
category: ecommerce
tags:
  - amazon
  - ecommerce
  - price-comparison
  - geolocation-proxy
  - international
  - stagehand
  - read-only
source: 'browserbase: agent-runtime 2026-06-04'
updated: '2026-06-04'
recommended_method: browser
alternative_methods:
  - method: fetch
    rationale: >-
      A plain browserless_function fetch through a proxy routes through a
      residential IP but exposes no per-country geolocation control (defaults US)
      and can't parse the storefront in-page, so it can't produce native
      per-country locale/currency.
  - method: api
    rationale: >-
      Amazon has no public cross-region pricing API; the Product Advertising API
      requires per-marketplace Associate credentials and returns only your own
      locale, making ad-hoc multi-country comparison impractical.
verified: true
proxies: true
---

# Amazon Global Price Comparison

## Purpose

Given a product query (or an ASIN) and a list of country codes, search the matching **local Amazon storefront** for each country and return one structured record per country: `{ country, currency, price, title, url }`. Each country is fetched through its **own `browserless_agent` call routed via that country's residential proxy**, because Amazon's display locale and currency follow the shopper's exit IP — not the storefront TLD and not the delivery address. Extraction is an in-page `evaluate` projection (with a natural-language agent instruction as the resilient fallback).

**Read-only.** Never add to cart, never sign in, never proceed to checkout. Stop at the search-results / product page.

## When to Use

- Cross-border price comparison or arbitrage research ("is the Kindle Paperwhite cheaper on amazon.de or amazon.co.jp?").
- Building a per-region price table for one product or ASIN.
- Checking native local pricing/currency that a US-based shopper view would otherwise hide behind USD conversion.
- Any flow that needs _native_ per-country prices, which requires routing each request through that country's IP.

## Workflow

This task **fundamentally requires per-country geolocation proxies.** Amazon decides the display language and currency from the shopper's exit IP (persisted in the `i18n-prefs` cookie). From a US IP, every storefront — amazon.de, amazon.co.uk, amazon.co.jp — renders in English (`/-/en/` paths) with `US$`/USD prices and a "Deliver to United States" banner, _even after_ you set a local delivery postcode. There is no URL parameter, language toggle, or delivery-address change that produces native EUR/GBP/JPY from a US IP. The only lever that works is the exit IP. So: **one `browserless_agent` call per country, each routed through that country's residential proxy.**

### 1. Map country codes → storefronts

| Code | Storefront host  | Native currency |
| ---- | ---------------- | --------------- |
| DE   | www.amazon.de    | EUR             |
| GB   | www.amazon.co.uk | GBP             |
| JP   | www.amazon.co.jp | JPY             |
| FR   | www.amazon.fr    | EUR             |
| IT   | www.amazon.it    | EUR             |
| ES   | www.amazon.es    | EUR             |
| CA   | www.amazon.ca    | CAD             |
| US   | www.amazon.com   | USD             |

### 2. Set the proxy country on each per-country call

Each `browserless_agent` call is an independent ephemeral session and its exit country is fixed for that call, so make **one call per country** and pass the country on a top-level `proxy` arg:

```jsonc
// browserless_agent — one call per country
{
  "proxy": { "proxy": "residential", "proxyCountry": "de" }, // ISO-3166 alpha-2, lowercase
  "commands": [
    /* goto + cookie-dismiss + extract for this country — steps 3-5 */
  ],
}
```

- `proxyCountry` is an ISO-3166 alpha-2 code (e.g. `de`, `gb`, `jp`). Residential routing is what gives you a country-native exit IP; omit `proxyCountry` and you default to a US exit.
- Keep the whole per-country flow (navigate → dismiss the cookie dialog → extract) inside ONE call's `commands` array so cookies/locale persist across steps and you avoid accidentally dropping the session config; the session itself persists across calls, keyed by `proxy`. There is no separate session-release step.
- Repeat the call per country (sequential, or in parallel for speed).

### 3. Navigate to the storefront search (or product) URL

As `commands` in the same per-country call:

```jsonc
{ "method": "goto", "params": { "url": "https://www.amazon.de/s?k=Kindle+Paperwhite", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 2500 } }
```

- For an exact product, use `/dp/<ASIN>` instead of `/s?k=`. Note ASINs are **region-specific** — the same physical product can have different ASINs per storefront, so a keyword search is usually the more robust cross-region matcher.
- If the page title contains `503` / "Service Unavailable", wait ~4s and retry the `goto` **once** (Amazon throttles rapid navigations from one IP).

### 4. Dismiss the cookie consent dialog (best-effort)

EU storefronts overlay a "Cookies and Advertising Choices" dialog on first load. It's non-fatal (results are in the DOM behind it), but dismiss it for clean screenshots:

```jsonc
{ "method": "click", "params": { "selector": "#sp-cc-decline" } } // "Decline"; ignore failure
```

### 5. Extract the first organic result

Preferred — an `evaluate` command that projects the first organic result in-page and returns a compact `JSON.stringify` (the result comes back under `.value`):

```jsonc
{
  "method": "evaluate",
  "params": {
    "content": "(() => { /* select first organic result, return JSON.stringify({title, price, currency, url}) */ })()",
  },
}
```

If markup drift breaks the selectors, hand `browserless_agent` a natural-language instruction instead — "From the first NON-sponsored (organic) search result, return its product title, its displayed price string (including the currency symbol), the inferred ISO currency code, and the absolute product URL" — and let the agent read the page.

Deterministic selectors to use inside the `evaluate`:

- First organic container: `div[data-component-type="s-search-result"][data-asin]:not([data-asin=""])`, skipping sponsored tiles (`.s-sponsored-label-info-icon`, `[aria-label*="Sponsored"]`, `data-component-type="sp-sponsored-result"`).
- Title: `… h2`
- Price string: `… .a-price .a-offscreen` (full localized string, e.g. `159,99 €`, `£159.99`, `￥28,980`)
- URL: `… h2 a` href, or build `https://<host>/dp/<data-asin>`.

Infer currency from the price symbol: `€`/EUR, `£`/GBP, `¥`/`円`/JPY, `US$`/`$`/USD.

### 6. Collect into the output array

One record per country; include a record with an `error` field for any storefront that blocked or returned no results.

### Runnable-script note

If you drive this from your own script rather than `browserless_agent`, implement the per-country loop, sponsored-result filtering, cookie dismissal, 503 retry, currency inference, and validated output. **Note:** a single session shared across all countries exits from one IP (so on a US exit you get USD for every storefront). To get native currency, set the per-country `proxyCountry` from Step 2 — one call/session per country.

## Site-Specific Gotchas

- **Currency follows the exit IP, not the TLD or the delivery address — this is the whole ballgame.** Verified on amazon.de and amazon.co.jp: from a US datacenter IP both showed `US$`/USD and the `/-/en/` English locale. Setting "Deliver to Berlin 10115" changed the delivery banner but **prices stayed in USD** — currency is keyed to the `i18n-prefs` cookie seeded from the exit IP. Native EUR/GBP/JPY requires a country-matched geolocation proxy. Don't waste time on language params or delivery-address hacks.
- **One proxy country per call.** The exit country is fixed per `browserless_agent` call; multi-country = one call per country.
- **⚠️ Proxy-provisioning caveat (verify on your infra).** In the sandbox used to build this skill, managed proxies did **not** route on page-driving sessions — every variant (with and without the residential `proxy` arg) exited via the **AWS us-west-2 datacenter IP**, confirmed against `ipinfo.io` and `api.country.is`. As a result native non-USD currency could not be confirmed end-to-end here. (A plain `browserless_function` fetch through a proxy _did_ route through a residential US IP, but exposes no per-country geolocation control and can't parse the storefront in-page.) The `proxyCountry` config above is the correct, documented path; **if your calls also exit US, fix proxy provisioning before trusting any currency value** — and treat a "Deliver to United States" banner / `US$` price as a red flag that the proxy isn't routing.
- **503 throttling.** amazon.co.uk returned a `503 Service Unavailable` after rapid back-to-back storefront navigations on one IP. Use a fresh call per country, pace requests, and retry once after ~4s.
- **Cookie consent overlay.** "Cookies and Advertising Choices" dialog appears on first EU-storefront load; Decline button id is `#sp-cc-decline`. Non-fatal.
- **Sponsored results come first.** Filter sponsored tiles or you'll compare an ad placement instead of the product.
- **Decimal formats differ.** EU storefronts use a decimal comma (`159,99 €`); UK/JP use a dot/none (`£159.99`, `￥28,980`). Keep the raw localized string; normalize to a number only when you need arithmetic.
- **Prefer an `evaluate` projection (or the `text`/`html` command with CSS selectors) over `snapshot` here.** The search-results DOM is large; a `snapshot` a11y tree can exceed the result-size limit and buries the fields you want. Parse in-page instead.

## Expected Output

```json
{
  "success": true,
  "query": "Kindle Paperwhite",
  "results": [
    {
      "country": "DE",
      "currency": "EUR",
      "price": "159,99 €",
      "title": "Amazon Kindle Paperwhite (16 GB) – Jetzt mit 7‑Zoll‑Display und doppelter Akkulaufzeit",
      "url": "https://www.amazon.de/dp/B0CFPWLGF2"
    },
    {
      "country": "GB",
      "currency": "GBP",
      "price": "£159.99",
      "title": "Amazon Kindle Paperwhite (16 GB) – Now with a 7\" display and weeks of battery life",
      "url": "https://www.amazon.co.uk/dp/B0CFPWLGF2"
    },
    {
      "country": "JP",
      "currency": "JPY",
      "price": "￥28,980",
      "title": "Amazon Kindle Paperwhite (16GB) 6.8インチディスプレイ 広告なし",
      "url": "https://www.amazon.co.jp/dp/B0CFPWLGF2"
    }
  ],
  "error_reasoning": null
}
```

Per-storefront failure record (e.g. throttled):

```json
{ "country": "GB", "currency": "UNKNOWN", "error": "503 Service Unavailable" }
```

US-locale fallback shape (what you get when the country proxy is NOT routing — a US exit IP collapses every storefront to USD; treat as a misconfiguration signal, not a valid comparison):

```json
{
  "country": "DE",
  "currency": "USD",
  "price": "US$ 209.30",
  "title": "Amazon Kindle Paperwhite (16 GB) ...",
  "url": "https://www.amazon.de/-/en/dp/B0CFPWLGF2"
}
```
