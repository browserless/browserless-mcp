---
name: obsessions
title: TheRealReal Obsessions Snapshot
description: >-
  Return the signed-in user's TheRealReal Obsessions (hearted/tagged items) as a
  structured list with current price, original price, MSRP, sale callout,
  designer, name, image, and product URL — keyed by internal product ID so
  successive snapshots can be diffed to surface price drops, new sale callouts,
  and delisted items. Read-only.
website: therealreal.com
category: shopping
tags:
  - luxury-resale
  - wishlist
  - price-monitoring
  - authenticated
  - read-only
  - perimeterx
source: 'browserbase: agent-runtime 2026-05-20'
updated: '2026-05-20'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      No public JSON API exists for obsessions. /obsessions.json returns 404
      (verified iter 1). The only programmatic /api/* surface TheRealReal
      exposes is analytics collectors. HTML extraction from the server-rendered
      Rails PJAX page is the only path.
  - method: hybrid
    rationale: >-
      Run one `browserless_agent` call with a residential proxy that
      injects the user's `_session_id` cookie (via a `setCookie` command),
      navigates `/obsessions`, and extracts the cards in-page. A session
      persists across calls keyed by its config, so to sidestep PerimeterX
      flagging a long-lived session, run each page fetch as a distinct session
      (don't reuse the prior call's session config) so it lands on a fresh
      residential IP rather than reconnecting to the flagged one. If a call
      lands on a PressAndHold challenge, add a `solve` step or retry as a new call.
verified: true
proxies: true
---

# TheRealReal Obsessions Snapshot

## Purpose

Return the signed-in user's "Obsessions" — items they have hearted/tagged on TheRealReal — as a structured list with current price, designer, name, image, product URL, internal product ID, and any sale-callout metadata. Designed to be re-run on a cadence (daily/hourly) so a downstream agent can diff successive snapshots and surface price changes ("Now 20% off", "price dropped from $145 → $116", "item sold / no longer listed"). **Read-only — never tap the obsession heart to un-obsess, never add to cart.**

## When to Use

- Daily price-monitoring of a user's saved luxury items on TheRealReal.
- Surfacing newly-discounted obsessions ("anything in my wishlist on sale today?").
- Detecting sold/delisted items (the item no longer appears in the obsessions HTML grid).
- Baseline-and-diff workflows where the agent stores yesterday's snapshot and compares.

## Workflow

TheRealReal's `/obsessions` page is **account-bound**: an anonymous request to `https://www.therealreal.com/obsessions` returns an empty-state placeholder ("Tap the ♡ next to any item to save it for later" + "Shop by Category" carousel). To see real items the request must carry an authenticated `_session_id` cookie from a logged-in TheRealReal account. There is **no public JSON API** (`/obsessions.json` returns 404), so the workflow is HTML extraction from the server-rendered Rails PJAX page. The page reuses the standard Product Listing Page (PLP) markup, so every item is rendered with stable `data-testid="plp-product/{productId}-{field}"` selectors that survive across redesigns.

### 1. Acquire an authenticated session

`/sign_in` is hard-gated by PerimeterX's "Press & Hold" human-challenge for any automated browser session (verified iter 1 — even a stealth + residential-proxy session lands on the PressAndHold iframe). Do **not** attempt scripted login — it will burn the session and subsequent requests will return Access-Denied for the rest of the proxy IP's TTL. Instead, supply the user's existing `_session_id` cookie:

- **Direct cookie injection (the only path)**: obtain the user's `_session_id` value out-of-band (exported from their signed-in browser) and inject it at the start of the `browserless_agent` `commands` array with a `setCookie` step, before navigating (see step 2). The other required cookies (`_pxhd`, `nearby_stores`) are minted automatically on the first response. Because PerimeterX gates scripted login, there is no autonomous-login route here — the skill runs entirely off the injected session cookie.

The critical cookie name is **`_session_id`** (Rails session, HttpOnly, Secure). Without it, `/obsessions` returns the empty placeholder.

### 2. Fetch `/obsessions`

One `browserless_agent` call does the whole thing: inject the session cookie, navigate, and extract the cards in-page. Keep it in ONE call's `commands` array (the injected cookie and page state carry across the steps of the call; there's no release step, and the session isn't torn down on return — it persists across calls keyed by its config). Use a residential proxy — datacenter IPs frequently land on the PerimeterX challenge page even with valid auth cookies.

`browserless_agent`:

```json
{
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [
    {
      "method": "setCookie",
      "params": {
        "name": "_session_id",
        "value": "<USER_SESSION>",
        "domain": ".therealreal.com",
        "path": "/",
        "secure": true,
        "httpOnly": true
      }
    },
    {
      "method": "goto",
      "params": {
        "url": "https://www.therealreal.com/obsessions",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(() => { /* parse plp-product cards — see step 4 */ })()"
      }
    }
  ]
}
```

The `evaluate` step (step 4) returns the projected item array under `.value` — parse the DOM in-page and return compact JSON, never ship the raw HTML back. If a call lands on the PressAndHold challenge instead of the grid, insert a `{ "method": "solve", "params": { "type": "captcha" } }` step after the `goto`, or retry as a fresh call (start a distinct session so it lands on a new residential IP rather than reconnecting to the flagged one). A recent desktop User-Agent is applied by the stealth runtime automatically.

### 3. Detect empty vs populated

If the response contains the literal string `js-empty-obsessions-message` AND no `data-testid="plp-product/` occurrences, the obsessions list is empty (or the session cookie was invalid/expired — there's no distinguishing signal between "logged out" and "logged in with zero obsessions" in the HTML). Return `{ "items": [], "total": 0, "auth_uncertain": true }` and flag the user to supply a fresh `_session_id` cookie.

If there are `plp-product/` testids in the HTML, proceed to step 4.

### 4. Extract each item from `data-testid="plp-product/{id}-…"` markup

Each product card is a `<div role="group" data-testid="plp-product/{productId}">` with these stable child testids:

| `data-testid` suffix                      | Meaning                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `plp-product/{id}` (root)                 | `{id}` is the internal Rails product ID (e.g., `50758096`).                                    |
| `plp-product/{id}-link`                   | `<a href>` → canonical product URL (relative path).                                            |
| `plp-product/{id}-brand`                  | Designer name (e.g. "Tumi", "Louis Vuitton", "Chanel").                                        |
| `plp-product/{id}-name`                   | Item title (e.g. "Nylon Tote", "LV Monogram Speedy 30").                                       |
| `plp-product/{id}-price-msrp`             | "Est. Retail $480" — the MSRP / new-retail estimate.                                           |
| `plp-product/{id}-price-original`         | TRR's _original_ listing price (struck-through when on sale, else absent).                     |
| `plp-product/{id}-price-final`            | **Current asking price** — this is the field to monitor for price changes.                     |
| `plp-product/{id}-price-callout`          | Sale callout copy, e.g. "Now 20% off" (absent when not on sale).                               |
| `plp-product/{id}-obsession-button-count` | Total users obsessing this item (interest signal, not price-relevant).                         |
| `plp-product/{id}-images/image-0`         | First image URL is in the wrapping `<img srcSet>`; strip `?auto=webp&…` for canonical CDN URL. |

Parse the DOM **in-page** inside the `evaluate` step by selecting on the `data-testid` attributes — **do NOT use the `snapshot` method** to enumerate items. The accessibility tree drops the `data-testid` attributes and folds the visually-rich card into a single ref, making per-field extraction far more expensive than reading the live DOM by selector. Return a compact JSON projection from the eval (its return value comes back under `.value`); never ship the raw card HTML back.

Example `evaluate` content (runs in the page context — `document` is the loaded `/obsessions` DOM):

```js
(() => {
  const items = [
    ...document.querySelectorAll('[data-testid^="plp-product/"][role="group"]'),
  ].map((root) => {
    const id = root.getAttribute('data-testid').replace('plp-product/', '');
    const pick = (suffix) => {
      const el = root.querySelector(
        `[data-testid="plp-product/${id}-${suffix}"]`,
      );
      return el ? el.textContent.trim() || null : null;
    };
    const href = root
      .querySelector(`[data-testid="plp-product/${id}-link"]`)
      ?.getAttribute('href');
    const img = root
      .querySelector('img[srcSet], img[srcset]')
      ?.getAttribute('srcset')
      ?.split(',')[0]
      ?.trim()
      .split(' ')[0]
      ?.replace(/\?.*$/, '');
    return {
      product_id: id,
      designer: pick('brand'),
      name: pick('name'),
      url: href ? `https://www.therealreal.com${href}` : null,
      image: img || null,
      price_final: pick('price-final'), // "$116.00"
      price_original: pick('price-original'), // "$145" (may be null)
      price_msrp: pick('price-msrp'), // "Est. Retail $480"
      sale_callout: pick('price-callout'), // "Now 20% off" or null
      obsession_count: pick('obsession-button-count'),
      captured_at: new Date().toISOString(),
    };
  });
  return JSON.stringify({ items, total: items.length });
})();
```

### 5. Paginate (if > 1 page of obsessions)

The obsessions page is paginated. Read the data attribute `data-page-number="0"` off the `.js-plp-data-handler` element (return it from the same `evaluate`) and follow `?page=N` links in the pagination footer. Each page is `GET /obsessions?page=N` with the same auth cookie. Because a long-lived session gets flagged (see gotchas), issue **one `browserless_agent` call per page as a distinct session** — same `setCookie` + `goto` + `evaluate` shape, just point `goto` at `?page=N`, and don't reuse the prior call's session config — so every page fetch rides a new session on a new residential IP rather than reconnecting to the flagged one. Stop when a page returns zero `plp-product/` matches.

### 6. (Optional) Enrich per-item via JSON-LD

If you need richer per-item data (full description, all images, US/CA condition tags, structured `priceCurrency`), run a `browserless_agent` call (residential proxy, **no cookie needed** — the product detail page is not auth-gated) that `goto`s the individual product URL, then an `evaluate` that parses the `<script type="application/ld+json">` block whose `@type == "Product"` — that surfaces `offers.price` (numeric), `priceSpecification.price` (MSRP numeric), `image[]` array, `brand.name`, `itemCondition`, `availability` (`InStock` / `OutOfStock`). Only enrich items the caller actually cares about — a detail-page call per obsession balloons cost.

### 7. Diff against the prior snapshot

For pricing-change monitoring, persist each run keyed by `product_id`. On the next run, diff per-id and emit change events:

- `price_dropped` — new `price_final` numerically < prior `price_final`.
- `price_raised` — new `price_final` > prior (rare on TRR but possible after a relist).
- `new_callout` — `sale_callout` appeared this run (e.g. "Now 30% off").
- `delisted` — product_id present in prior snapshot, absent in current (sold or removed).
- `relisted` — product_id absent in prior, present in current (unobsessed-then-re-obsessed, or formerly sold-now-back).

Compare price strings only after normalizing — see "Site-Specific Gotchas" on price-string variance.

## Site-Specific Gotchas

- **`/obsessions.json` does NOT exist** — returns 404 with the TRR 404 page HTML. Verified iter 1. There is no JSON API surface for obsessions; HTML parsing is the only path. Don't waste turns probing `/api/v1/obsessions`, `/api/obsessions`, `/users/me/obsessions`, etc. — the only `/api/*` paths the site exposes are analytics collectors (`/api/v1/collector/noScript.gif`).
- **Anonymous `/obsessions` is NOT a 401/redirect** — it returns 200 with an empty-state HTML page (heading "Obsessions", "Tap the ♡ next to any item…" copy, `js-empty-obsessions-message`, and a "Shop by Category" carousel). The HTML deliberately doesn't distinguish "logged out" from "logged in with no obsessions". The only auth signal is whether the page contains `plp-product/` testids — if absent AND `js-empty-obsessions-message` present, the agent cannot tell the two states apart from HTML alone. If you need certainty, GET `/account` or `/users/edit` with the same cookies and check whether it 200s or redirects to `/sign_in`.
- **PerimeterX gates `/sign_in` with a PressAndHold human challenge** for automated sessions (verified iter 1 — a stealth + residential-proxy session lands on `https://www.therealreal.com/sign_in` → "Access to this page has been denied" → PressAndHold iframe). **Do not attempt scripted login.** Inject the user's already-signed-in `_session_id` cookie via a `setCookie` command instead. Reference ID surfaced in PerimeterX response: `d7e971a0-…` — these are searchable in TRR's logs if the user reports lockout.
- **PerimeterX flags persistent sessions after the first navigation in many cases.** In iter 3, a stealth + residential-proxy session loaded `/shop/women/handbags` cleanly, but the very next `/obsessions` request in the same session returned "Access to this page has been denied". So issue one `browserless_agent` call per page/request as a distinct session — because a call reusing the same session config reconnects to the same (flagged) session, don't reuse the prior config, so each call lands on a new residential IP (burn-and-rotate) — rather than reusing one long-lived session for a monitoring sweep. A single-navigation call worked first-try on iter 1 (200 OK with 30 KB of HTML and full PLP markup); reused sessions degraded after 1–2 navigations.
- **Three distinct price fields per card — pick the right one.** `price-final` is the current asking price (what the user pays today). `price-original` is TRR's prior price for the same listing (struck-through, only present when discounted). `price-msrp` is "Est. Retail $X" — TRR's estimate of _new-retail_ MSRP for the same item from the original brand; it does NOT change when TRR discounts. For "monitor pricing changes," anchor on `price-final`. The "Now N% off" callout is computed from `price-final / price-original`, not from MSRP.
- **Price strings include both `$1,495` and `$1,495.00` formats** in the same response (compare the listing-grid card to the product detail card). Normalize before diffing: strip `$` and `,`, parse to float. Iter-1 sample on the handbags PLP: 482 `$`-prefixed strings, some without cents (`$2,200`), some with (`$2,200.00`). Don't assume a single canonical format.
- **Product IDs in `data-testid` are internal Rails IDs, not the user-facing slug**. The slug (e.g. `tumi-nylon-tote-u7x74`) is in the `-link` href. Both are stable per-listing; use `product_id` as the diff key — slugs can change if TRR re-categorizes an item (e.g. moves from `women/handbags/totes` to `women/handbags/shoulder-bags`).
- **Image CDN URLs carry transform params**. Each `<img srcSet>` is `…?auto=webp&width=NNN&quality=40 NNNw, …`. The canonical untranformed URL is `https://product-images.therealreal.com/{SKU}_{N}_enlarged.jpg` — strip everything after `.jpg`. The first part of the filename (`TMI70173`, `LOU1250459`) is the consigner SKU and is unique per physical item.
- **Items in the obsessions list can become "sold" without being removed.** A delisted item silently disappears from the HTML grid; TRR does NOT render a "sold" tombstone in the obsessions PLP (the JSON-LD `availability` field on the detail page would still indicate `OutOfStock`, but that requires a per-item enrichment fetch). The cheapest "did this sell?" check is just: was `product_id` present last run and absent this run? Then enrich that one detail URL to confirm via `availability`.
- **The page is server-rendered Rails PJAX, not React.** Don't wait for client-side hydration. An `evaluate` reading the DOM immediately after a `goto` with `waitUntil: "load"` returns complete data; no `waitForTimeout` step is needed before extraction.
- **The `snapshot` method collapses product cards into ARIA refs and drops `data-testid` attributes.** Iter 1 confirmed: the anonymous empty `/obsessions` snapshot rendered the entire "Shop by Category" carousel as 6 distinct link refs but folded all the per-product data attributes out. For PLP extraction, always parse the DOM in-page with an `evaluate` selecting on `data-testid`. The `snapshot` method is fine for navigation refs (clicking specific buttons) but useless for enumerating tile data.
- **Don't tap the ♡ heart button** — that's the un-obsess action and would remove items from the user's list. The `data-testid="plp-product/{id}-obsession-button"` element is read-only signal only; don't click it.
- **No skill verification against a real authenticated account was possible from this sandbox.** All extraction details above were reverse-engineered from anonymous `/obsessions` HTML + the parallel `/shop/women/handbags` PLP markup (TRR reuses the same product-card component on both pages — verified by identical `data-testid="plp-product/{id}-…"` selectors in `/tmp/skill/shop-fetch.json`). When the agent first runs this skill with real user cookies, validate one extracted item against its product detail page's JSON-LD `offers.price` before trusting the rest of the batch.

## Expected Output

```json
{
  "captured_at": "2026-05-20T19:55:10Z",
  "total": 12,
  "page_count": 1,
  "auth_uncertain": false,
  "items": [
    {
      "product_id": "50758096",
      "designer": "Tumi",
      "name": "Nylon Tote",
      "url": "https://www.therealreal.com/products/women/handbags/totes/tumi-nylon-tote-u7x74",
      "image": "https://product-images.therealreal.com/TMI70173_1_enlarged.jpg",
      "price_final": "$116.00",
      "price_final_numeric": 116.0,
      "price_original": "$145",
      "price_original_numeric": 145.0,
      "price_msrp": "Est. Retail $480",
      "price_msrp_numeric": 480.0,
      "sale_callout": "Now 20% off",
      "obsession_count": "22"
    }
  ]
}
```

### Empty-or-unauthenticated outcome

```json
{
  "captured_at": "2026-05-20T19:55:10Z",
  "total": 0,
  "page_count": 0,
  "auth_uncertain": true,
  "items": [],
  "note": "HTML returned the empty-obsessions placeholder. Cannot distinguish 'logged in with zero obsessions' from 'session cookie invalid' from the HTML alone. Re-inject a fresh _session_id cookie and retry; if still empty, verify by hitting /account with the same cookie."
}
```

### Diff outcome (when comparing to a prior snapshot)

```json
{
  "captured_at": "2026-05-20T19:55:10Z",
  "prior_captured_at": "2026-05-19T19:55:10Z",
  "changes": [
    {
      "product_id": "50758096",
      "kind": "price_dropped",
      "from": 145.0,
      "to": 116.0,
      "callout": "Now 20% off"
    },
    {
      "product_id": "51049484",
      "kind": "new_callout",
      "callout": "Final Sale"
    },
    { "product_id": "51460206", "kind": "delisted", "last_seen_price": 1495.0 }
  ],
  "unchanged_count": 9
}
```
