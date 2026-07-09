---
name: search-recent-jobs
title: LinkedIn Recent Jobs Search
description: >-
  Return LinkedIn job postings matching profile-derived keywords + location,
  filtered to a configurable recency window (default last 24 hours). Leads with
  the public /jobs-guest seeMoreJobPostings HTML-fragment endpoint — no cookies,
  no auth, no browser session required. Returns title, company, location,
  posted-when, jobId, and canonical job URL. Read-only.
website: linkedin.com
category: careers
tags:
  - linkedin
  - jobs
  - careers
  - search
  - read-only
source: 'browserbase: agent-runtime 2026-05-17'
updated: '2026-05-17'
recommended_method: api
alternative_methods:
  - method: browser
    rationale: >-
      Fallback only — the JS-rendered /jobs/search page requires
      stealth + a residential proxy to bypass the auth-wall modal, and costs
      30–100× the guest-API path. Use only if the guest endpoint is rate-limited
      or returns non-200 for sustained calls.
  - method: api
    rationale: >-
      /jobs/collections/recommended/ is the only LinkedIn surface that delivers
      truly profile-personalized recommendations, but it requires an
      authenticated cookie session (verified 302 to auth-wall when fetched
      anonymously). Out of scope for this anonymous skill — compose keywords
      from caller-supplied profile data instead.
verified: false
proxies: false
---

# LinkedIn — Search Recent Jobs Tailored to Profile

## Purpose

Return LinkedIn job postings that match a profile-derived role/keyword query in a given geography and were posted within a configurable recency window (default: last 24 hours). For each posting, return `jobId`, `title`, `company`, `location`, both relative ("6 hours ago") and absolute ISO date, and the canonical `/jobs/view/{slug}-{jobId}` URL.

**Read-only.** Never applies, never saves a job, never messages a poster.

"Tailored to my profile" means: the **caller** passes role/skill keywords distilled from the user's profile (current title, top skills, target seniority). LinkedIn's true personalized feed at `/jobs/collections/recommended/` requires an authenticated session (cookie-based) — confirmed 302-redirects to the auth wall when fetched anonymously. That logged-in path is intentionally out of scope here; this skill is the anonymous public-search surface that any agent can hit without credentials.

## When to Use

- A profile-aware job-monitoring agent wakes up every hour and asks "what was posted in the last 24h that matches this user's role + location?"
- A scheduled daily digest: "top 25 new jobs since yesterday for {role} in {city}."
- Cross-referencing a user's resume keywords against fresh postings without storing LinkedIn credentials anywhere.
- Anywhere you'd otherwise scrape `/jobs/search?...` HTML — the guest API is an order of magnitude cheaper and structurally cleaner.

## Workflow

LinkedIn exposes a **public guest-jobs API** that returns the job-card grid as an HTML fragment, anonymously, with no cookies, no auth, no anti-bot challenges in normal use. Lead with this API; the JS-rendered `/jobs/search` page is a fallback only.

### 1. Build the search URL

```
GET https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
    ?keywords={URL-encoded role+skills, e.g. "senior frontend engineer react typescript"}
    &location={URL-encoded location text, e.g. "San Francisco Bay Area"}
    &f_TPR=r86400
    &sortBy=DD
    &start=0
```

Recency-window mapping for `f_TPR`:

| `f_TPR` value | Window                                |
| ------------- | ------------------------------------- |
| `r3600`       | Last 1 hour                           |
| `r86400`      | Last 24 hours ← default for this task |
| `r604800`     | Last 7 days                           |
| `r2592000`    | Last 30 days                          |
| _(omitted)_   | All time (no recency filter)          |

`sortBy` accepts `DD` (most recent first) or `R` (relevance, default). For "last 24h tailored to profile" use `DD` so the freshest matches come first.

`location` accepts either free-text (`San Francisco Bay Area`, `New York, NY`, `Remote`) **or** a numeric `geoId` (e.g. `geoId=90000084` for SF Bay Area). Free text is fine for common metros; `geoId` is more deterministic when the same place name is ambiguous (Cambridge UK vs MA, Portland OR vs ME). Verified in iter-1 that both yield the same SF-scoped results.

### 2. Fetch + parse in one `browserless_agent` call (no proxy, no auth)

The guest endpoint returns an HTML fragment (~25–35 KB, **10 `<li>` job-card fragments**) with `Content-Type: text/html; charset=utf-8`. Navigate straight to it and parse the cards in-page — one call, no proxy, no cookies. `browserless_agent`:

```json
{
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=senior+frontend+engineer&location=San+Francisco+Bay+Area&f_TPR=r86400&sortBy=DD&start=0",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(() => { const clean = s => (s||'').replace(/\\s+/g,' ').trim(); const jobs = [...document.querySelectorAll('li')].map(li => { const urnEl = li.querySelector('[data-entity-urn]'); const urn = urnEl ? urnEl.getAttribute('data-entity-urn') : ''; const job_id = (urn.match(/urn:li:jobPosting:(\\d+)/)||[])[1]; const a = li.querySelector('a.base-card__full-link'); const url = a ? a.href.split('?')[0] : null; const t = li.querySelector('time'); return { job_id, title: clean(li.querySelector('.base-search-card__title')?.textContent), company: clean(li.querySelector('.base-search-card__subtitle a')?.textContent), location: clean(li.querySelector('.job-search-card__location')?.textContent), posted_iso: t ? t.getAttribute('datetime') : null, posted_relative: clean(t?.textContent), actively_hiring: !!li.querySelector('.job-posting-benefits'), url }; }).filter(j => j.job_id); return JSON.stringify({ count: jobs.length, jobs }); })()"
      }
    }
  ]
}
```

The `evaluate` result comes back under `.value` as a JSON string — parse it for the `jobs` array. It applies the same class/attribute extractors documented in step 3 (DOM queries in-page instead of regex over raw HTML) and strips tracking params off the canonical URL. No cookies, no `Referer`, no User-Agent spoofing, and no residential proxy are required — verified across 5 queries (SF Bay, NYC, geoId, special-char queries, last-hour filter) in iter-1.

### 3. Parse each `<li>` card

Each card is a self-contained `<li>...</li>` block. The robust extractors:

| Field             | Extractor                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `jobId`           | `data-entity-urn="urn:li:jobPosting:(\d+)"`                                                                        |
| `url` (canonical) | `<a class="base-card__full-link[^"]*" href="([^"]+)"` — drop everything after the first `?` for the canonical form |
| `title`           | `<h3 class="base-search-card__title">\s*([\s\S]*?)</h3>` — collapse whitespace                                     |
| `company`         | `<h4 class="base-search-card__subtitle">[\s\S]*?<a[^>]*>\s*([\s\S]*?)\s*</a>`                                      |
| `location`        | `<span class="job-search-card__location">\s*([\s\S]*?)</span>`                                                     |
| `posted_iso`      | `<time[^>]*datetime="([^"]+)"` — ISO date like `2026-05-17`                                                        |
| `posted_relative` | `<time[^>]*>([\s\S]*?)</time>` — e.g. `"6 hours ago"`, `"3 days ago"`                                              |
| `display_order`   | `data-row="(\d+)"` (1-indexed within the response)                                                                 |
| `actively_hiring` | presence of `<div class="job-posting-benefits text-sm">` and `"Actively Hiring"` text                              |

Title and company text are wrapped in heavy whitespace + multi-line indentation — always `.replace(/\s+/g,' ').trim()` after extracting.

The canonical URL pattern is:

```
https://www.linkedin.com/jobs/view/{kebab-slug-built-from-title-and-company}-{jobId}
```

The `href` in the page contains tracking params (`?position=N&pageNum=0&refId=...&trackingId=...`). For storage/dedup, **strip everything from `?` onwards** — the bare `/jobs/view/{slug}-{jobId}` resolves correctly and matches LinkedIn's canonical form.

### 4. Paginate

Page size is **10 results per response** (not 25). Increment `start` in steps of 10:

```
start=0  → first 10
start=10 → next 10
start=25 → cards 26–35 (any positive integer works, server pages-from-N)
```

Stop when a response returns < 10 cards or 0 cards. There is no `totalResultCount` field in this endpoint's response — you discover the end empirically. Typical agentic usage: pull `start=0` only (10 freshest jobs in the last 24h is usually enough for a daily digest).

### 5. (Optional) Enrich a specific posting

If the caller wants the full description for a single posting, the detail page is publicly accessible. Navigate to it and project the JSON-LD / `<title>` in-page rather than shipping ~300 KB of raw HTML back. `browserless_agent`:

```json
{
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.linkedin.com/jobs/view/{jobId}/",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(() => { const ld = [...document.querySelectorAll('script[type=\"application/ld+json\"]')].map(s => { try { return JSON.parse(s.textContent); } catch { return null; } }).find(o => o && o['@type'] === 'JobPosting'); return JSON.stringify({ title: document.title, company: ld?.hiringOrganization?.name || null, location: ld?.jobLocation?.address?.addressLocality || null, datePosted: ld?.datePosted || null, description: (ld?.description || '').replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim().slice(0, 4000) }); })()"
      }
    }
  ]
}
```

The detail page carries the posting in a standard `<title>` and a `JobPosting` JSON-LD block — parse those in the `evaluate` and truncate the description so the return stays under the result-size cap. Don't enrich every card in the digest — that's an N+1 cost spike for marginal value.

### Browser fallback (only if the guest API is rate-limited or broken)

If the guest API returns non-200 for sustained calls (none observed in iter-1, but document for completeness), fall back to a stealth + residential-proxy session driving the JS-rendered search page. Set `proxy` and run nav → settle → extract in one `browserless_agent` call:

```json
{
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.linkedin.com/jobs/search?keywords=senior%20frontend%20engineer&location=San%20Francisco%20Bay%20Area&f_TPR=r86400&sortBy=DD",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    { "method": "waitForTimeout", "params": { "time": 3000 } },
    {
      "method": "evaluate",
      "params": {
        "content": "(() => { const clean = s => (s||'').replace(/\\s+/g,' ').trim(); const jobs = [...document.querySelectorAll('li')].map(li => { const urnEl = li.querySelector('[data-entity-urn]'); const urn = urnEl ? urnEl.getAttribute('data-entity-urn') : ''; const job_id = (urn.match(/urn:li:jobPosting:(\\d+)/)||[])[1]; const a = li.querySelector('a.base-card__full-link'); const t = li.querySelector('time'); return { job_id, title: clean(li.querySelector('.base-search-card__title')?.textContent), company: clean(li.querySelector('.base-search-card__subtitle a')?.textContent), location: clean(li.querySelector('.job-search-card__location')?.textContent), posted_iso: t ? t.getAttribute('datetime') : null, posted_relative: clean(t?.textContent), actively_hiring: !!li.querySelector('.job-posting-benefits'), url: a ? a.href.split('?')[0] : null }; }).filter(j => j.job_id); return JSON.stringify({ count: jobs.length, jobs }); })()"
      }
    }
  ]
}
```

**Stealth + a residential proxy are mandatory on this path.** The browser-rendered `/jobs/search` page presents the LinkedIn auth wall (sign-in modal overlay) on a bare, un-proxied session, hiding the listings — the same DOM selectors from step 3 apply once the grid renders (confirm via a `snapshot` command if the cards are missing). With a residential proxy the page renders the same 10-card grid the guest API returns. Expect ~30–100× the cost of the API path due to JS render and proxy bandwidth — only use as a fallback. This whole flow runs in a single call; there is no separate release step — the session isn't destroyed on return but persists keyed by the call's `proxy`, so repeating the same `proxy` on a later call reconnects to it.

## Site-Specific Gotchas

- **The guest endpoint is the optimal surface — a single `browserless_agent` `goto` + `evaluate` is enough.** No cookies, no auth, no Referer header, no User-Agent spoofing, no residential proxy needed. The endpoint is `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search`. Lead with it; everything else is more expensive.
- **`/jobs/collections/recommended/` is the auth wall — don't try it anonymously.** Returns a `302` redirect with an empty body when fetched without cookies (verified iter-1). LinkedIn's true personalized recommendations require an authenticated session this skill intentionally does NOT carry. For "tailored," compose `keywords` from the caller's profile data instead.
- **Page size is 10, not 25.** Don't assume `&count=25` works — it's silently ignored. The response is structurally always ≤ 10 `<li>` cards. Paginate via `start=`.
- **There is NO `totalResultCount` in the guest response.** Discover end-of-results empirically: stop when a page returns < 10 cards or you hit your application's max.
- **The `<a class="base-card__full-link">` href is tracking-laden.** It includes `?position=N&pageNum=0&refId=...&trackingId=...` — strip everything from `?` onwards before storing. The bare `https://www.linkedin.com/jobs/view/{slug}-{jobId}` is the canonical form, dedups cleanly, and the slug is recoverable from the URL alone.
- **Two `<time>` class variants.** Cards posted recently (within ~3 days) carry `<time class="job-search-card__listdate--new" datetime="...">`; older cards carry `<time class="job-search-card__listdate" datetime="...">`. The `--new` suffix is purely a CSS hook — when matching, allow both via `class="job-search-card__listdate(?:--new)?"`. Both expose the same `datetime="YYYY-MM-DD"` and relative-time text-content.
- **`datetime` is date-only (no time-of-day).** The `<time datetime>` attribute is `YYYY-MM-DD`, not a full ISO 8601 timestamp. For sub-day precision (e.g. "5 minutes ago" vs "23 hours ago"), parse the relative-time text-content; for absolute-date queries, use the attribute.
- **Title/company/location are wrapped in heavy whitespace.** The HTML is server-rendered Tailwind with deeply nested indentation. Always `.replace(/\s+/g,' ').trim()` after each text extraction — otherwise you get strings like `"\n        Senior Frontend Engineer\n      "` in your output.
- **Title slugs can contain percent-encoded UTF-8.** e.g. `senior-software-engineer-frontend-ui-%E2%80%93-san-francisco-...` (an em-dash). When normalizing URLs for dedup, normalize percent-decoding or strictly keep the `jobId` numeric tail as the dedup key.
- **The endpoint is geo-permissive — `location` text drives scope, not the request IP.** Verified iter-1: the same query with `location=New+York` from a US-west session returns NYC jobs (`New York, NY`, `New York City Metropolitan Area`); changing to `location=San+Francisco+Bay+Area` flips the result set to SF metro. No `postal=` override is needed (unlike Craigslist's API which IS IP-scoped).
- **`geoId` is the deterministic alternative to free-text location.** When the location string is ambiguous or stable across runs, prefer `geoId={numeric}`. Common geoIds: `90000084` (San Francisco Bay Area), `90000070` (New York City Metropolitan Area), `103644278` (United States), `92000000` (Remote). Look up unknown geoIds by issuing a search with `location=<text>` first and inspecting the response URL or by hitting `https://www.linkedin.com/jobs-guest/api/typeaheadHits?query=<text>&typeaheadType=GEO`.
- **Special-char queries are accepted as-is.** Quoted phrases (`%22senior+react%22`) and required tokens (`%2Btypescript` → `+typescript`) work — verified iter-1 returned 6 narrower results vs 10 for the unquoted version. Don't strip user-supplied operators before passing to `keywords=`.
- **"Tailored to profile" via keywords composition.** Practical recipe when the caller has access to the user's LinkedIn profile data: concatenate `currentTitle + " " + top 3 skills + " " + seniorityWord`. Example: `keywords=senior+frontend+engineer+react+typescript+nextjs`. LinkedIn's `keywords` field tokenizes and matches across title + skills + description — heavier ranking on title matches.
- **Rate-limit behavior is undocumented and conservative.** Iter-1 issued ~10 requests in 90 seconds without throttling, but anecdotal reports place sustained throughput at ≤ 1 req/s. For a daily digest agent, the natural cadence is well under the limit; for aggressive backfills, add an explicit 1–2s delay between calls.
- **The JS-rendered `/jobs/search` page DOES present a sign-in wall on a bare browser session.** A plain session without a residential proxy renders an auth-wall modal that covers the listings. Use the guest API path (step 1–4) instead — that route bypasses the wall entirely because it's a different surface (`/jobs-guest/...`).
- **Sandbox-environment caveat (build-time, not skill-time):** The skill-build sandbox blocked live browser driving, so the `browserless_agent` browser-fallback path was not exercised in iter-1 — but the guest-API `goto` + `evaluate` path is fully exercised and is what the skill leads with. The browser-fallback section above is unvalidated in this sandbox but is documented based on the LinkedIn page surface behavior; agents running this skill in a non-restricted environment can use it.

## Expected Output

```json
{
  "success": true,
  "query": {
    "keywords": "senior frontend engineer react typescript",
    "location": "San Francisco Bay Area",
    "f_TPR": "r86400",
    "sortBy": "DD"
  },
  "page": { "start": 0, "size": 10 },
  "jobs": [
    {
      "job_id": "4304338796",
      "title": "Senior Frontend Engineer",
      "company": "Finix",
      "location": "San Francisco, CA",
      "posted_iso": "2026-05-17",
      "posted_relative": "6 hours ago",
      "actively_hiring": true,
      "url": "https://www.linkedin.com/jobs/view/senior-frontend-engineer-at-finix-4304338796"
    },
    {
      "job_id": "4373712261",
      "title": "Sr. Frontend Engineer",
      "company": "Arlo Technologies, Inc.",
      "location": "Milpitas, CA",
      "posted_iso": "2026-05-17",
      "posted_relative": "6 hours ago",
      "actively_hiring": false,
      "url": "https://www.linkedin.com/jobs/view/sr-frontend-engineer-at-arlo-technologies-inc-4373712261"
    }
  ],
  "error_reasoning": null
}
```

Outcome shapes:

```json
// Empty result — no postings matched in the recency window
{ "success": true, "jobs": [], "page": { "start": 0, "size": 10 }, "query": { ... }, "error_reasoning": null }

// Auth wall encountered (only possible if caller forced /jobs/collections/recommended/ or the browser-fallback path on a bare session)
{ "success": false, "error_reasoning": "auth_wall: /jobs/collections/recommended/ requires authenticated session; use keywords-based search instead" }

// Rate-limited (rare — 429 or sustained non-200 from the guest endpoint)
{ "success": false, "error_reasoning": "rate_limited: guest API returned <status> for <N> consecutive requests" }
```
