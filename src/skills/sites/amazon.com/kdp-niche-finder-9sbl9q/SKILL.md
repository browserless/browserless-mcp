---
name: kdp-niche-finder
title: KDP Nonfiction Niche Finder
description: >-
  Validate a nonfiction book niche on Amazon against the four KDP niche-finder
  rules (BSR < 100k, 50-300 reviews, price floor $9.99+, and a 3-star review
  gap) by gathering market data from book search and product pages. Read-only.
website: amazon.com
category: publishing
tags:
  - kdp
  - books
  - market-research
  - amazon
  - read-only
  - self-publishing
source: 'browserbase: agent-runtime 2026-06-19'
updated: '2026-06-19'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      No usable public API for this. The Product Advertising API (PA-API 5.0)
      requires an approved Associates account with qualifying sales, is heavily
      throttled, and does NOT return Best Sellers Rank or review text — the two
      signals this skill depends on. Confirmed not viable for niche research.
  - method: fetch
    rationale: >-
      Cookieless HTTP fetch of a cold search/product URL returns Amazon's
      'Sorry! Something went wrong!' bot page. A cookie-warmed stealth browser
      session is required to render search results and product details reliably.
verified: true
proxies: true
---

# KDP Nonfiction Niche Finder

## Purpose

Validate a candidate nonfiction book niche on Amazon before an author invests time writing for it. Given a niche query (e.g. "anxiety workbook for teens"), the skill gathers real market data from Amazon's book search and product detail pages — Best Sellers Rank (BSR), review counts, star distribution, and price — and applies a four-rule validation filter to produce a `validate` / `reject` verdict plus the evidence behind it. **Read-only — it never adds to cart, never signs in to purchase, and never publishes anything.**

The four rules:

1. **100k BSR rule** — demand: multiple top books rank under BSR 100,000 in Books.
2. **Review Gap rule** — competition: top books sit at roughly **50–300** reviews (not 0 = no demand, not 1,000s = entrenched "Red Ocean").
3. **Price Floor rule** — profitability: average paperback price ≥ **$9.99**.
4. **3-Star Review rule** — USP discovery: mid-range (3-star) reviews exist and reveal recurring reader frustrations or missing content.

## When to Use

- An author or content agent is choosing what nonfiction book to write next and needs objective market validation before committing.
- Comparing several candidate niches head-to-head on demand, competition, and price.
- Iteratively narrowing a broad topic ("journaling") into a specific, testable niche ("anxiety journal for teen girls") and re-running the filter at each refinement.
- Any workflow that needs Amazon BSR + review + price signals for books without an Associates/PA-API account.

## Workflow

There is **no usable API path** for this task (see Site-Specific Gotchas — PA-API returns neither BSR nor review text). The recommended method is a cookie-warmed stealth browser session. Lead with it.

Run the whole flow — homepage warm-up → search → per-book detail pages — inside **one `browserless_agent` call's `commands` array** so the warm-up cookies carry across the later navigations without you re-passing the session config. The session **persists across calls, keyed by the `proxy` config** (there's no release step); batching into one call is a convenience that saves round-trips and avoids accidentally dropping that config, not a lifetime requirement.

### 1. Route the call through a residential proxy

Pass a top-level `proxy` arg on the `browserless_agent` call:

```jsonc
{ "proxy": { "proxy": "residential" }, "commands": [/* steps 2-6 */] }
```

Residential routing plus the default stealth is what the converged run relied on. A plain proxy-less call is more likely to draw the bot page on search/product URLs.

### 2. Warm the homepage FIRST (mandatory)

First two `commands`:

```jsonc
{
  "method": "goto",
  "params": {
    "url": "https://www.amazon.com/",
    "waitUntil": "load",
    "timeout": 45000,
  },
}
```

Skipping this and hitting a search/product URL cold returns Amazon's **"Sorry! Something went wrong!"** bot page (HTTP 200 with error HTML, not a 4xx). One homepage load sets the cookies that let subsequent search/detail navigations render. Verified: cold search → bot page; same URL after a homepage warm → results.

### 3. Refine the niche query, then search the Books department

Iteratively apply modifiers (audience, format, sub-topic) until the query is specific. Then search **scoped to Books** with `i=stripbooks`:

```jsonc
{ "method": "goto", "params": { "url": "https://www.amazon.com/s?k=<url-encoded+query>&i=stripbooks", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 2000 } }   // cards hydrate ~1-2s after load
```

### 4. Extract the top results (title, ASIN, rating, reviews, price)

A full `text`/`html` dump of the search page is huge (~370 KB) and noisy. Use a targeted `evaluate` command against the search-result cards instead — it returns clean structured data in one step (the result comes back under `.value`):

```jsonc
{ "method": "evaluate", "params": { "content": "(() => {
  return [...document.querySelectorAll('div[data-asin][data-component-type=\"s-search-result\"]')]
    .slice(0,10).map(el => ({
      asin: el.getAttribute('data-asin'),
      title: el.querySelector('h2 span')?.innerText || el.querySelector('h2')?.innerText,
      rating: el.querySelector('[aria-label*=\"out of 5 stars\"]')?.getAttribute('aria-label'),
      reviews: el.querySelector('a[href*=\"customerReviews\"] span, .s-underline-text')?.innerText,
      price: el.querySelector('.a-price .a-offscreen')?.innerText
    }));
})()" } }
```

Parse `reviews` carefully: Amazon abbreviates ("(75)", "(1.8K)", "(9K)"). Expand `K`/`M` to integers before applying the Review Gap rule. The search-result `price` is the cleanest price source — prefer it over the detail page (see gotcha).

### 5. Open promising books' detail pages and read BSR + histogram

BSR is **only on the product detail page**, not in search results. For each candidate ASIN, append `goto` + `evaluate` commands (still in the same call, so the warm-up cookies carry over):

```jsonc
{ "method": "goto", "params": { "url": "https://www.amazon.com/dp/<ASIN>", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 2000 } },
{ "method": "evaluate", "params": { "content": "(() => {
  const out = {};
  const m = document.body.innerText.match(/Best Sellers Rank[\s\S]{0,300}/i);
  out.bsrRaw = m ? m[0].replace(/\n+/g,' | ') : null;        // '#105,785 in Books | #60 in ...'
  out.reviewCount = document.querySelector('#acrCustomerReviewText')?.innerText;
  out.rating = document.querySelector('#acrPopover')?.getAttribute('title');
  out.histogram = [...document.querySelectorAll('a[href*=\"filterByStar\"]')]
    .map(a => a.innerText.replace(/\n/g,' ').trim()).filter(Boolean);  // ['5 star 70%','4 star 19%','3 star 7%',...]
  return out;
})()" } }
```

Pull the integer out of `bsrRaw` — the first `#NNN,NNN in Books` is the overall BSR used for the 100k rule. The lower category sub-ranks (`#60 in Teen & Young Adult Nonfiction…`) are useful color but are NOT the 100k threshold.

### 6. Apply the 3-Star Review rule

The **histogram percentages from step 5 are visible without login** — use them to confirm a meaningful 3-star band exists (e.g. 3★ = 7% of 75 reviews ≈ 5 reviews). To read the actual _text_ of 3-star reviews (where the USP/gap lives), note the gating gotcha below — the filtered `/product-reviews/?filterByStar=three_star` page redirects to a sign-in wall. Use the few mixed-rating reviews shown on the detail page, or a logged-in session, to mine frustrations.

### 7. Score the four rules and emit the verdict

- `bsr_under_100k`: ≥ 2 top books with overall BSR < 100,000.
- `review_gap_50_300`: top books cluster in 50–300 reviews.
- `price_floor_9_99`: average paperback price ≥ $9.99.
- `three_star_signal`: a non-trivial 3-star band with extractable complaints.

A niche `validate`s when all four pass (or pass with documented judgment). Otherwise `reject` with the failing rule(s). **Watch the red flags:** dominant brand/celebrity authors, big-publisher imprints, prices clustered below $9.99, or review counts in the thousands all indicate Red Ocean — reject regardless of BSR.

### 8. No release step

There's no session-release call, and nothing to release — the session **persists across calls, keyed by the `proxy` config**; it does not tear down when a call returns. Keeping the full warm-up → search → detail flow inside that single call's `commands` array is a convenience: it avoids re-passing the config and keeps the cookies live without extra round-trips. A later call that repeats the same `proxy` reconnects to the same warmed session; one that drops or changes it lands in a different, cold session.

## Site-Specific Gotchas

- **READ-ONLY.** Never add to cart, never start checkout, never sign in to buy. This skill only reads market data.
- **Warm the homepage before any search/product URL.** A cold search/product navigation returns Amazon's "Sorry! Something went wrong!" page — it's HTTP 200 with bot-error HTML, so check the page _title_/_body_ ("Sorry! Something went wrong!"), not just the status code. One `goto https://www.amazon.com/` (waitUntil `load`) at the start of the call fixes it for the rest of the commands.
- **BSR lives only on the product detail page.** Search result cards never show Best Sellers Rank. You must open `/dp/<ASIN>` for each candidate. The overall `#NNN in Books` is the 100k-rule number; category sub-ranks are separate and much smaller.
- **Use the search-result card price, not the detail page price.** A product detail page contains 50+ `.a-price .a-offscreen` nodes (carousels, "frequently bought together", sponsored rails, other formats), so a naive selector returns the wrong number. The search card's `.a-price .a-offscreen` is the clean buy-box paperback price. If you must read price on the detail page, target `#corePrice_feature_div` or the format-specific swatch, not a document-wide query.
- **Filtered review pages are behind a sign-in wall.** `https://www.amazon.com/product-reviews/<ASIN>/?filterByStar=three_star&reviewerType=all_reviews` redirects to "Amazon Sign-In" for a cookie-only (not logged-in) session. The 3-Star Review rule therefore can't read full filtered review text from a logged-out session. **What IS available logged-out:** the star-distribution **histogram percentages** (`5 star 70% / 4 star 19% / 3 star 7% / …`) and a handful of "Top reviews from the United States" on the detail page itself. To read 3-star review _text_ specifically, a logged-in session is required — document this as a partial limitation rather than faking it.
- **Review counts are abbreviated.** "(1.8K)", "(9K)", "(2.4K)" — expand K (×1,000) / M (×1,000,000) to integers before applying the 50–300 Review Gap rule, or you'll misjudge a 9,000-review Red Ocean book as a 9-review opportunity.
- **Proxy IP sets the storefront locale.** The session's residential proxy determined a US locale ("Delivering to Boardman 97818"). Prices/availability are US-store. If a specific marketplace matters, pin it via the address/locale or use the right regional domain.
- **Always scope search to Books.** Use `i=stripbooks` in the search URL. Without it, Amazon returns mixed-department results (Kindle, audiobooks, merch) that pollute the BSR/price comparison.
- **A full `text`/`html` dump of the search page is ~370 KB.** It blows past the result-size limit and buries the data. Prefer a targeted `evaluate` over the result cards.
- **No usable API.** The Product Advertising API (PA-API 5.0) needs an approved Associates account with qualifying sales, is rate-limited, and returns neither BSR nor review text — the two signals this skill needs. Don't waste time trying to route this through PA-API; the browser is the only viable surface.

## Expected Output

```json
{
  "success": true,
  "niche": "anxiety workbook for teens",
  "books": [
    {
      "asin": "1684039193",
      "title": "The Anxiety and Depression Workbook for Teens",
      "bsr": 105785,
      "reviews": 75,
      "price": 22.95,
      "rating": 4.5,
      "star_distribution": { "5": 70, "4": 19, "3": 7, "2": 2, "1": 2 }
    },
    {
      "asin": "1641524014",
      "title": "Conquer Anxiety Workbook for Teens",
      "bsr": 18420,
      "reviews": 1800,
      "price": 9.89,
      "rating": 4.6
    }
  ],
  "rules": {
    "bsr_under_100k": true,
    "review_gap_50_300": false,
    "price_floor_9_99": true,
    "three_star_signal": true
  },
  "red_flags": [
    "top-1 competitor has 1.8K reviews (Red Ocean)",
    "lead competitor priced below $9.99"
  ],
  "verdict": "reject",
  "usp_notes": "3-star reviews (≈7% band) commonly complain the exercises feel too clinical / not engaging for younger teens — a friendlier, more activity-driven workbook could differentiate.",
  "error_reasoning": null
}
```

Failure / blocked shapes:

```json
// Bot page (forgot to warm the homepage, or session blocked)
{ "success": false, "error_reasoning": "Amazon returned 'Sorry! Something went wrong!' bot page; warm https://www.amazon.com/ first or rotate the stealth session." }

// 3-star review text gated behind sign-in
{ "success": true, "niche": "...", "books": [ ... ],
  "three_star_signal_note": "histogram shows a 3-star band but filtered review text requires a logged-in session; USP analysis limited to detail-page top reviews." }
```
