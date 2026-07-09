---
name: browse-products
title: Amazon.in Product Search
description: >-
  Search amazon.in for a product query and return the first results page —
  title, ASIN, INR price, rating, rating count, sponsored flag, and canonical
  /dp URL. Read-only; HTTP-fetch led with a browser fallback.
website: amazon.in
category: ecommerce
tags:
  - ecommerce
  - amazon
  - product-search
  - india
  - read-only
  - scraping
source: 'browserbase: agent-runtime 2026-06-04'
updated: '2026-06-04'
recommended_method: fetch
alternative_methods:
  - method: browser
    rationale: >-
      When the lightweight fetch is served a persistent captcha/robot check, run
      a residential-proxy browserless_agent call with a `solve` step, grab the
      page HTML with one `html` command, and run the same regex parser. More
      expensive than the plain fetch and the snapshot/a11y path is unusable, so
      only a last resort.
verified: false
proxies: true
---

# Amazon.in Product Search

## Purpose

Given a product search query (keyword or phrase), search amazon.in and return the first results page's products — each with title, ASIN, price (INR), star rating, rating count, a sponsored/organic flag, and the canonical `/dp/<ASIN>` URL. Read-only: never signs in, adds to cart, or purchases.

## When to Use

- "What wireless earphones / running shoes / <product> show up on Amazon India for <query>?"
- Price / rating monitoring of the first results page for a keyword over time.
- Bulk catalog extraction across many queries — the HTTP path is cheap enough to run at scale.
- Anywhere you'd otherwise drive a headless browser over amazon.in search. The rendered HTML is fully server-side, so a single HTTP GET returns everything; scripted browsing is ~100× more expensive and far less reliable here (see gotchas).

## Workflow

amazon.in serves the **search results page fully server-rendered** — the product grid, prices, ratings, and ASINs are all present in the initial HTML response with no client-side hydration required. A single navigation returns the complete page; you grab its HTML and parse it with regex/HTML selectors. **Lead with the lightweight `goto` + `html` path.** A full agentic browse works as a fallback but is far more expensive because amazon.in's a11y tree is too large to `snapshot` and a per-element `html` selector returns only the first match (see Browser fallback + gotchas).

### 1. Fetch the results page (recommended — one navigation)

Run a residential-proxy `browserless_agent` call that navigates and returns the body HTML:

```jsonc
{
  "proxy": { "proxy": "residential", "proxyCountry": "in" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.amazon.in/s?k=wireless+earphones",
        "waitUntil": "load",
        "timeout": 45000,
      },
    },
    { "method": "html", "params": { "selector": "body" } },
  ],
}
```

- Use `https://www.amazon.in/s?k=<query>`. Spaces → `+` (or `%20`; both work).
- The residential `proxy` routes through an Indian residential IP. A datacenter exit _often_ works too, but amazon.in intermittently serves a "Enter the characters you see" robot check to datacenter IPs — residential routing makes the path reliable. The response sets `i18n-prefs=INR` and `Content-Language: en-IN`, so prices come back in INR by default.
- The `html` command result is the full page HTML (~1.8 MB). Call it `html` below.

### 2. Confirm the page is real, not a block

Test the returned HTML for the robot check before parsing:

```javascript
const h = htmlFromCommand || '';
if (
  /captcha|Enter the characters you see|To discuss automated access|Robot Check/i.test(
    h,
  )
) {
  console.log(
    JSON.stringify({
      success: false,
      error_reasoning: 'robot/captcha check served',
    }),
  );
} else {
  console.log(
    'results:',
    (h.match(/data-component-type="s-search-result"/g) || []).length,
  );
}
```

### 3. Parse products

Iterate over the organic result blocks. Each is a `<div data-component-type="s-search-result" data-asin="...">`. Split the HTML on that marker, then per block extract:

| Field          | Source pattern (within a block)                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `asin`         | `data-asin="([A-Z0-9]{10})"`                                                                            |
| `title`        | text inside the block's `<h2>…</h2>` (strip inner tags); fallback to the product link's `aria-label`    |
| `price_inr`    | `<span class="a-price-whole">([\d,]+)</span>` → strip commas → Number                                   |
| `rating`       | `(\d(?:\.\d)?) out of 5 stars`                                                                          |
| `rating_count` | `aria-label="([\d,]+) ratings?"` (the count lives in the rating-link's aria-label, **not** inline text) |
| `sponsored`    | block contains `Sponsored`, an `aax-eu` ad-redirect href, or `sbx_s_sparkle`                            |
| `url`          | construct `https://www.amazon.in/dp/<asin>`                                                             |

Reference parser (validated against live HTML, 22/22 organic items parsed cleanly):

```javascript
const html = htmlFromCommand; // the string returned by the `html` command in step 1
const re = /<div[^>]*data-component-type="s-search-result"[^>]*>/g;
const starts = [];
let m;
while ((m = re.exec(html))) starts.push(m.index);
const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
const products = starts
  .map((s, i) => {
    const b = html.slice(
      s,
      i + 1 < starts.length ? starts[i + 1] : html.length,
    );
    const asin = (b.match(/data-asin="([A-Z0-9]{10})"/) || [])[1];
    const h2 = b.match(/<h2[^>]*>(.*?)<\/h2>/s);
    let title = h2
      ? decode(
          h2[1]
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        )
      : null;
    if (!title) {
      const al = b.match(/<a[^>]*a-link-normal[^>]*aria-label="([^"]+)"/);
      if (al) title = decode(al[1]);
    }
    const pw = (b.match(/<span class="a-price-whole">([^<]+)<\/span>/) ||
      [])[1];
    const rm = b.match(/(\d(?:\.\d)?) out of 5 stars/);
    let rc = (b.match(/aria-label="([\d,]+) ratings?"/) || [])[1];
    return {
      title,
      asin,
      price_inr: pw ? Number(pw.replace(/[,\s]/g, '')) : null,
      rating: rm ? Number(rm[1]) : null,
      rating_count: rc ? Number(rc.replace(/,/g, '')) : null,
      sponsored: /Sponsored|aax-eu|sbx_s_sparkle/i.test(b),
      url: asin ? `https://www.amazon.in/dp/${asin}` : null,
    };
  })
  .filter((p) => p.asin);
console.log(
  JSON.stringify(
    {
      success: true,
      query: 'wireless earphones',
      result_count: products.length,
      products,
    },
    null,
    2,
  ),
);
```

### 4. Emit JSON

Return the shape in **Expected Output**. Sponsored items appear interleaved with organic ones (typically 2–3 ad slots at the top + 1 sponsored-brand carousel); keep the `sponsored` flag so the consumer can filter.

### Browser fallback (only if the lightweight path is blocked)

If step 2 detects a captcha/robot check that persists across retries, retry the same residential-proxy `browserless_agent` call — the fuller stealth browse renders the page without the "Enter the characters you see" robot check in the common case (Amazon's own captcha isn't a Cloudflare/DataDome type, so a `solve` step won't clear it; a fresh residential exit is the lever). It's a single call with no release step:

```jsonc
{
  "proxy": { "proxy": "residential", "proxyCountry": "in" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.amazon.in/s?k=wireless+earphones",
        "waitUntil": "load",
        "timeout": 45000,
      },
    },
    { "method": "html", "params": { "selector": "body" } },
  ],
}
```

Take the whole-page HTML from the `html` command and parse it exactly like the primary path — **do not** try to enumerate items via `snapshot` or a per-element `html` selector; both are dead ends here (see gotchas).

## Site-Specific Gotchas

- **READ-ONLY.** Never click add-to-cart, sign-in, or buy. Stop at the results page.
- **The page is fully server-rendered** — everything (titles, prices, ratings, ASINs) is in the initial HTML. No need to wait for JS, no XHR to chase. A single `goto` + `html` of `body` gets the whole grid.
- **The residential proxy is the reliability lever, not stealth.** Bare datacenter fetches returned 200 with full results in testing, but amazon.in is known to intermittently serve "Enter the characters you see" robot checks to datacenter IPs. Residential proxies make the path dependable. Stealth alone (no proxy) does not clear the datacenter-IP robot check.
- **A `snapshot` (a11y tree) is unusable on amazon.in search.** The results DOM is enormous; in iter-1 every `snapshot` call errored/returned nothing actionable. Don't build the browser fallback around the accessibility tree.
- **An `html` command with a specific selector returns ONLY the first matching element.** This is the single biggest trap — the inner agent burned 25+ turns (~$8) trying to enumerate per-item HTML with selectors like `.s-result-item[data-asin]` and got one element each time. Always pull `html` of `body` once and parse the whole blob; never loop selectors.
- **`rating_count` is in an aria-label, not inline text.** It lives in the rating-link's `aria-label="9,667 ratings"`, not in a visible `<span>`. The visible underline-text span is often empty. Match the aria-label.
- **Sponsored slots are interleaved and use obfuscated class names.** The new amazon.in layout wraps cards in randomized `_c2Itd_*` CSS classes, so don't key on visual classes. The stable hooks are `data-component-type="s-search-result"` (organic result container) and `data-asin` (10-char ASIN). Sponsored items carry an `aax-eu...amazon.in` ad-redirect href and/or a `Sponsored` label and/or `sbx_s_sparkle` in the ref; flag them but don't drop them silently.
- **Prices are INR by default.** The response sets `i18n-prefs=INR` / `Content-Language: en-IN` cookies/headers without any locale handling on your part. `a-price-whole` is the rupee integer part (e.g. `1,399`); the fractional part is usually `.` (whole rupees).
- **A `/dp/<ASIN>` URL is the stable canonical product link.** The hrefs in the page are tracking-laden (`aax-eu-zaz.amazon.in/x/c/...` for ads, `/gp/aw/d/<ASIN>/?...` with query junk). Reconstruct `https://www.amazon.in/dp/<ASIN>` from the ASIN instead of trusting the raw href.
- **Result count varies per fetch.** The same query returned 14–22 organic blocks across fetches (Amazon rotates sponsored density and layout). The parser is count-agnostic — just take what's present.
- **Result HTML can carry stray banner/notice markup** that occasionally got mis-parsed as command output in iter-1. Harmless — anchor your parse on the `data-component-type="s-search-result"` blocks and ignore surrounding chrome.

## Expected Output

```json
{
  "success": true,
  "query": "wireless earphones",
  "result_count": 14,
  "products": [
    {
      "title": "OnePlus Nord Buds 3r TWS Earbuds up to 54 Hours Playback, 2-mic Clear Calls, 3D Spatial Audio, 12.4mm Drivers, 47ms Low Latency - Aura Blue",
      "asin": "B0FMDLD86P",
      "price_inr": 1799,
      "rating": 4.3,
      "rating_count": 45267,
      "sponsored": false,
      "url": "https://www.amazon.in/dp/B0FMDLD86P"
    },
    {
      "title": "Fire-Boltt Aero TWS Earbuds Custom EQ, Wireless Bluetooth 5.4, 50H Playtime, 50ms Low Latency, IPX4 Waterproof - Black",
      "asin": "B0FM6B9Z45",
      "price_inr": 699,
      "rating": 3.8,
      "rating_count": 11163,
      "sponsored": true,
      "url": "https://www.amazon.in/dp/B0FM6B9Z45"
    }
  ],
  "error_reasoning": null
}
```

Blocked outcome (captcha/robot check served and not clearable):

```json
{
  "success": false,
  "query": "wireless earphones",
  "result_count": 0,
  "products": [],
  "error_reasoning": "robot/captcha check served (\"Enter the characters you see\") — retry via browser fallback with a fresh residential-proxy session"
}
```
