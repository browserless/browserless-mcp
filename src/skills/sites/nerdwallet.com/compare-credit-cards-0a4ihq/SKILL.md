---
name: compare-credit-cards
title: NerdWallet Credit Card Comparison
description: >-
  Search and compare credit cards on NerdWallet (category, card name, full URL,
  or free-form criteria) and return structured per-card data — rating, fees,
  intro APR, welcome bonus, rewards, pros/cons, key benefits, and the affiliate
  Apply Now URL (captured, never followed). Read-only.
website: nerdwallet.com
category: credit-cards
tags:
  - credit-cards
  - comparison
  - nerdwallet
  - rewards
  - travel-cards
  - read-only
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      No public JSON or GraphQL API exists. Robots.txt explicitly disallows
      /CreditCardDetailAJAX, /compareajax, /structured-content-renderer, /api/,
      /cc-prequal-service/; direct probes (2026-05-18) returned 404/405 on every
      plausible endpoint. Do not invest more cycles searching for one.
  - method: url-param
    rationale: >-
      Category-page query params (?sort=, ?filter=) are inconsistently honored —
      a handful of pages respect a few sort keys but most ignore unknowns and
      render the editorial default. Sort/filter client-side after parsing.
  - method: hybrid
    rationale: >-
      Use a lightweight browserless_function fetch (no full page render) for the
      sitemap + robots.txt + the /credit-cards root to discover canonical slugs,
      then escalate to a full browserless_agent render for the category and
      review pages (every /credit-cards/best/{slug} and
      /credit-cards/reviews/{slug} page is large — project/extract the cards
      in-page rather than returning the whole >1MB document).
verified: false
proxies: true
---

# NerdWallet Credit Card Comparison

## Purpose

Search and compare credit cards on NerdWallet given (a) a full NerdWallet credit-card URL, (b) a category intent like "best travel cards" / "cash back cards" / "0% intro APR cards", (c) a specific card name (returns that one card's detail), or (d) free-form criteria ("travel card with no foreign transaction fee"). Returns a list of cards — name, issuer, network, star rating, fees, intro APR, welcome bonus, rewards structure, pros/cons, key benefits, "Apply Now" affiliate URL (captured, not followed), and canonical review URL — plus editorial context (NerdWallet's "Why we like it" blurb, "Best for…" tag, last-reviewed timestamp). Read-only — never clicks Apply Now, Apply, Get Started, Sign In, or submits an application form.

## When to Use

- "Show me the best travel credit cards on NerdWallet."
- "Compare NerdWallet's top no-annual-fee cards."
- "What's the NerdWallet rating + intro APR offer on Chase Sapphire Preferred?"
- A scheduled rescore that diffs today's NerdWallet category page vs. yesterday's snapshot.
- Aggregating editorial pros/cons across issuers to feed a card-recommendation pipeline.
- Anywhere a downstream agent needs structured card data + editorial commentary without re-implementing the NerdWallet review schema by hand.

## Workflow

NerdWallet's category pages render the card grid into static-after-hydration HTML — the data is there, but the document is large (typical category page > 1 MB, occasionally 2 MB+) and there is **no public JSON or GraphQL API**: every internal endpoint hinted at by robots.txt (`/CreditCardDetailAJAX`, `/compareajax`, `/structured-content-renderer`, `/api/*`) is locked to internal callers or returns 405/404 from the public surface (verified 2026-05-18 — see Site-Specific Gotchas). JSON-LD blocks on category pages describe the _page_ (Organization, VideoObject) not the cards, so the only path to per-card data is to parse the rendered card grid. **Therefore the recommended method is `browser` — render the page with `browserless_agent` and parse in-page. The category pages are large (>1 MB), so extract only the projected card JSON inside the render rather than shipping the whole document back (that would blow the ~200k-char text-return cap).**

1. **Resolve the input to a canonical URL.**
   - **Full URL given** — if it starts with `https://www.nerdwallet.com/credit-cards/best/...` or `https://www.nerdwallet.com/credit-cards/reviews/...`, use as-is. If it starts with the deprecated `https://www.nerdwallet.com/best/credit-cards/...` form, _don't_ rewrite it manually — NerdWallet's CDN emits a `301` to the new canonical (`/credit-cards/best/{slug}`); a real browser page follows the redirect automatically, so just `goto` the URL and read the final URL (a raw fetch client would need redirect-following enabled).
   - **Category intent** — map to the canonical slug under `/credit-cards/best/{slug}`:

     | Intent                                                                                     | Slug                                                                                                                                                                                      |
     | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
     | best travel cards                                                                          | `travel`                                                                                                                                                                                  |
     | cash back cards                                                                            | `cash-back`                                                                                                                                                                               |
     | 0% intro APR / low-interest cards                                                          | `low-interest`                                                                                                                                                                            |
     | balance-transfer cards                                                                     | `balance-transfer`                                                                                                                                                                        |
     | student / college cards                                                                    | `college-student`                                                                                                                                                                         |
     | business cards                                                                             | (use `/credit-cards/small-business/...` — different tree)                                                                                                                                 |
     | secured cards                                                                              | `secured`                                                                                                                                                                                 |
     | no-annual-fee cards                                                                        | `no-annual-fee`                                                                                                                                                                           |
     | no foreign-transaction-fee cards                                                           | `no-foreign-transaction-fee`                                                                                                                                                              |
     | rewards cards                                                                              | `rewards`                                                                                                                                                                                 |
     | premium / luxury cards                                                                     | `premium`                                                                                                                                                                                 |
     | bonus-offer / welcome-bonus cards                                                          | `bonus-offers`                                                                                                                                                                            |
     | airline (generic)                                                                          | `united-airlines-cards` / `delta-airlines-cards` / `american-airlines-cards` / `southwest-airlines-cards` / `alaska-airlines-cards` (issuer-cobrand-specific — pick by issuer)            |
     | hotel (generic)                                                                            | `hotel` (or `marriott-bonvoy-cards` / `hilton-hotels` for chain-specific)                                                                                                                 |
     | excellent credit                                                                           | `excellent-credit`                                                                                                                                                                        |
     | good credit                                                                                | `good-credit`                                                                                                                                                                             |
     | fair credit                                                                                | `fair-credit`                                                                                                                                                                             |
     | bad / limited credit                                                                       | `bad-credit` / `no-credit`                                                                                                                                                                |
     | groceries / dining / gas / streaming                                                       | `groceries` / `restaurants` / `gas` / `streaming-services`                                                                                                                                |
     | lounge access / TSA PreCheck                                                               | `airport-lounge-access` / `tsa-precheck-global-entry`                                                                                                                                     |
     | Chase / Amex / Capital One / Citi / Discover / BofA / Wells Fargo / US Bank / Navy Federal | `chase-cards` / `american-express-cards` / `capital-one-cards` / `citi-cards` / `discover-cards` / `bank-of-america-cards` / `wells-fargo-cards` / `us-bank-cards` / `navy-federal-cards` |
     | Visa / Mastercard                                                                          | `visa-cards` / `mastercard-cards`                                                                                                                                                         |

     The full enumeration of valid slugs is published in NerdWallet's WordPress sitemap at `https://www.nerdwallet.com/sitemaps/us/wp-sitemap-posts-credit-cards-pages-1.xml` (~80 category slugs as of 2026-05-18). If the intent doesn't obviously map, fetch the sitemap with a `browserless_function` (`page.goto('https://www.nerdwallet.com/')` then a same-origin `fetch` of the sitemap path — XML, ~13 KB, trivially small), grep `<loc>...best/...</loc>` for the closest slug, and use it.

   - **Specific card name** — convert to the review-page slug `https://www.nerdwallet.com/credit-cards/reviews/{slug}` where `{slug}` is the canonical NerdWallet review slug (kebab-case, e.g. `chase-sapphire-preferred`, `citi-double-cash`, `american-express-platinum`, `discover-it-cash-back`). The full set is enumerated in the same credit-cards sitemap above (~180 review slugs as of 2026-05-18). If the name is ambiguous (e.g. "Chase Freedom" matches `chase-freedom`, `chase-freedom-unlimited`, `chase-freedom-flex`), return all matches and let the caller disambiguate.
   - **Free-form criteria** — pick the closest canonical category slug from the table above, then post-filter the parsed result list client-side by the explicit criteria. (NerdWallet's UI exposes filter chips but they're query-param-driven only on a handful of pages — see Site-Specific Gotchas.)

2. **Render the page with `browserless_agent` over a residential proxy.** A residential proxy (`proxy: { proxy: "residential" }`, top-level, repeated on **every** call) is generally sufficient — Cloudflare on NerdWallet is light. Escalate to a challenge solve (`{ "method": "solve", "params": { "type": "cloudflare" } }`) only after a confirmed 403 on the canonical URL. Keep the goto → wait → extract flow inside one call's `commands` array (batching avoids dropping the session config mid-flow; the session itself persists across calls, keyed by `proxy`/`profile`):

   ```json
   { "method": "goto", "params": { "url": "https://www.nerdwallet.com/credit-cards/best/{slug}", "waitUntil": "load", "timeout": 45000 } },
   { "method": "waitForTimeout", "params": { "time": 2500 } }
   ```

   (The `waitForTimeout` covers card-grid hydration after `load`.)

3. **Parse the card grid.** Fold the extraction into a `{ "method": "evaluate", ... }` that returns the projected card JSON (this keeps you under the text-return cap on these large pages), or read `{ "method": "html", "params": { "selector": "body" } }` for a raw dump; use `{ "method": "snapshot" }` if you need ref-driven interaction (e.g. expanding a "Show details" accordion). Per-card extraction targets, in priority order:

   - **Card name** — `h2`/`h3` inside each card row; also `data-testid="product-card-title"` on most templates.
   - **Issuer** — derived from the card name (e.g. "Chase ...", "American Express ...", "Capital One ...") or from the review-page slug prefix.
   - **Network** — surfaces in the card-detail rates table near the bottom of each card row ("Network: Visa" / "Mastercard" / "American Express" / "Discover"). On a few cobrand pages it's absent — fall back to inferring from the issuer + card art.
   - **NerdWallet star rating** — the decimal next to "★" or `aria-label="Rated X out of 5 stars"` near the card title. Always parse the `aria-label` rather than the visible text — visible text is rendered as a sprite at certain breakpoints.
   - **Editorial blurb / "Why we like it"** — first paragraph under the rating, usually 1–2 sentences. There is also a longer "Why we don't" / cons-rationale paragraph further down. Capture both.
   - **"Best for…" tag** — short pill above the card title (e.g. "Best for travel rewards", "Best for cash back"). Optional — only present on category pages, not review pages.
   - **Card art URL** — `<img src="...">` on the card image. NerdWallet hosts on `www.nerdwallet.com/cdn/...` and `www.nerdwallet.com/tachyon/...`. Capture full absolute URL.
   - **Annual fee, Intro APR (purchases / balance transfers), Regular APR, Welcome bonus, Rewards rate, Foreign transaction fee, Balance transfer fee, Late payment fee** — all live in the card's "Rates & Fees" / "Quick Facts" table. Field labels are stable across the site; values are free-form (string with `$`, `%`, `intro` qualifier, etc.). Don't try to coerce to numeric in the parser — return both `raw` (verbatim NerdWallet text) and a `parsed` numeric where unambiguous.
   - **Rewards structure** — bullet list inside the card row ("5x on travel through Chase, 3x on dining, 2x on all other travel, 1x on everything else"). Decompose into `[{ category, rate, cap }]`. Rate is multiplier-style (`5x`, `3%`) or flat percentage. Cap is usually `null`; some cards list `up to $1,500 in combined purchases each quarter`. Keep the raw bullet alongside the decomposed structure.
   - **Welcome bonus** — typically "Earn {N} points/{$X cash back} after you spend {$Y} on purchases in the first {Z} months" + an "estimated dollar value" annotation from NerdWallet. Capture as `{ amount, currency: 'points'|'miles'|'usd', spend_required, spend_window_months, estimated_value_usd }`.
   - **Credit score required** — surfaces as a "Recommended Credit Score" pill or table row. Values are NerdWallet's tier strings: `Excellent (720-850)`, `Good (690-719)`, `Fair (630-689)`, `Bad (300-629)`, `Limited / No credit`.
   - **Key benefits / perks** — bullet list further down each card ("Cell phone protection", "Primary rental car coverage", "Priority Pass Select lounge access", "No foreign transaction fees", "Trip cancellation insurance"). Always parse the bullet list — there's no fixed enum.
   - **Pros / Cons** — explicit `Pros:` / `Cons:` bullet blocks inside the card row. Capture verbatim — NerdWallet's editorial voice is part of the value.
   - **"Apply Now" affiliate URL** — `<a class="...apply-now..." href="...">Apply Now</a>`. The href is typically a `nerdwallet.com/redirect/...` or `nerdwallet.com/cct/...` short-link that 302-redirects through partner tracking before landing on the issuer's application page. **Capture the href, but DO NOT follow it.** Tag it as `is_affiliate: true` in the output.
   - **Canonical NerdWallet review URL** — the "Read full review" link or the card-name-as-anchor inside the card. Typically `https://www.nerdwallet.com/credit-cards/reviews/{slug}`. This is the URL to follow if the caller asks for deeper detail on one card.
   - **Last-reviewed / "Card details last updated" timestamps** — small grey-text line at the bottom of each card or in the page footer ("Last updated May 6, 2026", "Reviewed by …"). Capture as ISO-8601 if parseable.

4. **For "specific card name" inputs (review-page mode)**, the same fields apply but laid out across a single page rather than a grid. The "Pros" / "Cons" sections are longer, the rewards structure is broken into a dedicated card-specific table, and there's a "Compare to similar cards" section near the bottom with thumbnails of 2–3 related cards — capture their names + slugs as `related_cards` if useful for the caller.

5. **Honor sort + limit at parse time.** NerdWallet's category-page query-param filter surface is **inconsistent across slugs**: a handful of pages accept `?sort=annual_fee_asc` / `?sort=intro_apr_length` / `?sort=rewards_rate` / `?sort=welcome_bonus_value`, but most ignore unknown params and render the editorial default ranking. Don't trust the URL to filter for you — fetch the full grid and sort/filter client-side. NerdWallet typically renders 10–20 cards per category page; if the caller asks for a specific count, truncate after parsing.

6. **Emit JSON.** There's no session-release step to manage. The session isn't torn down on return — it persists keyed by the call's `proxy`/`profile` — but keeping the whole goto → wait → extract flow (and any filter clicks) inside one call's `commands` array avoids accidentally dropping that config mid-flow.

### Lightweight-fetch fallback for the small discovery surface

The category-finder discovery surface — the `/credit-cards` root, `/sitemaps/us/wp-sitemap-posts-credit-cards-pages-1.xml`, and `/robots.txt` — are all small and fetch cleanly via a `browserless_function` (`page.goto('https://www.nerdwallet.com/')` then a same-origin `fetch` of the path, returning the text/XML). Use this cheaper path for slug discovery and category enumeration (no full page render needed). The card grids themselves are large (>1 MB) — render them with `browserless_agent` and project the cards in-page so you stay under the ~200k-char text-return cap; don't try to ship the whole document back.

## Site-Specific Gotchas

- **READ-ONLY.** Never click `Apply Now`, `Apply`, `Get Started`, `Sign In`, or any form-submit on the page. NerdWallet's affiliate clickout is logged on click and starts a tracked redirect chain through partner ad networks before landing on the issuer's application page; clicking taints the user-state and is a category-prohibited action under the marketplace's read-only rule. Capture the `href` and flag it `is_affiliate: true` in the output — the caller decides whether to surface it.
- **URL canonicalization & 301s.** The marketing-friendly URL `https://www.nerdwallet.com/best/credit-cards/{slug}` 301-redirects to `https://www.nerdwallet.com/credit-cards/best/{slug}` at Cloudflare (`Server: cloudflare`, `Location: /credit-cards/best/...`). The new path is canonical; the legacy form still works only if you let redirects flow. A `browserless_agent` `goto` follows the redirect for you; a raw fetch client with redirect-following disabled would get the bare 301 page and have a confusing time. Always follow redirects.
- **Trailing-slash and `.html`-suffix variants trigger Cloudflare 403.** Verified 2026-05-18: `/credit-cards/best/travel/` (trailing slash) and `/credit-cards/best/travel.html` both return `403 Forbidden` with a freshly-issued `__cf_bm` cookie (CF bot challenge). The bare canonical `/credit-cards/best/travel` returns `200`. **Stick to the no-trailing-slash, no-suffix canonical form.** Don't programmatically append `/` or `.html`.
- **Category and review pages are large (>1 MB, occasionally 2 MB+).** Browserless has no small per-fetch size cap here — the constraint that bites is the ~200k-char text-return cap on tool results, not a fetch ceiling. So render these pages with `browserless_agent` and project/extract only the card JSON in-page (an `evaluate`) rather than returning the whole document; a raw `html` dump of a 1–2 MB page would exceed the return cap. The small pages (sitemap, robots.txt, the `/credit-cards` root ~850 KB) are fine to pull whole via a `browserless_function` fetch.
- **JSON-LD on category pages is page-level, not card-level.** Only two `<script type="application/ld+json">` blocks on `/credit-cards`: a `VideoObject` (the embedded explainer video) and the site-wide `Organization` block. There is **no** `FinancialProduct`, `CreditCard`, or `Product` schema embedded — verified 2026-05-18. **Do not try to read card data from JSON-LD.** Parse the rendered card grid.
- **No public JSON or GraphQL API.** Robots.txt explicitly disallows `/CreditCardDetailAJAX`, `/compareajax`, `/structured-content-renderer`, `/api/`, `/cc-prequal-service/`, `/janitor/`, `/identity/`, and `/redirect/` — these endpoints exist internally but are locked. Direct probes (2026-05-18): `/wp-json/wp/v2/pages?slug=...` → 404, `/api/credit-cards` → 404, `/compareajax?ids=...` → 404, `/structured-content-renderer?path=...` → 405 (POST-only and likely auth-gated). **Don't waste cycles on API-discovery — there isn't a usable one.**
- **Card-finder quiz at `/card-finder-jump` is a separate surface.** It's a multi-step questionnaire (credit-score → spend categories → annual-fee tolerance → reward preference) that produces a _personalized_ recommendation page rather than the editorial category page. It overlaps the filter surface in the task spec but is **not** the comparison surface — different data shape (one ranked recommendation + 2–3 alternates rather than a sorted grid of 10–20). If the caller's input includes both a category intent _and_ personalization signals ("rebuild credit, low income, no annual fee, monthly rent payments to build score"), the quiz path is more accurate; but it's interaction-heavy and not described here. Default to the category-page path.
- **Cloudflare cookies (`__cf_bm`, `_cfuvid`, `nws4`) issued on first request.** A bare-cookie second request to the same domain in the same session is fine — CF sees the cookies and waves you through. If you rotate sessions per-card, expect a fresh challenge each time; pooling card fetches in a single session is significantly faster.
- **Each `browserless_agent` call is self-contained.** There's no connect-URL / WebSocket-endpoint plumbing to manage and no per-region host allowlist to worry about — the MCP tool owns the browser. The session is **not** torn down on return; it persists keyed by the call's `proxy`/`profile`, so a later call carrying the same config reconnects to it (Cloudflare cookies `__cf_bm`, `_cfuvid`, `nws4` and hydrated state intact). Dropping or changing that config lands you in a different session, so the reliable pattern is to keep any multi-step flow (goto → wait → optional filter clicks → extract) inside a single call's `commands` array.
- **`?sort=...` query params are inconsistently honored.** A handful of category pages respect `?sort=annual_fee_asc`, `?sort=intro_apr_length`, etc., but most ignore unknown params and render the editorial default. The visible UI sort dropdown drives a client-side rerender via JS state — it does NOT update the URL on most templates. Sort and filter client-side after parsing.
- **`m.nerdwallet.com` mobile-subdomain returns `500`.** Don't try the mobile variant as a "lighter" fetch — the route is broken or removed.
- **AMP variants don't exist for credit-card pages.** `/credit-cards/best/travel/amp` returns 404. Don't waste time looking for an AMP path.
- **Apply Now hrefs are NerdWallet-hosted short-links, not direct issuer URLs.** Format: `https://www.nerdwallet.com/redirect/...?...` or `https://www.nerdwallet.com/cct/...`. They 302 through `partners.nerdwallet.com` to the issuer's actual application URL. **Capture the NerdWallet-hosted href in the output — that's the de-facto canonical "Apply" link for the card; don't try to resolve it to the underlying issuer URL by following the chain (a) it's affiliate-tracked and (b) following the chain triggers ad-network beacons.**
- **"Estimated dollar value" of the welcome bonus is NerdWallet-editorial, not the issuer's.** It's an apples-to-apples valuation computed by NerdWallet (e.g. Chase Ultimate Rewards ≈ 2 cents/point in their model). Surface it but tag it explicitly as `estimated_value_usd_source: 'nerdwallet_editorial'` so the caller knows it's not from the issuer.
- **Sitemap is the canonical slug list.** `https://www.nerdwallet.com/sitemaps/us/wp-sitemap-posts-credit-cards-pages-1.xml` enumerates every `/credit-cards/best/{slug}` and `/credit-cards/reviews/{slug}` URL NerdWallet considers canonical. ~13 KB. Re-fetch periodically (slugs do change — NerdWallet retires deprecated categories and adds new co-branded slugs at the start of each year).
- **NerdWallet's editorial team can hold a card off the live page mid-update.** When you see "Card details last updated: [date]" with a date older than 90 days and the issuer recently changed terms, the card is in an editorial-stale state; surface the timestamp so downstream consumers can see freshness.
- **Card art images live at `www.nerdwallet.com/cdn/...` and `www.nerdwallet.com/tachyon/...`** — both are CDN paths. They serve raster + WebP via `srcset`; pick the first 1x raster `src` for the primary URL.

## Expected Output

Two output shapes — list (category-page input) and single (review-page input):

```json
// Category / list mode — input was a category intent, full /credit-cards/best/{slug} URL, or free-form criteria
{
  "mode": "list",
  "source_url": "https://www.nerdwallet.com/credit-cards/best/travel",
  "category_slug": "travel",
  "category_label": "Best Travel Credit Cards",
  "last_reviewed_page_level": "2026-05-06",
  "applied_filters": {
    "annual_fee_max": null,
    "credit_score_required": null,
    "issuer": null,
    "network": null,
    "rewards_type": null,
    "foreign_transaction_fee_none": false,
    "intro_apr_min_months": null
  },
  "sort": "editorial_default",
  "count": 12,
  "cards": [
    {
      "name": "Chase Sapphire Preferred® Card",
      "issuer": "Chase",
      "network": "Visa",
      "review_url": "https://www.nerdwallet.com/credit-cards/reviews/chase-sapphire-preferred",
      "card_art_url": "https://www.nerdwallet.com/cdn/.../chase-sapphire-preferred.png",
      "nerdwallet_rating": 5.0,
      "rating_label": "Rated 5 out of 5 stars",
      "best_for_tag": "Best for travel rewards",
      "why_we_like_it": "If you want a great mix of …",
      "why_we_dont": "If you'd rather pay zero …",
      "annual_fee": { "raw": "$95", "amount_usd": 95 },
      "intro_apr": {
        "purchases":         { "raw": "None", "rate_percent": null, "duration_months": null },
        "balance_transfers": { "raw": "None", "rate_percent": null, "duration_months": null }
      },
      "regular_apr": { "raw": "20.49% – 27.49% Variable", "min_percent": 20.49, "max_percent": 27.49 },
      "welcome_bonus": {
        "raw": "Earn 60,000 bonus points after you spend $4,000 on purchases in the first 3 months from account opening",
        "amount": 60000,
        "currency": "points",
        "spend_required_usd": 4000,
        "spend_window_months": 3,
        "estimated_value_usd": 750,
        "estimated_value_usd_source": "nerdwallet_editorial"
      },
      "rewards": [
        { "category": "Travel purchased through Chase Travel", "rate": "5x",  "cap": null, "raw": "5x on travel purchased through Chase Travel" },
        { "category": "Dining",                                "rate": "3x",  "cap": null, "raw": "3x on dining" },
        { "category": "Online grocery",                        "rate": "3x",  "cap": null, "raw": "3x on online grocery (excluding Target/Walmart/wholesale)" },
        { "category": "Streaming",                             "rate": "3x",  "cap": null, "raw": "3x on select streaming services" },
        { "category": "Other travel",                          "rate": "2x",  "cap": null, "raw": "2x on all other travel" },
        { "category": "Everything else",                       "rate": "1x",  "cap": null, "raw": "1x on everything else" }
      ],
      "foreign_transaction_fee": { "raw": "None", "percent": 0 },
      "balance_transfer_fee":    { "raw": "Either $5 or 5% of the amount of each transfer, whichever is greater" },
      "late_payment_fee":        { "raw": "Up to $40" },
      "credit_score_required":   { "raw": "Excellent, Good", "tier_min": "Good (690-719)" },
      "key_benefits": [
        "Trip cancellation/interruption insurance",
        "Primary rental car coverage (within US)",
        "$50 annual Chase Travel hotel credit",
        "10% anniversary points boost",
        "No foreign transaction fees"
      ],
      "pros": [
        "Bonus categories include both popular and niche spending",
        "Generous and flexible travel rewards",
        "Reasonable annual fee"
      ],
      "cons": [
        "Has annual fee",
        "Requires good/excellent credit"
      ],
      "apply_url":   "https://www.nerdwallet.com/redirect/...",
      "is_affiliate": true,
      "card_last_updated": "2026-04-22"
    }
    // ...more cards
  ]
}

// Single card / review mode — input was a specific card name or a /credit-cards/reviews/{slug} URL
{
  "mode": "single",
  "source_url": "https://www.nerdwallet.com/credit-cards/reviews/chase-sapphire-preferred",
  "card": { /* same shape as one entry in `cards[]` above, plus: */
    "related_cards": [
      { "name": "Chase Sapphire Reserve®",     "review_url": "https://www.nerdwallet.com/credit-cards/reviews/chase-sapphire-reserve" },
      { "name": "Capital One Venture Rewards", "review_url": "https://www.nerdwallet.com/credit-cards/reviews/capital-one-venture" }
    ]
  }
}

// Disambiguation mode — name input matched multiple review-page slugs
{
  "mode": "ambiguous",
  "query": "chase freedom",
  "matches": [
    { "name": "Chase Freedom Unlimited®",   "review_url": "https://www.nerdwallet.com/credit-cards/reviews/chase-freedom-unlimited" },
    { "name": "Chase Freedom Flex℠",        "review_url": "https://www.nerdwallet.com/credit-cards/reviews/chase-freedom-flex" },
    { "name": "Chase Freedom (legacy)",     "review_url": "https://www.nerdwallet.com/credit-cards/reviews/chase-freedom" }
  ]
}

// Not-found mode — input didn't resolve to any category or review slug
{
  "mode": "not_found",
  "query": "foo",
  "reason": "no_matching_slug",
  "hint": "Try a NerdWallet category slug from /sitemaps/us/wp-sitemap-posts-credit-cards-pages-1.xml or a card name from /credit-cards/reviews/*"
}
```

Numeric fields are nullable — when NerdWallet's text says "None" or doesn't quote a specific value, leave the parsed numeric `null` and keep the verbatim string in `raw`. Always include `raw` alongside any `parsed` numeric so the caller can audit the extraction.
