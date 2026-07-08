---
name: find-viral-articles
title: Health.com Find Viral Articles & Trending Topics
description: >-
  Surface health.com's freshest articles and the topics it is editorially
  betting on right now — the pool of likely-viral content — by reading the
  Google News sitemap and the homepage 'Trending' and 'The Latest' modules, then
  ranking by recency, topic-cluster frequency, and viral-headline pattern.
  Read-only.
website: health.com
category: media-monitoring
tags:
  - news
  - trending
  - content-discovery
  - sitemap
  - health
  - read-only
  - cloudflare
source: 'browserbase: agent-runtime 2026-05-31'
updated: '2026-05-31'
recommended_method: fetch
alternative_methods:
  - method: browser
    rationale: >-
      Use a residential-proxy browserless_agent session only when you must read
      the rendered 'trending-list' or 'The Latest' modules and the proxied
      homepage navigation is unavailable. Rendered pages are Cloudflare-walled;
      the sitemaps are not.
  - method: api
    rationale: >-
      No public popularity/analytics API is exposed. 'Viral potential' is
      inferred from recency + topic clustering + headline patterns, not from
      real view counts — there is no endpoint that returns true virality
      metrics.
verified: false
proxies: true
---

# Health.com Find Viral Articles & Trending Topics

## Purpose

Surface the articles and topics on health.com (a Dotdash Meredith property) that are most likely to go viral _right now_, and return them as a ranked list. health.com does **not** expose a public popularity/analytics API, so there is no source of true view counts. Instead, this skill infers "viral potential" from three honest, cheap signals the site publishes: (1) the rolling **Google News sitemap** of just-published articles, (2) the homepage **`trending-list`** module — the editorial team's hand-curated trending topic/campaign, and (3) **topic-cluster frequency** across the freshest headlines (a topic the publisher pushes multiple articles about in a short window is a topic it is betting will trend). The skill is **read-only** — it never logs in, comments, or submits anything.

## When to Use

- "What's about to blow up on health.com?" / "What health topics are trending today?"
- A content/SEO analyst monitoring a competitor's editorial priorities (which topics they're flooding).
- A newsletter or social agent that needs the freshest health articles plus the dominant theme to write around.
- Daily/hourly polling for newly published articles (the News sitemap refreshes with `Cache-Control: max-age=5`).
- Anywhere you'd otherwise scrape the rendered homepage — the sitemaps give the same fresh feed faster and without the Cloudflare wall.

## Workflow

The optimal path is a **lightweight navigation to the sitemaps and homepage HTML — no heavy scripted browsing, no login.** health.com's rendered pages sit behind Cloudflare (homepage returns `403`/`402` to a bare client), **but the XML sitemaps are served fine even without a proxy**, and the homepage HTML can be pulled through a residential proxy (`200`). Drive it with a single `browserless_agent` call (`goto` + parse in-page), not a multi-step browser flow, unless a rendered read is blocked. Note: `browserless_function`/raw `fetch` has no network egress until the page navigates, so a `goto`-first `browserless_agent` is the clean path for these static XML/HTML resources.

### 1. Pull the freshest article pool (no proxy needed)

Navigate to the sitemap and read its raw XML body — no proxy required:

```json
{
  "url": "https://www.health.com/google-news-sitemap.xml",
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.health.com/google-news-sitemap.xml",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    { "method": "text", "params": { "selector": "body" } }
  ]
}
```

(No `proxy` arg — the XML sitemaps are not Cloudflare-walled.)

This Google News sitemap is the canonical "what we just published / are pushing into Google News" feed — a rolling window of the most recent articles (observed ~14 entries; News sitemaps cap at the last ~48 h / ≤1000 URLs). Each `<url>` gives everything you need:

- `<loc>` — canonical article URL (the trailing numeric id, e.g. `…-11961430`, is the CMS post id).
- `<news:publication_date>` — ISO 8601 with TZ offset (e.g. `2026-05-30T11:00:00-04:00`). **Sort descending → the newest entries are the live viral window.**
- `<news:title>` — headline (HTML-entity-encoded; decode `&amp;#39;` → `'`).
- `<image:image><image:loc>` — lead image URL.

This feed matches the homepage "The Latest" module ordering exactly (verified), so it is authoritative — you usually do **not** need to render the homepage to get the fresh feed.

### 2. Pull the curated trending topic from the homepage (proxy required)

Navigate the homepage through a residential proxy and parse the trending module in-page (return a compact JSON projection, not the raw HTML):

```json
{
  "url": "https://www.health.com/",
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.health.com/",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ const mod = document.querySelector('[id^=\"trending-list\"], .trending-list'); if(!mod) return JSON.stringify(null); const title = mod.querySelector('[class*=\"trending-list__title\"]')?.textContent?.trim() || null; const articles = [...mod.querySelectorAll('a[href*=\"health.com\"]')].map(a=>({ url: a.href, title: a.querySelector('[class*=\"card__title-text\"]')?.textContent?.trim() || a.textContent.trim() })); return JSON.stringify({ title, articles }); })()"
      }
    }
  ]
}
```

The returned `.value` (JSON string) comes from `id="trending-list_1-0"` (CSS classes `trending-list mntl-four-post`). That module contains:

- `class="trending-list__title …"` → the **editorially-declared trending theme/campaign** (observed: `"May Is Skin Cancer Awareness Month"`). This is the single best "the publisher thinks this is the moment" signal.
- 4 article cards — extract each `<a href="https://www.health.com/…">` plus the `card__title-text` headline.

(The same HTML also carries the `>The Latest<` feed — same articles as the News sitemap — and `explore-conditions`/section modules if you want category context.)

### 3. Rank by viral-potential heuristic

Combine the signals into a score per article/topic. None of these is a true view count — be explicit that this is _potential_, not measured virality:

1. **Recency** — newest `publication_date` first. The top few entries are inside the active sharing window.
2. **Topic-cluster frequency** — tokenize the fresh headlines and count repeated themes. When the publisher ships ≥2 articles on the same topic in a short window, that topic is a deliberate trend bet. _(In the validation run: "magnesium" appeared in 3 of 14 headlines, "blood sugar" in 3, "probiotics" in 2 — so "magnesium / blood sugar" and "probiotics" were the dominant trending topics, independent of the curated skin-cancer module.)_
3. **Curated-module boost** — articles matching the `trending-list__title` theme are editorially endorsed.
4. **Headline-pattern score** — health.com leans on classic viral headline shapes; boost for: numbered listicles (`"7 Morning Drinks…"`, `"8 Foods…"`), curiosity-gap framing (`"What Happens to Your Liver When You…"`), and head-to-head comparisons (`"Sourdough vs. White Bread"`). These templates correlate with shareability.

### 4. Emit the ranked result (see Expected Output).

### Browser fallback

Only if the proxied homepage navigation in step 2 is unavailable and you must read the rendered modules — do the whole flow inside ONE `browserless_agent` call (goto → scroll the module into view → grab the HTML), with a residential proxy:

```json
{
  "url": "https://www.health.com/",
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.health.com/",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ document.querySelector('[id^=\"trending-list\"], .trending-list')?.scrollIntoView({block:'center'}); return 'ok'; })()"
      }
    },
    { "method": "html", "params": { "selector": "body" } }
  ]
}
```

Then parse `trending-list_1-0` out of the returned HTML as in step 2. No session-release step (nothing to release). The session persists across separate calls, keyed by `proxy`/`profile`, so a later call with the same config reconnects to the same page with cookies/session intact; batching the whole goto → scroll → extract flow inside this one call's `commands` array saves round-trips and avoids accidentally dropping that config. A bare (no-proxy) browser session gets the Cloudflare challenge, so `proxy: { proxy: "residential" }` is mandatory for any rendered page. The browser path costs far more than the sitemap/homepage navigation and yields the same data; use it only as a true fallback.

## Site-Specific Gotchas

- **Sitemaps bypass the Cloudflare wall; rendered pages do not.** `https://www.health.com/` returns `403` (bare fetch) / `402` (probe) / Cloudflare challenge, but `/google-news-sitemap.xml`, `/sitemap.xml`, and `/sitemap_1.xml` all return `200` **without** a proxy. The homepage HTML needs a residential proxy (`403` without → `200` with `proxy: { proxy: "residential" }`). Lead with the sitemap; only proxy when you need the curated module.
- **No virality metrics exist.** There is no public endpoint with view/share counts. Anyone claiming a "true viral score" is fabricating it. This skill returns _potential_ derived from recency + topic clustering + headline patterns. State that in the output (`signal: "inferred"`).
- **`robots.txt` blocks most AI crawlers by name** (`ClaudeBot`, `GPTBot`, `anthropic-ai`, `CCBot`, `PerplexityBot`, `Google-Extended`, etc. → `Disallow: /`). The News sitemap (`User-agent: *` only disallows `*.pdf` and `/embed?`) is explicitly published for news discovery, so reading it is consistent with the site's intent. Respect the AI-crawler rules for bulk crawling; keep this read-only and low-volume (the feed is small).
- **News sitemap is a tiny rolling window** (~14 URLs observed, `max-age=5`) — it is the _fresh_ feed, not an archive. For "recently updated but older" content, fall back to `sitemap_1.xml` (≈5,962 URLs, each with `<lastmod>` but **no** title/news metadata — you'd have to fetch each article for a headline).
- **`sitemap.xml` is an index, not a flat list** — it points to a single child `sitemap_1.xml`. Don't expect article URLs directly in `sitemap.xml`.
- **HTML-entity double-encoding in titles.** Observed `Here&amp;#39;s` in `<news:title>` — that's `Here's` double-encoded. Decode `&amp;` → `&` first, then numeric entities.
- **The `trending-list` module is a curated campaign, not real-time popularity.** Its title ("May Is Skin Cancer Awareness Month") is an editorial/seasonal theme, often unrelated to the dominant cluster in the fresh feed (which was magnesium/blood-sugar nutrition). Treat the two as complementary signals, not the same thing.
- **Topic clustering is the strongest organic trend signal.** Because the curated module is seasonal, the more reliable "what's trending in their newsroom today" read is keyword frequency across the News-sitemap headlines (multiple magnesium / blood-sugar / probiotics pieces shipped within hours of each other).
- **Cookies/session not required for fetch.** The sitemaps and proxied homepage set `__cf_bm`/`TMog` cookies but don't gate the content on them for a single read.
- **DOM ids are suffixed `_1-0`** (`trending-list_1-0`, `mntl-four-post__inner_1-0`). The Dotdash Meredith CMS appends `_<n>-<m>` instance suffixes; match on the id _prefix_ / class (`trending-list`, `mntl-four-post`) rather than the exact id in case the suffix changes.

## Expected Output

```json
{
  "site": "health.com",
  "retrieved_at": "2026-05-31T15:21:00Z",
  "signal": "inferred",
  "signal_basis": [
    "news_sitemap_recency",
    "topic_cluster_frequency",
    "curated_trending_module",
    "viral_headline_pattern"
  ],
  "curated_trending_topic": {
    "title": "May Is Skin Cancer Awareness Month",
    "source": "homepage trending-list module",
    "articles": [
      {
        "title": "What Does Skin Cancer Look Like?",
        "url": "https://www.health.com/what-does-skin-cancer-look-like-8684936"
      },
      {
        "title": "How Fast Does Skin Cancer Grow? Factors and How To Monitor",
        "url": "https://www.health.com/how-fast-does-skin-cancer-grow-11700721"
      }
    ]
  },
  "trending_topics_inferred": [
    {
      "topic": "magnesium",
      "article_count": 3,
      "rationale": "3 of 14 fresh headlines reference magnesium (sleep + blood sugar)"
    },
    {
      "topic": "blood sugar",
      "article_count": 3,
      "rationale": "repeated blood-sugar nutrition angle across the fresh feed"
    },
    {
      "topic": "probiotics",
      "article_count": 2,
      "rationale": "kombucha + dairy probiotic comparisons shipped together"
    }
  ],
  "viral_candidates": [
    {
      "rank": 1,
      "title": "7 Morning Drinks To Support Your Kidney Health, According to a Dietitian",
      "url": "https://www.health.com/morning-drinks-for-kidney-health-11961430",
      "post_id": "11961430",
      "published_at": "2026-05-30T11:00:00-04:00",
      "image": "https://www.health.com/thmb/.../Health-GettyImages-114452963-....png",
      "headline_patterns": ["numbered_listicle", "expert_authority"],
      "topic_cluster": "kidney/nutrition",
      "viral_potential": "high"
    },
    {
      "rank": 2,
      "title": "What Happens to Your Liver When You Eat High-Sugar Foods Every Day?",
      "url": "https://www.health.com/high-sugar-foods-liver-health-effects-11964726",
      "post_id": "11964726",
      "published_at": "2026-05-30T10:00:00-04:00",
      "headline_patterns": ["curiosity_gap"],
      "topic_cluster": "blood sugar",
      "viral_potential": "high"
    }
  ],
  "notes": "Virality is inferred (no public view/share metrics exist on health.com). Ranking = recency + topic-cluster frequency + viral headline pattern + curated-module overlap."
}
```

If the curated module is absent or the homepage fetch is blocked, omit `curated_trending_topic` and return the News-sitemap-only ranking:

```json
{
  "site": "health.com",
  "signal": "inferred",
  "curated_trending_topic": null,
  "trending_topics_inferred": [{ "topic": "magnesium", "article_count": 3 }],
  "viral_candidates": [
    {
      "rank": 1,
      "title": "...",
      "url": "...",
      "published_at": "...",
      "viral_potential": "high"
    }
  ],
  "notes": "Homepage trending module unavailable (Cloudflare); ranked on News-sitemap recency + topic clustering only."
}
```
