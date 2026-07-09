---
name: explore-blogs
title: Explore Thinking Machines Blog (Connectionism)
description: >-
  Enumerate the research blog posts on thinkingmachines.ai (the "Connectionism"
  blog at /blog/), returning each post's title, URL, publication date, and
  author. Read-only; optionally enriches posts with description, full text, and
  word count via RSS or individual post pages.
website: thinkingmachines.ai
category: content
tags:
  - blog
  - content
  - research
  - static-site
  - rss
  - read-only
source: 'browserbase: agent-runtime 2026-06-06'
updated: '2026-06-06'
recommended_method: fetch
alternative_methods:
  - method: fetch
    rationale: >-
      Recommended: the RSS feed /index.xml returns every post's full HTML body
      plus title/link/pubDate in a single GET; filter items by /blog/ in the
      link. Best for content extraction in one request.
  - method: browser
    rationale: >-
      Fallback only. A single `browserless_agent` call with a `snapshot` command
      after loading /blog/ exposes all post titles, dates, authors, and hrefs in
      the a11y tree. Works but is ~100x more expensive than fetch and unnecessary
      since the site is fully server-rendered and Cloudflare does not challenge GETs.
verified: false
proxies: false
---

# Explore the Thinking Machines Lab Blog (Connectionism)

## Purpose

Enumerate the research blog posts published on `thinkingmachines.ai` — the blog is
branded **"Connectionism"** and lives at `/blog/` — and return a structured list of
every post with its title, canonical URL, publication date, and author/attribution.
Optionally enrich each post with its description, full article text, and word count.
**Read-only** — this skill only reads public pages; it never submits forms, applies to
jobs, or clicks "Join us".

## When to Use

- "What's on the Thinking Machines Lab blog?" / "List their latest research posts."
- Monitoring Connectionism for new posts (poll the index or the RSS feed on a schedule).
- Building a feed/digest of titles + dates + authors + links.
- Pulling the full text of a specific post (e.g. "LoRA Without Regret") for summarization.
- Any flow that would otherwise scrape the blog HTML — `fetch` is faster, cheaper, and
  more reliable than driving a browser here.

## Workflow

`thinkingmachines.ai` is a **Hugo static site, fully server-rendered**. Every blog page —
the index, each post, the RSS feed, and the sitemap — returns complete HTML/XML on a plain
HTTP GET. There is **no client-side rendering and no content JSON API** (the only XHR the
page fires is a Cloudflare RUM beacon at `/cdn-cgi/rum`). Cloudflare fronts the site but
does **not** challenge simple fetches: a plain same-origin `fetch` (no proxy, no stealth)
returns HTTP 200. So the optimal path is `browserless_function` — navigate the page to the
origin, then `fetch` the HTML/XML and parse in-page — driving a full agent session with
navigation + a11y snapshots is unnecessary and ~100× more expensive.

Use `browserless_function` for the fetch path. Remember the runtime is a **browser page
context, not Node**: a bare `fetch(url)` has no network egress until the page is on that
origin, so `page.goto('https://thinkingmachines.ai/')` **first**, then
`page.evaluate(async () => (await fetch('/blog/')).text())` (same-origin) and parse the
returned HTML/XML in-page — return only the compact projected JSON, never the raw ~420 KB feed.

### 1. Enumerate posts from the blog index (primary)

```
GET https://thinkingmachines.ai/blog/
```

Each post is a list item shaped like:

```html
<a class="post-item-link" href="/blog/{slug}/">
  <time class="desktop-time">May 11, 2026</time>
  <div class="post-info">
    <div class="post-title">
      Interaction Models: A Scalable Approach to Human-AI Collaboration
    </div>
    <div class="author-date">Thinking Machines</div>
    <time class="mobile-time">May 11, 2026</time>
  </div>
</a>
```

Extract per post:

- **url** — the `href` (relative `/blog/{slug}/`); prepend `https://thinkingmachines.ai` for the absolute URL.
- **title** — text of `.post-title`.
- **published** — text of the `time` element (e.g. `"May 11, 2026"`). Note there are two `<time>` nodes per item (`desktop-time` + `mobile-time`) with identical text — dedupe.
- **author** — text of `.author-date` (e.g. `"Thinking Machines"`, `"John Schulman in collaboration with others at Thinking Machines"`); trim whitespace.

The index lists newest-first and currently shows **all 5 posts on one page — there is no pagination**.

### 2. (Optional) Get full content / descriptions via RSS

```
GET https://thinkingmachines.ai/index.xml
```

A standard RSS 2.0 feed. Each `<item>` carries `<title>`, `<link>`, `<guid>`, `<pubDate>`
(RFC-822), and `<description>` containing the **full HTML body** of the post (the feed is
large — ~420 KB — because it inlines complete articles). One request yields every post's
full text. **Filter `<item>`s whose `<link>` contains `/blog/`** — `/index.xml` is the
site-wide "recent content" feed and may include non-blog (`/news/`) items in the future;
today it happens to contain only the 5 blog posts.

### 3. (Optional) Enrich a single post

```
GET https://thinkingmachines.ai/blog/{slug}/
```

Each post page is server-rendered and exposes clean metadata in `<head>`:

- `<title>` — `"{Post Title} - Thinking Machines Lab"`
- `<meta name="description" content="...">` — one-line summary
- `<meta itemprop="datePublished" content="2025-09-29T00:00:00+00:00">` — ISO-8601 date
- `<meta itemprop="wordCount" content="5784">`
- `<article>...</article>` — the full rendered body (math is KaTeX, rendered client-side, but the raw `$...$` LaTeX source is present in the server HTML).

### 4. (Optional) Discover all URLs via sitemap

```
GET https://thinkingmachines.ai/sitemap.xml
```

24 `<loc>` entries covering the whole site; exactly the 5 `/blog/{slug}/` URLs plus the
`/blog/` index are the blog surface. Useful as a cross-check that the index didn't miss a post.

### Browser fallback

Only needed if the fetch endpoints ever start returning a Cloudflare interstitial (not
observed). Drive one `browserless_agent` call — all steps in a single `commands`
array so the session carries across them:

```json
{
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://thinkingmachines.ai/blog/",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    { "method": "snapshot" }
  ]
}
```

The snapshot returns ~60 a11y refs — post titles, dates, authors, and the href map are all
present, so a single `snapshot` after the `goto` completes is enough — no scrolling or
clicking required. If Cloudflare does throw a challenge, add a
`{ "method": "solve", "params": { "type": "cloudflare" } }` step (with `proxy: { "proxy": "residential" }`
at the top level) before the snapshot — but this has never been observed for GETs here.

## Site-Specific Gotchas

- **The blog is named "Connectionism" and lives at `/blog/`.** The top-nav label is
  "Connectionism", not "Blog". Don't confuse it with **`/news/`**, which is a _separate_
  section for company announcements (Tinker GA, NVIDIA partnership, grants, etc.) — not
  research blog posts.
- **No content API.** The site is static Hugo HTML; the only XHR is the Cloudflare RUM
  beacon (`/cdn-cgi/rum`). Don't waste time hunting for a JSON endpoint — parse the HTML or RSS.
- **Proxies / stealth are NOT required — do NOT set `proxy`.** Cloudflare fronts the site
  (`Server: cloudflare`, `cf-cache-status: DYNAMIC`) but does not challenge GETs — a plain
  same-origin `fetch` returns HTTP 200 on the homepage, `/blog/`, every post, `/index.xml`,
  and `/sitemap.xml`. A pre-run probe predicted `likelyNeedsProxies: true`, but direct
  testing showed proxies are unnecessary for the fetch path. (The browser-fallback
  validation happened to run through a residential-proxy session, but that was
  belt-and-suspenders, not a requirement.)
- **Return a projected result, not the raw payload.** `browserless_function` caps its text
  return (~200 KB) and `/index.xml` alone is ~420 KB, so parse the HTML/XML inside the
  in-page `evaluate` and return only the compact JSON (titles/urls/dates/authors) — never
  ship the raw feed back out.
- **`/index.xml` is site-wide "recent content", not blog-only.** Today it contains exactly
  the 5 blog items, but to stay correct over time, filter `<item>`s by `<link>` containing
  `/blog/`. For a guaranteed blog-only feed, `/blog/index.xml` also exists.
- **Two `<time>` nodes per index item** (`desktop-time` and `mobile-time`) carry identical
  text — dedupe so you don't double-count the date.
- **Author strings vary in shape** — from a bare `"Thinking Machines"` to
  `"John Schulman in collaboration with others at Thinking Machines"`. Treat the whole
  `.author-date` string as the attribution; don't try to split out a single name.
- **Date formats differ by surface**: index = `"May 11, 2026"`; RSS `<pubDate>` = RFC-822
  (`"Mon, 11 May 2026 00:00:00 +0000"`); post-page `datePublished` = ISO-8601. Normalize if
  you need a canonical date.
- **Post math is KaTeX.** Article bodies contain LaTeX (`$...$`, `$$...$$`) rendered
  client-side by KaTeX. The raw LaTeX source is in the server HTML, so a fetch captures it;
  a browser screenshot captures the rendered math.
- **Keep the browser fallback in ONE call.** Putting the navigation and the `snapshot` in a
  single `commands` array saves round-trips — but note the session actually persists across
  calls, keyed by its config: a follow-up call with the same config reconnects to the same
  session, while dropping or changing it lands you in a different, blank one. There is no
  session-release step to manage.

## Expected Output

Primary shape — the blog index enumeration:

```json
{
  "success": true,
  "blog_name": "Connectionism",
  "blog_url": "https://thinkingmachines.ai/blog/",
  "post_count": 5,
  "posts": [
    {
      "title": "Interaction Models: A Scalable Approach to Human-AI Collaboration",
      "url": "https://thinkingmachines.ai/blog/interaction-models/",
      "published": "May 11, 2026",
      "author": "Thinking Machines"
    },
    {
      "title": "On-Policy Distillation",
      "url": "https://thinkingmachines.ai/blog/on-policy-distillation/",
      "published": "Oct 27, 2025",
      "author": "Kevin Lu in collaboration with others at Thinking Machines"
    },
    {
      "title": "LoRA Without Regret",
      "url": "https://thinkingmachines.ai/blog/lora/",
      "published": "Sep 29, 2025",
      "author": "John Schulman in collaboration with others at Thinking Machines"
    },
    {
      "title": "Modular Manifolds",
      "url": "https://thinkingmachines.ai/blog/modular-manifolds/",
      "published": "Sep 26, 2025",
      "author": "Jeremy Bernstein"
    },
    {
      "title": "Defeating Nondeterminism in LLM Inference",
      "url": "https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/",
      "published": "Sep 10, 2025",
      "author": "Horace He in collaboration with others at Thinking Machines"
    }
  ],
  "error_reasoning": null
}
```

Optional enriched per-post shape (when fetching an individual post page or RSS item):

```json
{
  "title": "LoRA Without Regret",
  "url": "https://thinkingmachines.ai/blog/lora/",
  "published": "2025-09-29T00:00:00+00:00",
  "author": "John Schulman in collaboration with others at Thinking Machines",
  "description": "How LoRA matches full training performance more broadly than expected.",
  "word_count": 5784
}
```
