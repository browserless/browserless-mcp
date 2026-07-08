---
name: ruwangi-parfum-perempuan
title: Ruwangi Best Local Indonesian Women's Perfume
description: >-
  Return a curated, ranked list of best local Indonesian women's perfumes from
  Ruwangi.com — name, brand, IDR price, rating, notes, and time-of-day
  suitability. Read-only directory lookup using the pre-curated
  /katalog/parfum-lokal-wanita-terbaik deep-link.
website: ruwangi.com
category: shopping
tags:
  - perfume
  - indonesia
  - ruwangi
  - directory
  - women
  - local-brand
  - read-only
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: browser
alternative_methods:
  - method: url-param
    rationale: >-
      Direct deep-link navigation to /katalog/parfum-lokal-wanita-terbaik is
      itself a URL-driven shortcut — no search/filter steps required. Pagination
      is path-based (/page/N). The browser is only needed to render and parse
      the server-side HTML.
  - method: api
    rationale: >-
      No public JSON API was discovered during 2026-05-18 exploration. Page is
      Next.js App Router server-rendered HTML; only XHR traffic is PostHog
      analytics (djz.ruwangi.com). Don't waste time hunting for a /api/
      endpoint.
verified: false
proxies: false
---

# Ruwangi Best Local Indonesian Women's Perfume

## Purpose

Given a request for "best local Indonesian perfume suitable for women" (or any synonym — _parfum lokal wanita terbaik_, _parfum perempuan_, _parfum feminin_), return a curated, ranked list of women's-leaning Indonesian-brand fragrances from [Ruwangi.com](https://ruwangi.com), Indonesia's #1 local-perfume directory. For each item, return name, brand, IDR price, rating + review count, fragrance character (notes family), time-of-day suitability (Siang/Malam/Versatile), gender-lean tag (Feminin), and canonical detail URL. Read-only — never adds to cart, never submits the AI quiz, never registers.

## When to Use

- A shopper asks for "rekomendasi parfum lokal untuk perempuan/wanita" or "best Indonesian women's perfume".
- An agent needs to enrich a recommendation with notes (Top/Middle/Base), scent profile (Manis / Bunga / Hangat / Natural / Citrus / etc.), and brand context for one or more women's-leaning local perfumes.
- Comparative shopping flows that need price + rating across the women's catalog (159 perfumes spread over 8 pages as of 2026-05-18).
- Surfacing brand information (Mykonos, HMNS, Alchemist, Alien Objects, Aerostreet Parfum, Bodibreze, Velixir, BOHE Bali, Dewdrop, Fordive, Iki Arum, Project 1945, Nifty Twice, etc.) for niche/luxury vs. budget tiers.

## Workflow

Ruwangi exposes a **pre-curated, gender-scoped catalog URL** at a stable, sitemap-listed path — there's no need to search, apply filters, or call an API. Direct navigation to the deep-link gets you the curated "best women's" list in one HTTP round-trip. Pagination is path-based (`/page/N`), and the `?page=` query string is silently ignored. There is **no public JSON API**, and sort state is client-side only — so leading with the URL and parsing the rendered page in-page (a `browserless_agent` `goto` + an `evaluate`) is the cheapest, most reliable path. A plain `browserless_agent` call (no stealth, no proxy) works fine — no Akamai, no Cloudflare challenge, no rate-limiting observed.

### 1. No special session setup

Drive the storefront with a plain `browserless_agent` call — no stealth or proxy flags. The site served all requests cleanly with bare defaults during 2026-05-18 verification. Add `proxy: { proxy: "residential" }` only if you observe a 403 (none seen so far).

### 2. Navigate to the curated women's catalog

```json
{ "method": "goto", "params": { "url": "https://ruwangi.com/katalog/parfum-lokal-wanita-terbaik", "waitUntil": "load", "timeout": 45000 } }
{ "method": "waitForTimeout", "params": { "time": 2000 } }   // let lazy-loaded cards settle
```

This page is the canonical "Parfum Lokal Wanita Terbaik" catalog — Ruwangi's editorial curation of women's-leaning local perfumes, ordered by default "Relevansi" (their editorial ranking). The page header confirms `🌸Cenderung Feminin · 159 parfum` and breadcrumb `Katalog / Parfum Lokal Wanita Terbaik`.

### 3. Extract listings in-page

`browserless_agent` doesn't emit markdown, so parse the cards from the DOM with an `evaluate` command. Each card is anchored by a `View` link whose href is the stable per-card key `/parfum/{slug}`; walk up from that anchor to the card container and read the card's text. Return a compact JSON array — do not ship raw HTML back:

```json
{
  "method": "evaluate",
  "params": {
    "content": "(() => { const out=[]; document.querySelectorAll('a[href^=\"/parfum/\"]').forEach(a => { const slug=a.getAttribute('href').split('/parfum/')[1].split('?')[0]; const card=a.closest('article,li,div[class]') || a.parentElement; const text=(card?.innerText||'').replace(/[ \\t]+/g,' ').trim(); out.push({ slug, view_name:(a.innerText||'').replace(/^View\\s+/,'').trim(), text }); }); return JSON.stringify(out); })()"
  }
}
```

(If the `.closest` walk-up misses the card boundary, confirm the container selector via a `snapshot`.) Each card's text carries the documented fields in this stable order (verified on pages 1–2, 20 items each):

```
{TimeOfDay}                  # "Siang" | "Malam" | "Versatile"
🌸Feminin                     # gender-lean emoji + label (also 👔Maskulin, ✨Unisex on cross-listed cards)
{Name}                       # display name
{brand-slug}                 # lowercase brand handle (e.g. "mykonos", "aerostreet-parfum")
{rating}({reviewCount})      # e.g. "4.9(6600)" — count may be raw (e.g. 6600) or display-rounded
Rp{price-with-dot-thousands} # IDR, dot-grouped (e.g. "Rp349.000")
Karakter
{character}                  # fragrance family, e.g. "Oriental", "Fresh Floral", "Warm Floral"
```

Parse each card's `text` with a regex over those lines (the `/parfum/{slug}` href you already captured is the stable per-card key):

```javascript
const cardRe =
  /(Siang|Malam|Versatile)\s*\n\s*(?:👔Maskulin|🌸Feminin|✨Unisex|🚻Unisex)([^\n]*)\n\s*([^\n]+)\n\s*([^\n]+)\n\s*([\d.]+)\(([\d.]+)\)\n\s*(Rp[\d.]+)\n\s*Karakter\n\s*([^\n]+)/;
// Groups: 1 timeOfDay, 3 displayName, 4 brandSlug, 5 rating, 6 reviewCount, 7 priceIdr, 8 character
```

### 4. Paginate

There are 8 pages (`12345...8` shown in the rendered pagination). Pagination uses **path-based URLs** — chain a `goto` + `evaluate` per page inside one `browserless_agent` `commands` array:

```json
{
  "method": "goto",
  "params": {
    "url": "https://ruwangi.com/katalog/parfum-lokal-wanita-terbaik/page/2",
    "waitUntil": "load",
    "timeout": 45000
  }
}
// ...repeat the goto + step-3 evaluate through page/8
```

Do **not** use `?page=2` — the query string is silently ignored and you'll get page 1 again. Page 1 has no `/page/1` suffix; subsequent pages are explicit `/page/{N}`.

### 5. (Optional) Enrich each card with full notes by visiting the detail page

```json
{ "method": "goto", "params": { "url": "https://ruwangi.com/parfum/{slug}", "waitUntil": "load", "timeout": 45000 } }
{ "method": "waitForTimeout", "params": { "time": 1500 } }
{ "method": "evaluate", "params": { "content": "(() => document.querySelector('main')?.innerText || document.body.innerText)()" } }
```

The detail page exposes:

- **Scent Profile** attribute chips (e.g. _Manis · Bunga · Hangat · Natural_)
- **Top Notes** (e.g. "Black Tea, Moss, Osmanthus., Peach")
- **Middle Notes** (e.g. "Rose, Tuberose, Narcissus, Toffee.")
- **Base Notes** (e.g. "Vetiver, Cedarwood, Orris Root, Dark Chocolate.")
- **Karakter** (single-line family label)
- **Description** (Indonesian-language editorial blurb)
- **External buy link** ("Beli Sekarang" → Sociolla / Tokopedia / Shopee / brand store)
- **Brand summary** (variant count, brand-aggregate rating)

Skip this step if the user only wants a top-N list — the card data from step 3 is sufficient.

### 6. Rank / filter client-side

The default `Relevansi` (relevance) order is Ruwangi's editorial pick of "best". For an explicit "highest-rated" sort, **the URL cannot encode it** — `?sort=rating` is ignored. You have two options:

- **(Preferred — single round-trip)** Collect all 8 pages of cards, then sort client-side by `rating` descending (tie-break by `reviewCount` descending). This avoids the DOM-click-and-rerender dance and is deterministic.
- **(UI fallback)** Click the _Relevansi_ dropdown → _Rating Tertinggi_, then re-scrape page 1. State is in-memory only; reloading the URL resets it to _Relevansi_.

For "best for women" specifically, prefer the cards that show `🌸Feminin` (some cross-listed `✨Unisex` / `👔Maskulin` items appear in cross-recommendation rails on the same page; filter on the gender tag when emitting).

### 7. Emit the ranked list

See `## Expected Output` for the JSON schema.

## Site-Specific Gotchas

- **`?page=N` is silently ignored — use path-based `/page/N`.** The pagination buttons are `<button>` elements with no `href`; they navigate via client-side router to `/katalog/{slug}/page/{N}`. A direct `goto` to the path-based URL works; the query-string variant returns page 1 every time, with no warning.
- **Sort state is client-only.** The "Relevansi" dropdown surfaces four options (_Relevansi_, _Harga: Rendah ke Tinggi_, _Harga: Tinggi ke Rendah_, _Rating Tertinggi_) but selecting any of them does not update the URL. `?sort=rating`, `?orderBy=rating`, etc. all fall through to the default _Relevansi_. To deliver a rating-sorted result deterministically across reloads, fetch all pages and sort client-side.
- **Mixed-gender cross-recommendation rails on the women's catalog page.** Below the curated grid, the page renders editorial rails ("Pilihan Editor", "Kurasi Spesial Untukmu", "Rekomendasi Parfum Lokal") that include some `👔Maskulin` and `✨Unisex` items (e.g. Fields of Ubud, Untitled Humans Aroma 02). Filter on the per-card gender tag when the user explicitly asked for women's — the count `159 parfum` shown in the breadcrumb refers to the curated grid only, not the cross-rails.
- **20 cards per page; total `159` over 8 pages.** Last page (`/page/8`) has 19 cards, not 20.
- **Brand-name casing differs by surface.** Card rails on the homepage render brand as a lowercase slug ("mykonos", "aerostreet-parfum", "jayrosse"); the catalog page renders Title Case ("Mykonos", "Aerostreet Parfum"); the detail page shows display name. Normalize to the slug form (`/merek-parfum/{brandSlug}`) for stable identity.
- **Review-count formatting is display-rounded.** `4.9(6600)` may represent any value 6550–6649 — the underlying API rounds to the nearest 100 for counts > 1k. Treat as approximate, not exact. For exact counts, see the detail page header (e.g. "6600 Penilaian" — same rounding).
- **No public JSON API observed.** The catalog is server-rendered HTML (Next.js App Router, RSC payloads inline as `self.__next_f.push(...)`; no `__NEXT_DATA__` blob). The only XHR traffic on a category-page load is PostHog analytics POSTs to `djz.ruwangi.com/s/` and `/i/v0/e/` (return `{"status":"Ok"}`, irrelevant to data extraction).
- **External "Beli Sekarang" links go off-site.** The buy button on `/parfum/{slug}` redirects to Sociolla, Tokopedia, Shopee, or the brand's own store — Ruwangi is a directory, not a marketplace. Treat the link as informational; do not attempt a checkout flow.
- **No anti-bot wall observed** as of 2026-05-18. A plain `browserless_agent` call (no stealth, no proxy) cleared the homepage, catalog, paginated catalog (`/page/2`), product detail, and sitemap.xml without challenge. Cloudflare Turnstile script (`cf-turnstile-script`) is included in the page but not invoked on these read paths. Add `proxy: { proxy: "residential" }` only if a future 403 surfaces.
- **Pre-built taxonomy catalogs are the agent-friendly entry surface.** The sitemap lists 18 catalog deep-links — `parfum-lokal-pria-terbaik`, `parfum-lokal-wanita-terbaik`, `parfum-lokal-unisex-terbaik`, `parfum-lokal-segar`, `parfum-lokal-manis`, `parfum-lokal-bunga`, `parfum-lokal-rempah`, `parfum-lokal-hangat`, `parfum-lokal-herbal`, `parfum-lokal-natural`, `parfum-lokal-clean`, `parfum-siang`, `parfum-malam`, `parfum-versatile`, `parfum-lokal-mewah`, `parfum-lokal-murah`, `parfum-aroma-kopi`, `parfum-aroma-teh`. For "perfume for {user-trait}" intents, prefer the matching deep-link over any client-side filter.
- **The `/survey` AI quiz is a 5+ question form, not a query API.** It exists at `https://ruwangi.com/survey` and produces personalized recommendations after the user answers preferences, but it is not callable as a one-shot endpoint. For "best for women" specifically, the curated `/katalog/parfum-lokal-wanita-terbaik` page is the right surface — don't route through `/survey`.
- **Detail-page notes can carry trailing periods.** Top/Middle/Base notes strings often end with a stray "." (e.g. `"Osmanthus., Peach"`, `"Tuberose, Narcissus, Toffee."`). Strip trailing periods when tokenizing into a notes array.

## Expected Output

```json
{
  "source_url": "https://ruwangi.com/katalog/parfum-lokal-wanita-terbaik",
  "category": "parfum-lokal-wanita-terbaik",
  "category_label": "Parfum Lokal Wanita Terbaik",
  "gender_lean": "feminin",
  "sort_applied": "Relevansi (editorial)",
  "total_in_catalog": 159,
  "pages_fetched": 8,
  "results": [
    {
      "rank": 1,
      "name": "Sansa",
      "slug": "sansa",
      "url": "https://ruwangi.com/parfum/sansa",
      "brand": "Mykonos",
      "brand_slug": "mykonos",
      "brand_url": "https://ruwangi.com/merek-parfum/mykonos",
      "price_idr": 349000,
      "price_display": "Rp349.000",
      "rating": 4.9,
      "review_count_approx": 6600,
      "time_of_day": "Malam",
      "gender_tag": "Feminin",
      "character": "Oriental",
      "image_url": "https://cdn.ruwangi.com/.../products/mykonos/sansa/...Sansa.webp",
      "notes": {
        "top": ["Black Tea", "Moss", "Osmanthus", "Peach"],
        "middle": ["Rose", "Tuberose", "Narcissus", "Toffee"],
        "base": ["Vetiver", "Cedarwood", "Orris Root", "Dark Chocolate"]
      },
      "scent_profile": ["Manis", "Bunga", "Hangat", "Natural"]
    },
    {
      "rank": 2,
      "name": "Flower Springtime Rose",
      "slug": "flower-springtime-rose",
      "url": "https://ruwangi.com/parfum/flower-springtime-rose",
      "brand": "Aerostreet Parfum",
      "brand_slug": "aerostreet-parfum",
      "price_idr": 72900,
      "price_display": "Rp72.900",
      "rating": 4.9,
      "review_count_approx": 1600,
      "time_of_day": "Malam",
      "gender_tag": "Feminin",
      "character": "Fresh Floral"
    },
    {
      "rank": 3,
      "name": "MANIKA",
      "slug": "manika",
      "url": "https://ruwangi.com/parfum/manika",
      "brand": "Iki Arum",
      "brand_slug": "iki-arum",
      "price_idr": 169000,
      "price_display": "Rp169.000",
      "rating": 4.9,
      "review_count_approx": 1700,
      "time_of_day": "Malam",
      "gender_tag": "Feminin",
      "character": "Warm Floral"
    }
  ]
}
```

`notes` and `scent_profile` are only populated when step 5 (detail-page enrichment) runs; omit from the card-only fast path.

Empty / failure shapes:

```json
// Catalog reachable, zero items matched the gender_tag filter (extremely unlikely on this page — sanity guard)
{
  "source_url": "...",
  "results": [],
  "warning": "no_feminin_cards_after_filter"
}
```

```json
// Page failed to render (Cloudflare challenge or future anti-bot wall)
{
  "source_url": "...",
  "results": [],
  "error": "page_blocked",
  "http_status_or_marker": "..."
}
```
