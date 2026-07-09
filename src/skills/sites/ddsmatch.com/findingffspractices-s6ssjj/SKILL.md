---
name: finding-ffs-practices
title: Find DDSmatch Job Posts Mentioning FFS
description: >-
  Find DDSmatch practice/opportunity listings whose text mentions the term FFS
  (Fee-For-Service), returning each matching listing's ID, URL, date, and
  excerpt via the site's native WordPress search.
website: ddsmatch.com
category: search
tags:
  - dental
  - practice-listings
  - job-search
  - fee-for-service
  - wordpress-search
source: 'browserbase: agent-runtime 2026-06-16'
updated: '2026-06-16'
recommended_method: fetch
alternative_methods:
  - method: browser
    rationale: >-
      A residential-proxy `browserless_agent` session as a fallback to visually
      confirm results; needed only if the HTML structure changes since the fetch
      path already renders matches server-side.
  - method: api
    rationale: >-
      The Search&Filter Pro AJAX endpoint (?sfid=240283&sf_action=get_data)
      exists but does NOT filter by the FFS keyword — confirmed to return the
      unfiltered default set — so it is not usable for this task.
verified: true
proxies: true
---

# Find DDSmatch Job Posts Mentioning "FFS"

## Purpose

Find DDSmatch practice/opportunity listings (the site's "job posts" — associateships, sale-of-practice, partnerships, etc.) whose text mentions the term **FFS** (Fee-For-Service, the payor/reimbursement model). This is a **read-only** lookup. It returns the set of matching listing IDs with their URLs, post dates, and excerpts (each excerpt typically describes the patient base, e.g. "a strong mix of FFS and PPO patients"). The fastest path is the site's native WordPress search endpoint — no scripted browsing required.

## When to Use

- A user wants every DDSmatch opportunity/listing that references fee-for-service ("FFS") economics.
- A recruiter or dentist is filtering opportunities by payor mix and asks "which posts mention FFS?".
- You need the count of FFS-related listings or a paginated dump of their IDs/URLs/excerpts.
- More generally: any free-text keyword search across DDSmatch practice listings (swap `FFS` for the desired term).

## Workflow

DDSmatch is a WordPress (Divi) site whose practice listings are a custom post type indexed by the **native WordPress search**. A plain `GET` to the search URL returns server-rendered HTML containing the matching listings, so the recommended path is a single `browserless_agent` `goto` + in-page `evaluate` (residential proxy) that parses the result cards — no scripted click-through.

1. **Fetch the search page** (residential proxy required — the site sits behind Cloudflare WAF). Call `browserless_agent` with `proxy: { proxy: "residential" }` and a `commands` array that navigates then parses in-page:

   ```
   { "method": "goto", "params": { "url": "https://ddsmatch.com/?s=FFS", "waitUntil": "load", "timeout": 45000 } }
   { "method": "evaluate", "params": { "content": "(()=>JSON.stringify([...document.querySelectorAll('h2.entry-title a')].map(a=>({id:a.href.match(/practices\\/(\\d+)/)?.[1],url:a.href}))))()" } }
   ```

   A rendered `<title>You searched for FFS - DDSmatch</title>` confirms success. (If Cloudflare throws a Turnstile interstitial, prepend a `solve { type: "cloudflare" }` command.)

2. **Parse the result cards.** Each match is an entry block of the form:

   ```html
   <h2 class="entry-title">
     <a href="https://ddsmatch.com/practices/654251/">654251</a>
   </h2>
   ```

   Extract the numeric **practice ID** from the `/practices/{id}/` href, plus the adjacent post date and excerpt. The listing title is just the numeric ID; the human-readable summary lives in the excerpt/`og:description`.

3. **Paginate.** The first page returns **15 results**. Walk subsequent pages until one returns zero entries:

   ```
   https://ddsmatch.com/page/2/?s=FFS
   https://ddsmatch.com/page/3/?s=FFS   ...
   ```

   The footer pagination also exposes the highest page number (e.g. `/page/22/?s=FFS`). As of 2026-06-16 there were **~319 matches across 22 pages** (21 full pages of 15 + a final page of 4).

4. **(Optional) Enrich a listing.** Fetch `https://ddsmatch.com/practices/{id}/` for full detail; the opportunity summary (including the FFS reference) is in the page's `og:description` meta tag and the "Practice Details" body text.

5. **Emit JSON** per the Expected Output schema below.

### Browser fallback

If the HTML structure changes or you must visually confirm results, run a `browserless_agent` session with `proxy: { proxy: "residential" }` (residential proxy is mandatory — see Gotchas). Keep the whole flow in one call's `commands` array:

1. `{ "method": "goto", "params": { "url": "https://ddsmatch.com/?s=FFS", "waitUntil": "load", "timeout": 45000 } }`.
2. `{ "method": "text", "params": { "selector": "title" } }` should read `You searched for FFS - DDSmatch`.
3. `{ "method": "text", "params": { "selector": "main" } }` (or `{ "method": "snapshot" }`) — the result cards render as `Results for "FFS"` followed by listing blocks linking to `/practices/{id}/`.
4. Navigate `/page/N/?s=FFS` for additional pages. Stop at the listing/results screen — do not contact sellers or submit any inquiry forms.

## Site-Specific Gotchas

- **Cloudflare WAF is always on.** Bare HTTP works for `robots.txt` but listing pages need a residential proxy. Pass `proxy: { proxy: "residential" }` on **every** `browserless_agent` call — a proxy-less session risks a Cloudflare challenge/interstitial; if one appears, add a `solve { type: "cloudflare" }` command.
- **Use the WordPress search (`?s=`), NOT the Search&Filter Pro form.** The `/dental-practice-listings/` page uses a Search&Filter Pro facet UI (state / region / type / opportunity / revenue / operatories). There is **no "FFS" facet** — FFS is not a structured field, it only appears in free-text listing descriptions.
- **Don't waste time on the Search&Filter `_sf_search[]` param — confirmed non-filtering.** Both the static URL form (`/dental-practice-listings/?_sf_search[]=FFS`) and its AJAX endpoint (`/?sfid=240283&sf_action=get_data&sf_data=all&_sf_search[]=FFS`) return the **default unfiltered** result set (a nonsense term like `zzqqxx` returns the same default page). The text input is wired for zip/location, not full-text keyword filtering of the listing corpus.
- **Result "titles" are just numeric practice IDs** (e.g. `654251`). The descriptive text (specialty, location, payor mix, FFS mention) is in the excerpt and the practice page's `og:description` — not in the title.
- **A listing matches on FFS even if `/practices/{id}/` looks FFS-free at a glance.** The match comes from the indexed title/content/excerpt; confirm by reading `og:description` rather than visible body text (some IDs returned by an unrelated listing browse won't be in the FFS result set — always trust the `?s=FFS` result list).
- **`FFS` also matches "Fee-for-Service" phrasing** in a few listings, but the search is on the literal token `FFS`; the result set is the authoritative answer.
- **Pagination ends silently.** `/page/{N}/?s=FFS` beyond the last page returns a page with **zero entry cards** (no hard 404). Terminate when an entry-title count of 0 is observed.
- **Counts drift over time.** Listings are added/removed continuously (dates seen ranged into 2026). Re-derive the total from live pagination rather than hard-coding 319.

## Expected Output

```json
{
  "query": "FFS",
  "source_url": "https://ddsmatch.com/?s=FFS",
  "method": "fetch",
  "total_results": 319,
  "total_pages": 22,
  "results_per_page": 15,
  "retrieved_at": "2026-06-16",
  "job_posts": [
    {
      "id": "654251",
      "url": "https://ddsmatch.com/practices/654251/",
      "title": "654251",
      "date": "2026-06-15",
      "excerpt": "Full-time General Dentist opportunity in Franklin, Tennessee. Join an established 8-operatory, 2-doctor practice with a strong mix of FFS and PPO patients. This position offers full technology, excellent growth potential, advanced procedures mentorship...",
      "mentions_ffs": true
    },
    {
      "id": "653039",
      "url": "https://ddsmatch.com/practices/653039/",
      "title": "653039",
      "date": "2026-06-09",
      "mentions_ffs": true
    }
  ]
}
```

No-results shape (e.g. a term with no matches, or paging past the end):

```json
{
  "query": "FFS",
  "source_url": "https://ddsmatch.com/page/23/?s=FFS",
  "total_results": 0,
  "job_posts": []
}
```
