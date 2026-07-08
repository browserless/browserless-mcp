---
name: search-products
title: Amazon Product Search
description: >-
  Search Amazon for products matching a query with the full filter surface
  (department, brand, rating, price, deals, condition, sort, pagination) and
  return structured JSON per result: ASIN, title, price, rating, badges, image,
  and canonical /dp/ URL.
website: amazon.com
category: ecommerce
tags:
  - amazon
  - ecommerce
  - product-search
  - shopping
  - scraping
source: 'browserbase: agent-runtime 2026-06-04'
updated: '2026-07-08'
recommended_method: browser
alternative_methods:
  - method: url-param
    rationale: >-
      All filter/sort/pagination state is encoded in the /s URL query string (k,
      s, page, rh=key:value fragments), so a caller can deep-link any filter
      combination directly — but the page itself is still anti-bot-walled and
      must be loaded through a stealthed browser, so this is an addressing
      convenience layered on top of the browser method, not a standalone HTTP
      route.
  - method: fetch
    rationale: >-
      Plain HTTP GET of /s (residential proxy, no JS) was NOT pursued to a
      reliable state: Amazon serves results client-rendered behind bot
      fingerprinting and frequently returns a 503 interstitial or Robot Check to
      non-browser clients. No unauthenticated product-listing JSON endpoint was
      found. Use the browser path.
verified: true
proxies: true
---

# Amazon Product Search

## Purpose

Search amazon.com for products matching a query, applying any of the filters Amazon's
search UI exposes (department, brand, customer-review rating, price range, deals,
condition, seller, delivery speed, sort order, pagination), and return the matching
results as structured JSON. For each product it returns ASIN, title, primary image +
thumbnails, current/list price + discount %, rating (stars + review count), Prime /
sponsored / badge flags, and the canonical `/dp/{ASIN}` URL, plus the region-wide
`totalResultCount` from the results header. **Read-only** — it never adds to cart,
buys, subscribes, or signs in.

## When to Use

- "Search Amazon for `<query>`" with or without filters, and return the result list.
- Price/availability monitoring across a filtered query (e.g. "wireless keyboards under
  $50, 4 stars & up, sorted cheapest first").
- Resolving a free-form query, a keyword+department, a full `amazon.com/s?...` URL, a
  category-browse intent ("Bestsellers in Coffee"), or a list of ASINs into structured
  product records.
- Anywhere you'd otherwise scrape Amazon search HTML — this documents the exact
  query-string filter encodings and a DOM extractor that survives Amazon's layout.

## Workflow

Amazon search results are client-rendered behind aggressive bot fingerprinting. There is
**no unauthenticated product-listing JSON endpoint**, and a plain HTTP `GET /s` (even via
residential proxy) typically returns a 503 interstitial or a Robot Check. The reliable path
is `browserless_agent` with a residential proxy that loads the real `/s` page, extracted via
an `evaluate` expression — never `snapshot` (see Gotchas).

**This is one long-running browser session you drive across as many `browserless_agent` calls
as you want — not a one-shot.** The session persists across calls, keyed by the `proxy` config:
every call that carries the **same** `proxy` reconnects to the same warmed browser with the
current page, cookies, and `/s` results still loaded. So the normal pattern is warm up once,
then fire follow-up `evaluate`/`goto` calls against the live page — an extra step or a failed
step **never** means re-running the warm-up, and a follow-up `evaluate`-only call does **not**
hit a cold session. Batching the steps into one `commands` array (shown below) is only a
convenience that saves round trips; splitting them across calls is equally valid. The one hard
rule: **pass the same `proxy` on every call** — drop it and you land in a different, blank
session (see step 6). All filter/sort/pagination state lives in the `/s` URL query string, so
you build the URL once.

1. **Set `proxy: { proxy: "residential", proxyCountry: "us" }` on the call.** Amazon needs the
   residential proxy — a bare/datacenter session gets an immediate Robot Check. **Always pin
   `proxyCountry`** to the storefront you're scraping (`us` for amazon.com): without it the
   residential pool can land on an EU/other IP and amazon.com renders EUR (or another currency)
   prices, silently mismatching the hardcoded currency assumption. For a non-US storefront, pin
   the matching country (`gb` for amazon.co.uk, `de` for amazon.de, …).

2. **Build the search URL.** Base `https://www.amazon.com/s?k=<url+encoded+query>` (encode
   spaces as `+`). Then append:
   - `&s=<sort>` — `relevanceblender` (Featured, default), `price-asc-rank`,
     `price-desc-rank`, `review-rank` (Avg. Customer Review), `date-desc-rank` (Newest),
     `exact-aware-popularity-rank` (Best Sellers).
   - `&page=<N>` — pagination (default page returns ~16–48 cards).
   - `&rh=<comma-joined key:value filter fragments>` — see the encoding table in Gotchas.
   - For an **ASIN list**, skip search and open `https://www.amazon.com/dp/<ASIN>` per ASIN.
   - For a **full URL input**, use it as-is (optionally append more `rh` fragments).

3. **Warm up, open, and wait for result cards.** Shown below as one `commands` array for
   convenience, but you can equally split these across separate calls that each repeat the same
   `proxy: { proxy: "residential", proxyCountry: "us" }` — the warmed page carries over between calls:

   ```jsonc
   "commands": [
     { "method": "goto", "params": { "url": "https://www.amazon.com/", "waitUntil": "load", "timeout": 45000 } },
     { "method": "waitForTimeout", "params": { "time": 1500 } },
     { "method": "goto", "params": { "url": "<search url>", "waitUntil": "load", "timeout": 45000 } },
     { "method": "waitForSelector", "params": { "selector": "div[data-component-type=s-search-result]", "timeout": 10000 } },
     { "method": "evaluate", "params": { "content": "<EXTRACTOR_JS>" } }
   ]
   ```

   Hitting `/` first establishes cookies and avoids the fresh-session 503. If `waitForSelector`
   times out, `text` on `body` and check for a Robot Check (see Gotchas). On a transient 503,
   add a `reload` + re-wait.

4. **Extract with `evaluate`** (NOT `snapshot`). The extractor returns a JSON string under
   `.value` — `JSON.parse` it → `{ totalResultCount, resultCount, results[] }`.

5. **Paginate / limit.** For more than one page, add more `goto &page=2`/`&page=3` +
   `evaluate` steps to the same call and concatenate `results[]`. `totalResultCount` tells the
   caller the slice is partial.

6. **The session persists across calls — it does NOT tear down on return.** It is keyed by
   the call's session config (`proxy` / `profile`): a later call carrying the **same** `proxy`
   reconnects to the same warmed, logged-in-to-cookies browser with the `/s` page still loaded;
   a call that **drops** `proxy` lands in a _different_ (default, un-warmed) session that looks
   blank and will 503/Robot-Check on Amazon. So:
   - **Pass the same `proxy` on every call of the flow**, not just the first. Dropping it is the
     usual cause of a "logged-out"/blank follow-up — re-issue _with_ `proxy` before assuming the
     session died.
   - **Recover from a failed step by re-issuing that step alone** (same `proxy`), against the
     page still in the session — do **not** restart the warm-up batch. E.g. if `evaluate` throws,
     just call `evaluate` again; the `/s` page is still there.

### The extractor (`evaluate` expression)

> **Pass this as a single-line string in `evaluate.content`.** Minify it (strip the
> newlines) before putting it in the JSON tool call — a pretty-printed multi-line blob
> stuffed into a JSON string field is the #1 cause of `SyntaxError: Invalid or unexpected
token` on the first try. Note there is **no `'\n'` string literal anywhere in this
> extractor** (the old version split the header on `'\n'`, which mangles under JSON
> escaping); the header is a single-line read via `.textContent`, and `String.fromCharCode(10)`
> is used if you ever need a newline.

```js
(() => {
  const num = (s) => {
    if (!s) return null;
    const m = String(s).replace(/[^0-9.]/g, '');
    return m ? parseFloat(m) : null;
  };
  const intnum = (s) => {
    if (!s) return null;
    const m = String(s).replace(/[^0-9]/g, '');
    return m ? parseInt(m, 10) : null;
  };
  // Read currency from the price string, not the proxy assumption. Handles "$", "EUR",
  // "£", "USD", etc. Returns a best-effort code/symbol or null.
  const cur = (s) => {
    if (!s) return null;
    const code = String(s).match(/[A-Z]{3}/);
    if (code) return code[0];
    const sym = { $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' };
    for (const k in sym) if (s.includes(k)) return sym[k];
    return null;
  };
  const headerEl =
    document.querySelector('[data-component-type="s-result-info-bar"]') ||
    document.querySelector('.s-breadcrumb');
  const headerTxt = headerEl ? headerEl.textContent.trim() : '';
  const tm =
    headerTxt.match(/of\s+(over\s+)?([\d,]+)\s+results/i) ||
    headerTxt.match(/([\d,]+)\s+results/i);
  const total = tm ? parseInt(tm[tm.length - 1].replace(/,/g, ''), 10) : null;
  const cards = [
    ...document.querySelectorAll('div[data-component-type="s-search-result"]'),
  ];
  const seen = new Set();
  const results = [];
  for (const c of cards) {
    const asin = c.getAttribute('data-asin') || null;
    if (!asin || seen.has(asin)) continue; // dedup: Amazon repeats cards across carousels
    const h2 = c.querySelector('h2');
    const img = c.querySelector('img.s-image');
    // Full product title lives in the image alt text; the <h2> often holds only the
    // brand line now. Prefer alt, strip the "Sponsored Ad - " prefix, fall back to h2.
    let title = img ? (img.getAttribute('alt') || '').trim() : '';
    title = title.replace(/^Sponsored Ad\s*-\s*/i, '').trim();
    if (title.length < 5) title = h2 ? h2.innerText.trim() : null;
    const priceOff = c.querySelector(
      '.a-price:not(.a-text-price) .a-offscreen',
    );
    const listOff =
      c.querySelector('.a-price.a-text-price .a-offscreen') ||
      c.querySelector('[data-a-strike="true"] .a-offscreen');
    const ratingEl = c.querySelector('.a-icon-alt');
    let reviewCount = null;
    for (const e of c.querySelectorAll('[aria-label]')) {
      const a = e.getAttribute('aria-label');
      if (/^[\d,]+\s+ratings?$/i.test(a)) {
        reviewCount = intnum(a);
        break;
      }
    }
    const txt = c.innerText;
    const curVal = num(priceOff?.textContent),
      list = num(listOff?.textContent);
    seen.add(asin);
    results.push({
      asin,
      title: title || null,
      imageUrl: img ? img.getAttribute('src') : null,
      thumbnails:
        img && img.getAttribute('srcset')
          ? [
              ...new Set(
                img
                  .getAttribute('srcset')
                  .split(',')
                  .map((s) => s.trim().split(' ')[0]),
              ),
            ]
          : [],
      price:
        curVal != null
          ? {
              formatted: priceOff.textContent,
              raw: curVal,
              currency: cur(priceOff.textContent),
            }
          : null,
      listPrice:
        list != null ? { formatted: listOff.textContent, raw: list } : null,
      discountPercent:
        curVal != null && list != null && list > curVal
          ? Math.round((1 - curVal / list) * 100)
          : null,
      rating: {
        stars: ratingEl ? num(ratingEl.textContent.split(' ')[0]) : null,
        reviewCount,
      },
      primeEligible: !!c.querySelector(
        '[data-cy="delivery-recipe"] .prime-brand-color, i.a-icon-prime',
      ),
      sponsored: !!c.querySelector(
        '.puis-sponsored-label-text, .s-sponsored-label-text, [aria-label="View Sponsored information"]',
      ),
      badges: [
        /Amazon's Choice/i.test(txt) && "Amazon's Choice",
        /Best Seller/i.test(txt) && 'Best Seller',
        /Climate Pledge Friendly/i.test(txt) && 'Climate Pledge Friendly',
      ].filter(Boolean),
      url: 'https://www.amazon.com/dp/' + asin,
    });
  }
  return JSON.stringify({
    totalResultCount: total,
    resultCount: results.length,
    results,
  });
})();
```

## Site-Specific Gotchas

- **A residential proxy is mandatory.** With `proxy: { proxy: "residential" }` the call
  loaded full results with no CAPTCHA across all test iterations. Do **not** run bare —
  expect an immediate Robot Check without it.
- **Never `snapshot` on `/s` pages.** Amazon's accessibility tree is enormous and can
  exceed the tool-result size limit, so the `snapshot` command fails or truncates. Use
  `evaluate` for all extraction. (`text`/`html` on the whole results container is also too
  large and returns inline script junk — scope any read to a single small element, or just
  use the extractor.)
- **First load may 503 — warm up via the homepage.** A transient "Sorry! Something went
  wrong!" page is common when the first navigation of a fresh session is the `/s` search URL
  (no cookies yet). The fix (built into step 3): `goto https://www.amazon.com/` first, wait
  ~1.5 s, then `goto` the search URL — all in the same call so cookies carry over. If a 503
  still appears, add a `reload` + re-wait for the result-card selector.
- **`rh=` filter node IDs are NOT stable constants — read them from the live filter rail.**
  The "4 Stars & Up" link rendered `p_72:1248879011` on one query and `p_72:1248915011`
  on another, and both resolve to the same filter. The robust pattern: load a first,
  unfiltered results page, read the `href` of the desired filter's anchor in the left rail
  (`#s-refinements a[href*="rh="]`), copy its `rh=` fragment, then re-open the URL with that
  fragment appended. Only the **key names** and the `s=` / `k=` / `page=` tokens are stable.
- **Verified `rh` key names / encodings:**

  | Filter                                                       | `rh` fragment                                             | Notes                                                                                          |
  | ------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
  | Department / category                                        | `n:<categoryNodeId>`                                      | also addressable via `&i=<alias>` (e.g. `i=electronics`)                                       |
  | Customer reviews (min stars)                                 | `p_72:<id>`                                               | id dynamic; read from rail (1/2/3/4-star surfaced)                                             |
  | Price range                                                  | `p_36:<minCents>-<maxCents>`                              | **cents**, no decimals; open-ended `2500-` or `-5000`; preset buckets are just specific ranges |
  | Brand                                                        | `p_89:<BrandName>` or `p_123:<id>`                        | key varies by category; multi-select pipe-joined (`                                            | `)  |
  | Today's Deals                                                | `p_n_deal_type:23566064011`                               | verified from rail                                                                             |
  | Climate Pledge Friendly                                      | `p_n_cpf_labels:<id>`                                     | read from rail                                                                                 |
  | Free shipping / Prime delivery                               | `p_76:<id>` / `p_90:<id>`                                 | category-dependent                                                                             |
  | Seller                                                       | `p_6:<merchantId>`; Amazon-as-seller `&emi=ATVPDKIKX0DER` | merchant IDs dynamic                                                                           |
  | Category-specific facets (color, size, connectivity, fit, …) | `p_n_g-<id>:<value>`                                      | always read from the rendered rail                                                             |

  Combine multiple filters by comma-joining inside one `rh=`:
  `rh=n:172282,p_72:1248879011,p_36:2500-5000`.

- **`primeEligible` is best-effort on logged-out search.** Amazon rarely renders a
  definitive per-item Prime badge to a signed-out visitor; a `prime-signup-ingress` upsell
  appears on most cards and is NOT a reliable signal, so the extractor keys off the Prime
  brand-color logo inside the delivery recipe and may under-report. To _guarantee_ Prime
  results, apply the Prime rail filter — then every returned item is Prime by construction.
- **Title comes from the image `alt`, NOT `<h2>`.** On the current layout `<h2>.innerText`
  frequently returns only the brand line (e.g. bare `"Skullcandy"`). The full product name is
  in `img.s-image[alt]`. The extractor reads `alt`, strips a leading `"Sponsored Ad - "`, and
  only falls back to `<h2>` when `alt` is missing/too short. If you write your own extractor,
  do the same or every title collapses to the brand.
- **Currency follows the proxy IP — don't hardcode it.** amazon.com renders prices in the
  currency of the exit IP's region, so a residential proxy that lands in the EU yields `EUR`
  prices on the US storefront. Two independent fixes, apply both: pin `proxyCountry: "us"`
  (step 1) so you actually get USD, and read the currency from the price string (the extractor's
  `cur()` helper) rather than asserting `"USD"`. A mismatch between the two is the tell that the
  proxy geo is wrong.
- **Dedup by ASIN.** Amazon repeats the same product across sponsored slots and carousels, so
  the raw card list contains duplicate `data-asin` values. The extractor keeps a `seen` set;
  don't drop it or the caller gets the same item several times.
- **`brand` is usually not surfaced** as separate text on modern result cards (it lives in
  the title); leave it `null` when absent rather than guessing.
- **Result cards per page vary** (~16 at a default desktop viewport, up to 48). Always read
  `totalResultCount` from the header so the caller knows the slice is partial; paginate
  with `&page=N`.
- **Non-US storefronts** (`.co.uk`, `.de`, …): the `rh` key names are the same but the
  numeric IDs, currency, and rail labels differ — always read filter encodings from that
  storefront's rendered rail, and read the currency from the price string.
- **Robot Check handling.** If `waitForSelector` times out and `text` on `body` contains
  "Enter the characters you see" / "Robot Check" / "we just need to make sure you're not a
  robot": the `solve` command can attempt Amazon's captcha, but if it doesn't clear, do **not**
  keep hammering — `screenshot` it and return
  `{ "success": false, "captchaEncountered": true, "error_reasoning": "<page text>" }`.
  Triggers observed: bare/datacenter sessions and high request volume; a residential-proxy call
  avoided it entirely in testing.

## Expected Output

Success (one page of a filtered query):

```json
{
  "success": true,
  "query": "wireless mechanical keyboard",
  "appliedFilters": {
    "minRating": 4,
    "priceRangeCents": null,
    "sort": "price-asc-rank"
  },
  "totalResultCount": 5000,
  "pageReturned": 1,
  "resultCount": 16,
  "results": [
    {
      "asin": "B0DXJQT19B",
      "title": "Anker USB C Hub, 7in1 Multi-Port USB Adapter ...",
      "brand": null,
      "imageUrl": "https://m.media-amazon.com/images/I/71Z9T0VgGyL._AC_UY218_.jpg",
      "thumbnails": [
        "https://m.media-amazon.com/images/I/71Z9T0VgGyL._AC_UY218_.jpg",
        "https://m.media-amazon.com/images/I/71Z9T0VgGyL._AC_UY327_FMwebp_QL65_.jpg"
      ],
      "price": { "formatted": "$19.99", "raw": 19.99, "currency": "USD" },
      "listPrice": { "formatted": "$25.99", "raw": 25.99 },
      "discountPercent": 23,
      "rating": { "stars": 4.6, "reviewCount": 3786 },
      "primeEligible": false,
      "sponsored": false,
      "badges": ["Amazon's Choice"],
      "url": "https://www.amazon.com/dp/B0DXJQT19B"
    }
  ],
  "captchaEncountered": false,
  "error_reasoning": null
}
```

Item with no sale / no reviews (nulls instead of omitted keys):

```json
{
  "asin": "B0CZ6S8PX5",
  "title": "One Handed Gaming Keyboard 35 Keys ...",
  "brand": null,
  "imageUrl": "https://m.media-amazon.com/images/I/61D7NI7tdRL._AC_UY218_.jpg",
  "thumbnails": [],
  "price": { "formatted": "$7.99", "raw": 7.99, "currency": "USD" },
  "listPrice": null,
  "discountPercent": null,
  "rating": { "stars": 5, "reviewCount": 1 },
  "primeEligible": false,
  "sponsored": false,
  "badges": [],
  "url": "https://www.amazon.com/dp/B0CZ6S8PX5"
}
```

Blocked by Robot Check (do not solve — ship this shape):

```json
{
  "success": false,
  "query": "wireless mechanical keyboard",
  "totalResultCount": null,
  "results": [],
  "captchaEncountered": true,
  "error_reasoning": "Robot Check — 'Enter the characters you see below. Sorry, we just need to make sure you're not a robot.'"
}
```
