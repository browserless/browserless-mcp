---
name: search-health-topics
title: Search Huberman Lab Health Topics
description: >-
  Search hubermanlab.com for a health topic (e.g. 'sleep', 'sleep hygiene') via
  its public read-only Meilisearch index and return matching episodes,
  newsletters, topics, and clips with titles, links, categories, and dates.
website: hubermanlab.com
category: search
tags:
  - search
  - health
  - podcast
  - hubermanlab
  - meilisearch
  - content
source: 'browserbase: agent-runtime 2026-06-22'
updated: '2026-06-22'
recommended_method: api
alternative_methods:
  - method: browser
    rationale: >-
      Fallback when the Meilisearch host is unreachable: with browserless_agent,
      goto /search-results?q={term}, waitForTimeout ~2.5s for client-side
      rendering, then snapshot the result cards. Slower and only returns one page
      (~20 hits) at a time.
  - method: fetch
    rationale: >-
      Plain HTML fetch of the search page does NOT work — results are 100%
      client-side rendered and the page returns the same empty shell for every
      query.
verified: false
proxies: true
---

# Search Huberman Lab Health Topics

## Purpose

Search hubermanlab.com for a health topic (e.g. "sleep", "sleep hygiene", "cold exposure", "dopamine") and return the matching episodes, newsletters, topic pages, and timestamped clips. This is a **read-only** lookup. The site's search is powered by a public, read-only **Meilisearch** index whose host/key/index are exposed in the page's client-side JavaScript, so the optimal path is a direct API call — no browser automation required. A browser fallback is documented for environments that can't reach the Meilisearch host directly.

## When to Use

- "Find Huberman Lab episodes about sleep / sleep hygiene."
- "What has Andrew Huberman covered on cold exposure / caffeine / dopamine?"
- "Search hubermanlab.com for {topic} and list the top results with links."
- "Get the topic/category breakdown of Huberman Lab content matching {term}."
- Building a content index or pulling episode metadata (titles, slugs, post dates, categories, timestamps) for a given health subject.

## Workflow

The recommended method is a **direct HTTP POST to the Meilisearch index** that the site itself queries. The search box at `https://www.hubermanlab.com/search-results` is a thin client-side wrapper around this index — there is nothing the UI returns that the API doesn't.

**Transport note (Browserless):** This is a plain HTTPS JSON API — the HTTP POST/GET examples below are canonical and run from any client. The Meilisearch host (`*.meilisearch.io`) has **no Cloudflare**, so a normal client reaches it directly. Only under restricted egress, route via `browserless_function` (which executes in a browser page context): `page.goto('https://ms-3c8f24792474-17893.sfo.meilisearch.io/')` first, then `page.evaluate` a **same-origin** `fetch` to `/indexes/hubermanlab/search` — same-origin, so the `Authorization: Bearer` POST works. Don't route keys through the browser gratuitously; the key here is already a **public read-only search key**.

### Step 1 — Issue the search request

```
POST https://ms-3c8f24792474-17893.sfo.meilisearch.io/indexes/hubermanlab/search
Authorization: Bearer 041e82b255005543758795a8d50c273d19024ae10fddf69616ef1c8dc596711a
Content-Type: application/json

{
  "q": "sleep",
  "limit": 20,
  "offset": 0,
  "attributesToHighlight": ["name", "description"],
  "attributesToCrop": ["description"],
  "cropLength": 200
}
```

A GET form also works: `GET /indexes/hubermanlab/search?q=sleep&limit=20` with the same `Authorization: Bearer` header.

### Step 2 — (optional) Filter by category

Use Meilisearch facet filters to narrow by content type:

```json
{ "q": "sleep", "limit": 20, "filter": "category = \"Solo Episode\"" }
```

Valid `category` values (with current counts from facet distribution): `Solo Episode` (101), `Guest Episode` (172), `Essentials` (72), `AMA` (19), `Newsletter` (19), `Guest Series` (16), `Sponsor` (16), `Topic` (29), `Journal Club` (2), `Timestamp` (2260). To get live facet counts, send `{ "q": "", "facets": ["category"], "limit": 0 }` and read `facetDistribution.category`.

### Step 3 — Parse results

Each element of `hits[]` contains: `name`, `slug`, `link` (relative path, prefix with `https://www.hubermanlab.com`), `category`, `primaryTopic[]`, `topics[]`, `subtopics[]`, `postDate`, `thumbnail`, `description`, `keywords`, `episodeTimestamps[]`, and `_formatted` (the same fields with `<em>…</em>` highlight markup). `estimatedTotalHits` is the total match count. Build the user-facing list from `name` + `https://www.hubermanlab.com{link}` + `category`.

### Browser fallback

If the Meilisearch host is unreachable (network egress restrictions), drive the search page directly with `browserless_agent`. The query parameter auto-runs the search on load, so put all steps in one call's `commands` array:

1. `{ "method": "goto", "params": { "url": "https://www.hubermanlab.com/search-results?q=sleep", "waitUntil": "load", "timeout": 45000 } }` — built-in stealth is enough; no session/proxy step needed (see Gotchas).
2. `{ "method": "waitForTimeout", "params": { "time": 2500 } }` — results are rendered **client-side**; the initial HTML is an empty shell (same byte length for every query).
3. `{ "method": "snapshot" }` (or an `evaluate` that projects the result cards to compact JSON) and read the cards: title, category badge, topic tags, link. Confirm selectors via `snapshot` if the fields shift. Pagination shows ~20 hits/page.
4. To change the query without reloading, `{ "method": "type", "params": { "selector": "#search-input", "text": "{term}" } }` (debounced 500ms, minimum 3 chars) — but navigating to `?q={term}` via `goto` is simpler and deterministic.

## Site-Specific Gotchas

- **The Meilisearch credentials are a public, read-only search key** embedded in the page's own client JS (`MEILISEARCH_HOST` / `MEILISEARCH_API_KEY` / `INDEX_NAME = "hubermanlab"`). It only permits search, not writes. If the key rotates, re-extract it from the HTML of `https://www.hubermanlab.com/search-results` (search the page source for `MEILISEARCH_HOST`).
- **`hubermanlab.com` 301-redirects to `www.hubermanlab.com`** (Cloudflare + Webflow). Always use the `www.` host. `/search`, `/search?query=…`, and `/search?q=…` all 301 to `/search-results`. The live query param on the results page is **`q`** (e.g. `/search-results?q=sleep`).
- **Search results are 100% client-side rendered.** Fetching the page HTML returns the same 92 KB shell regardless of query — you will see zero results in raw HTML. You must either call the API (recommended) or render JS in a real browser.
- **The site's own UI uses Meilisearch hybrid search** (`hybrid: { embedder: "hubermanlab" }`) for queries ≥ 3 chars. In testing the embedder returned `semanticHitCount: 0` (no real vector matches), so for valid terms it behaves like keyword search. **Avoid `hybrid` for clean no-result detection:** a gibberish query with `hybrid` returns ~1000 nearest-neighbor junk hits, whereas plain keyword search correctly returns `estimatedTotalHits: 0`. Use plain keyword search unless you specifically want fuzzy/semantic recall.
- **The index mixes content types.** Besides episodes/newsletters/topics, it contains 2260 `Timestamp` entries (individual clip markers). If you only want full episodes/articles, filter to the relevant categories (`Solo Episode`, `Guest Episode`, `Essentials`, etc.) and exclude `Timestamp`.
- **`link` is relative.** Episode links look like `/episode/{slug}`; topic links like `/topic/{slug}`. Prefix with `https://www.hubermanlab.com`.
- **Cloudflare/anti-bot:** the pre-run probe flagged Cloudflare and suggested residential proxies. The direct Meilisearch API call is on a separate host (`*.meilisearch.io`) with no Cloudflare and worked cleanly. For the browser fallback, a plain `browserless_agent` session reached the page successfully **even without a proxy** (built-in stealth was enough); adding a residential proxy (`proxy: { proxy: "residential" }` on the call) is a safe upgrade if you hit a challenge.
- There is also an "Ask Huberman" AI feature linking to `https://ai.hubermanlab.com/start?content={query}` — not part of search; ignore unless explicitly asked.

## Expected Output

Successful search (recommended API path):

```json
{
  "success": true,
  "query": "sleep",
  "total_results": 249,
  "results": [
    {
      "name": "Sleep Toolkit: Tools for Optimizing Sleep & Sleep-Wake Timing",
      "category": "Solo Episode",
      "primary_topic": "Sleep Hygiene",
      "topics": ["Sleep Hygiene", "Light Exposure and Circadian Rhythm"],
      "post_date": "2022-08-08T08:00:00.000Z",
      "link": "https://www.hubermanlab.com/episode/sleep-toolkit-tools-for-optimizing-sleep-and-sleep-wake-timing",
      "description": "In this Huberman Lab episode, discover science-backed tools for optimizing sleep and sleep-wake timing..."
    }
  ]
}
```

Category-filtered search (`filter: category = "Solo Episode"`):

```json
{
  "success": true,
  "query": "sleep",
  "filter": "category = \"Solo Episode\"",
  "total_results": 37,
  "results": [/* … */]
}
```

No results (plain keyword search, no `hybrid`):

```json
{ "success": true, "query": "zxqwplmkjhgf", "total_results": 0, "results": [] }
```

Facet distribution (`q: ""`, `facets: ["category"]`, `limit: 0`):

```json
{
  "success": true,
  "facetDistribution": {
    "category": {
      "Solo Episode": 101,
      "Guest Episode": 172,
      "Essentials": 72,
      "AMA": 19,
      "Newsletter": 19,
      "Topic": 29,
      "Timestamp": 2260,
      "Guest Series": 16,
      "Sponsor": 16,
      "Journal Club": 2
    }
  }
}
```
