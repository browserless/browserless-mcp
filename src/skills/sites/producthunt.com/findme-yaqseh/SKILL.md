---
name: find-free-tools-daily
title: Find Daily Free Tools on Product Hunt
description: >-
  Surface 5-10 products from Product Hunt's daily launches that are free or
  freemium (Free / Free Options) and worth sharing with people who rely on free
  tools, with name, tagline, topics, votes, and product URL. Read-only.
website: producthunt.com
category: product-discovery
tags:
  - product-hunt
  - free-tools
  - leaderboard
  - cloudflare
  - read-only
  - curation
source: 'browserbase: agent-runtime 2026-06-20'
updated: '2026-06-20'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      Product Hunt's official GraphQL API (api.producthunt.com/v2/api/graphql)
      is the cleanest path but requires an OAuth developer token; not viable for
      an unauthenticated agent. With a token it would avoid Cloudflare and
      return pricing directly.
  - method: fetch
    rationale: >-
      Confirmed blocked — the plain HTTP/fetch path (incl. residential-proxy
      fetch) returns Cloudflare's managed-challenge 'Just a moment...'
      interstitial even for /robots.txt. Do not rely on it.
verified: true
proxies: true
---

# Find Daily Free Tools on Product Hunt

## Purpose

Surface 5–10 products from Product Hunt's **current daily launches** that are worth sharing with people who rely on **free tools** — i.e. products whose pricing label is `Free` or `Free Options` (freemium / has a usable free tier). For each product the skill returns name, tagline, topics, vote count, the canonical product URL, and the pricing label that justifies the "free" classification. **Read-only** — never signs in, votes, comments, follows, or submits anything.

## When to Use

- A daily "free tools roundup" feed: pull the day's top launches and keep only the free / freemium ones.
- Curating a newsletter or social post of free tools for a budget-conscious audience.
- Any flow that needs today's Product Hunt launches _filtered by price_ (the leaderboard itself does not expose pricing).
- Substitute `daily` with `weekly` / `monthly` / `yearly` leaderboards (same parsing) for longer-horizon roundups.

## Workflow

Product Hunt sits behind a **Cloudflare managed challenge**, and there is **no usable public data path without an OAuth token** (the official GraphQL API at `api.producthunt.com/v2/api/graphql` requires a developer access token; the plain HTTP/`fetch` path — even `/robots.txt` — returns the Cloudflare "Just a moment…" interstitial). The honest, reliable method is a **stealth browser session**. A bare session is blocked; a stealth + residential-proxy `browserless_agent` call clears the challenge consistently. There is one unavoidable extra cost: the daily leaderboard and homepage **do not show pricing per card**, so the "free" decision requires opening each candidate's `/products/{slug}` page and reading its pricing label.

1. **Use a stealth + residential-proxy session** (mandatory): call `browserless_agent` with a top-level `proxy: { "proxy": "residential", "proxyCountry": "us" }`. Batching the whole leaderboard → per-product flow inside one call's `commands` array is the convenient default — it saves round-trips and avoids accidentally dropping the session config. But the session persists across calls, keyed by `proxy`: repeat the **same** `proxy` arg on any follow-up call to reconnect to the same warmed session (Cloudflare cookie intact), while dropping or changing `proxy` puts you back on the blocked bare path. There's no explicit release step to manage.

2. **Open today's daily leaderboard.** Leaderboards run on **US/Pacific time**; build the dated URL accordingly:

   ```
   https://www.producthunt.com/leaderboard/daily/{yyyy}/{m}/{d}
   ```

   (e.g. `.../daily/2026/6/20`). The homepage `https://www.producthunt.com/` "Top Products Launching Today" section is an equivalent fallback. Then:

   ```json
   { "method": "goto", "params": { "url": "https://www.producthunt.com/leaderboard/daily/2026/6/20", "waitUntil": "load", "timeout": 45000 } }
   { "method": "waitForTimeout", "params": { "time": 3000 } }
   ```

   (the `waitForTimeout` covers Cloudflare + progressive render). Confirm you're through Cloudflare: the page title should be like `Best of Product Hunt: June 20, 2026 | Product Hunt`, **not** `Just a moment...`.

3. **Extract the ranked launch list** with a `text`/`html` read of `body` (or fold the parse into an `evaluate` command). Each launch row renders as:

   ```
   [1\. WorkClaw](/products/workclaw)Collaborative, proactive AI coworkers who work in Slack
   [Productivity](/topics/productivity)•[Artificial Intelligence](/topics/...)•[Business](/topics/...)
   40
   208
   ```

   Parse per row: **rank** (the `N\.` prefix), **name**, **slug** (from `/products/{slug}`), **tagline** (text immediately after the product link), **topics** (the `/topics/` links), and the **two trailing integers** — the **larger is the vote count**, the smaller is the comment count. Skip `Promoted` rows that have no rank number (sponsor slots).

4. **Classify pricing per product (2 turns each).** The label is not on the leaderboard — open each candidate top-down (highest votes first), all within the same `browserless_agent` call:

   ```json
   { "method": "goto", "params": { "url": "https://www.producthunt.com/products/{slug}", "waitUntil": "load", "timeout": 45000 } }
   { "method": "text", "params": { "selector": "body" } }
   ```

   In the returned text, the pricing/availability label sits **immediately before the string `Launch tags:`**. It is one of:
   - `Free` → `free: true`
   - `Free Options` (freemium / free tier) → `free: true`
   - `Paid` / `Payment Required` → `free: false`
   - _(no label before `Launch tags:`)_ → unknown; skip and move on.

5. **Stop early.** As soon as you have **5–6 confirmed free / Free Options products**, stop opening pages and emit the JSON. Six is a complete result; collecting more just burns turns/cost.

6. **Emit** the JSON in the Expected Output shape. There's no explicit session-release step — the session persists across calls keyed by `proxy`, so nothing needs to be torn down.

## Site-Specific Gotchas

- **Stealth + residential proxy is mandatory.** A bare `goto` and the plain fetch/`curl` path both return the Cloudflare `Just a moment...` managed challenge (the homepage returns HTTP 403 on direct fetch; even `/robots.txt` is challenged). A `browserless_agent` call with `proxy: { "proxy": "residential" }` clears it reliably. Always verify the page title before trusting any extracted content.
- **No free API path.** The official Product Hunt GraphQL API (`api.producthunt.com/v2/api/graphql`) needs an OAuth developer token — out of scope for an unauthenticated agent. Don't waste time trying the API or `fetch`; the browser is the only reliable surface.
- **Pricing is NOT on the leaderboard/homepage cards.** You _must_ open `/products/{slug}` and read the label before `Launch tags:`. This is the single biggest cost driver — budget ~2 turns per product and stop at 5–6 free hits.
- **`/llms.txt` is open and documents every leaderboard URL pattern.** `https://www.producthunt.com/llms.txt` (loads fine in the stealth session) gives the canonical paths: daily `/leaderboard/daily/{yyyy}/{m}/{d}`, weekly `/leaderboard/weekly/{yyyy}/{ww}` (ISO week), monthly `/leaderboard/monthly/{yyyy}/{mm}`, yearly `/leaderboard/yearly/{yyyy}`, products `/products/{slug}`, categories `/categories/{slug}`. It also states the attribution requirement: _"Data sourced from Product Hunt (https://www.producthunt.com/)"_.
- **Leaderboards are Pacific-time.** Build the dated daily URL from the current US/Pacific date, or you'll fetch the wrong (or an empty/future) day. The homepage "Top Products Launching Today" tracks the same day if you'd rather not compute the date.
- **`Promoted` sponsor rows** are interleaved into the list without a rank number — they are ads; skip them.
- **An `Interactive` tag can sit next to the pricing label** on the product page (e.g. `...InteractiveFree OptionsLaunch tags:...`). Anchor on the text _immediately before_ `Launch tags:` so you don't mistake `Interactive` (a demo flag) for a price.
- **Some products show no pricing label** (e.g. open-source dev tools like "Mellum by JetBrains" surfaced only `Launch tags:` with no preceding price). Treat as unknown and skip rather than guessing `free`.
- **Don't use `snapshot` for the list** — a `text`/`html` read of `body` (or an `evaluate` that parses the rendered rows) renders the ranked rows far more cleanly and cheaply than walking the accessibility tree.
- **Vote vs. comment count:** the two trailing integers per row are comment-count then vote-count; the larger one is votes. Votes are the better "worth sharing" signal.

## Expected Output

Validated 2026-06-20 (two consecutive runs converged on identical classifications). Vote counts are a snapshot — they climb during the day.

```json
{
  "success": true,
  "source": "https://www.producthunt.com/leaderboard/daily/2026/6/20",
  "date": "2026-06-20",
  "count": 6,
  "products": [
    {
      "rank": 1,
      "name": "WorkClaw",
      "tagline": "Collaborative, proactive AI coworkers who work in Slack",
      "url": "https://www.producthunt.com/products/workclaw",
      "topics": ["Productivity", "Artificial Intelligence", "Business"],
      "votes": 208,
      "pricing": "Free Options",
      "free": true
    },
    {
      "rank": 2,
      "name": "Reframe",
      "tagline": "Surf like it's 1999",
      "url": "https://www.producthunt.com/products/reframe-7",
      "topics": ["Open Source", "User Experience", "GitHub"],
      "votes": 149,
      "pricing": "Free",
      "free": true
    },
    {
      "rank": 3,
      "name": "Slackbot's MCP Client",
      "tagline": "Work across 20+ apps in Slack with multiplayer collaboration",
      "url": "https://www.producthunt.com/products/slack",
      "topics": ["Slack", "Task Management", "Artificial Intelligence"],
      "votes": 144,
      "pricing": "Free Options",
      "free": true
    },
    {
      "rank": 5,
      "name": "pumaDB",
      "tagline": "a small hosted memory layer for AI agents",
      "url": "https://www.producthunt.com/products/pumadb",
      "topics": ["Developer Tools", "Artificial Intelligence", "Database"],
      "votes": 120,
      "pricing": "Free",
      "free": true
    },
    {
      "rank": 6,
      "name": "Foyer",
      "tagline": "Build a room of ambient sound that lives in your notch",
      "url": "https://www.producthunt.com/products/foyer-4",
      "topics": ["Mac", "Productivity", "Music"],
      "votes": 101,
      "pricing": "Free Options",
      "free": true
    },
    {
      "rank": 7,
      "name": "Are you in the Weights?",
      "tagline": "Find out if you live forever in the brain of the LLMs",
      "url": "https://www.producthunt.com/products/are-you-in-the-weights",
      "topics": ["Artificial Intelligence", "Tech", "Games"],
      "votes": 100,
      "pricing": "Free",
      "free": true
    }
  ],
  "error_reasoning": null
}
```

Failure shape (Cloudflare wall not cleared, or fewer than 5 free products found that day):

```json
{
  "success": false,
  "source": "https://www.producthunt.com/leaderboard/daily/2026/6/20",
  "date": "2026-06-20",
  "count": 0,
  "products": [],
  "error_reasoning": "Stuck on Cloudflare 'Just a moment...' — browserless_agent call was missing the residential proxy."
}
```
