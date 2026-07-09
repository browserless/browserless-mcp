---
name: explore-nearby-attractions
title: Wanderboat AI Nearby Attractions
description: >-
  Discover top-rated nearby attractions on Wanderboat AI by IP-geolocated
  proximity or by specifying any city worldwide. Returns ranked places with
  name, rating, review count, opening hours, and AI-curated commentary.
  Read-only.
website: wanderboat.ai
category: travel
tags:
  - travel
  - attractions
  - discovery
  - places
  - ai-search
  - read-only
  - cloudflare
source: 'browserbase: agent-runtime 2026-05-28'
updated: '2026-05-28'
recommended_method: browser
alternative_methods:
  - method: browser
    rationale: >-
      Wanderboat has no documented public API and the page is fully JS-rendered.
      The `/chat` UI is the only reliable surface — bare HTTP fetches return a
      Cloudflare managed challenge.
  - method: fetch
    rationale: >-
      Pre-rendered static listicle pages at
      `/listicle/{city-slug}/attractions/{nanoid}` exist and are discoverable
      via the public sitemap, but the slug→nanoid mapping is not exposed by any
      documented endpoint, so they're only useful for bulk crawl jobs where
      you've already harvested the sitemap — not for interactive city-by-name
      queries.
verified: true
proxies: true
---

# Wanderboat AI — Explore Nearby Attractions

## Purpose

Given an optional destination (city name or "nearby"/no-input → IP-located) and optional vibe filter (outdoors, coffee, late-night, cocktails, etc.), return a ranked list of attractions with name, rating, review count, opening hours, a short AI-generated summary, and (when available) Google-style place metadata. Read-only — never books, never submits a reservation. Wanderboat's homepage redirects to `/chat`, which is the AI-powered search/discovery surface; this skill drives that surface.

## When to Use

- "Show me top attractions in {city}" — generic discovery for any city worldwide.
- "What's good to do nearby?" — IP-geolocated quick-look for the current location.
- Vibe-scoped local discovery: outdoors, coffee, late-night bites, kid-friendly, etc.
- Comparing top attractions between two cities (run twice with different destinations).
- Any flow needing photo-rich attraction cards with embedded user reviews and AI-curated commentary that mainstream Google/Yelp APIs don't surface.

## Workflow

Wanderboat is Cloudflare-protected (managed challenge + Turnstile). A bare HTTP fetch of any page below `/sitemaps/*` or `/robots.txt` returns the CF challenge HTML — everything else **must** run through a `browserless_agent` call with `proxy: { proxy: "residential" }` and a `solve` for the Cloudflare challenge. The site has no documented public API; the only reliable surface is the JS-rendered `/chat` interface. Keep the full interaction (open `/chat` → send a query → read results) inside ONE `browserless_agent` call's `commands` array — it saves round-trips and avoids accidentally dropping the session config. The browser session persists across separate calls (keyed by `proxy`/`profile`), so a follow-up call carrying the same `proxy` reconnects to the same warmed browser with the conversation intact.

### 1. Open `/chat` — the main discovery surface

Every call sets `proxy: { proxy: "residential" }` (without a residential IP the Cloudflare challenge HTML at `/cdn-cgi/challenge-platform/` is served instead of the app). Clear the challenge with a `solve` command, then let the Mapbox + Discover panel render:

```json
{
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://wanderboat.ai/",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    { "method": "solve", "params": { "type": "cloudflare" } },
    { "method": "waitForTimeout", "params": { "time": 3000 } },
    { "method": "snapshot" }
  ]
}
```

`https://wanderboat.ai/` redirects to `/chat`.

The chat page has three usable affordances for "explore attractions":

| Affordance                                                            | Snapshot ref pattern                  | Purpose                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `textbox: Enter your destination` (top-left header)                   | `textbox: Enter your destination`     | Hard-set destination context — placeholder shows your IP-located city (e.g. "Hermiston") |
| `textbox: input-textarea` (center chat box)                           | `textbox: input-textarea`             | Free-form natural-language query — the canonical surface                                 |
| `button: Find me a good hike nearby` etc. (right-side Discover panel) | `button: <prompt-text> <prompt-text>` | Pre-baked quick-action seeds, IP-located                                                 |

### 2. Choose the right path

All of these are additional `commands` appended to the same call after the step-1 `snapshot`. Match affordances by visible label, not by a snapshot ref number (refs are dynamic).

**Path A — IP-located "nearby" via quick-action button (fastest, 1 click):**

```json
[
  {
    "method": "click",
    "params": { "selector": "<selector-or-label for the quick-action>" }
  },
  { "method": "waitForTimeout", "params": { "time": 12000 } }
]
```

Click the quick-action whose label matches the vibe (observed: "Find me a good hike nearby", "I need a coffee break, what's close?", "Take me to the latest events", "I want to get outside today", "Find me a cool cocktail spot", "I need places that kids will enjoy"). AI generation takes ~8–12s; the URL flips to `/chat/cov_<nanoid>`. Confirm the target via `snapshot` if the label match misses.

**Path B — Specific city via custom query (most flexible):**

```json
[
  {
    "method": "type",
    "params": {
      "selector": "<selector for input-textarea>",
      "text": "Show me top attractions in Paris"
    }
  },
  { "method": "waitForTimeout", "params": { "time": 1500 } },
  { "method": "click", "params": { "selector": "<selector for send-button>" } },
  { "method": "waitForTimeout", "params": { "time": 15000 } }
]
```

Typing into `input-textarea` does NOT auto-submit — you must `click` the send-button (label `send-button`) separately. The "Search" button next to it (with magnifying-glass icon) triggers the `@`-mention place-picker instead of submitting; do not click it for free-form queries (see Gotchas).

**Path C — Set destination first, then query:**

```json
[
  {
    "method": "type",
    "params": {
      "selector": "<selector for the Enter-your-destination textbox>",
      "text": "Tokyo"
    }
  }
]
```

Use the top-of-page destination textbox to lock context, then proceed with Path A or B in the same call. The destination textbox persists across queries within the one session.

### 3. Extract attractions from the conversation page

After the query fires (Path A/B/C), the URL flips to `https://wanderboat.ai/chat/cov_{nanoid}` and the layout is:

- **Center column**: AI commentary paragraph + per-attraction cards in narrative order. Each card has `StaticText: <name>`, `StaticText: <rating>`, `StaticText: (<review-count>)`, `StaticText: Open until <time>` or `Closed`, a reviews carousel, an AI summary paragraph mentioning hours and seasonality, and a post-count footer (`<N> posts`).
- **Right sidebar `Places` panel** — _this is the cleanest structured data source_. Toggle between `tab: List` and `tab: Map`. The `List` tab exposes one `listitem` per attraction with predictable nesting:
  ```
  listitem
    image: <attraction-name>
    paragraph → StaticText: <attraction-name>
    paragraph → StaticText: <rating>      (e.g. "4.5")
    paragraph → StaticText: (<n_reviews>) (e.g. "(248)")
    StaticText: Open until <HH:MM AM|PM> | Open 24 hours | Closed
    StaticText: Click for details
  ```
- **Top tabs**: `Attractions <N>` / `Events <N>` — switching tabs changes the body content but keeps the same chat URL.

Prefer extracting from the `Places` sidebar `listitem`s. The center column's text is richer but cards are deeply nested with reviews/videos mixed in, and parsing order is fragile.

To get all results: the sidebar is virtualized — only ~5–6 items render before a `Load more` boundary. Scroll the sidebar's `scrollable, div` until the `<N>` count matches the `Attractions <N>` tab badge.

### 4. (Optional) Switch to Map tab for coordinates

Append to the same call:

```json
[
  { "method": "click", "params": { "selector": "<selector for tab: Map>" } },
  { "method": "waitForTimeout", "params": { "time": 2000 } },
  { "method": "snapshot" }
]
```

The Map view exposes `image: Map marker` refs per attraction but **does not expose lat/lng in the a11y tree** — only DOM-level marker positions. If you need coordinates, click a marker → details panel opens with the address, then geocode externally.

No session-release step is needed — there is nothing to release. The session persists across calls keyed by `proxy`/`profile`, so keeping the whole open → query → extract flow in one call is a convenience (fewer round-trips, no risk of dropping the session config), not a lifetime requirement — a follow-up call carrying the same `proxy` reconnects to the same warmed browser.

## Site-Specific Gotchas

- **Cloudflare-protected, residential proxy + solve mandatory.** A plain HTTP fetch of `https://wanderboat.ai/` returns the `_cf_chl_opt` challenge HTML. Only a `browserless_agent` call with `proxy: { proxy: "residential" }` plus a `solve { type: "cloudflare" }` command clears it. `robots.txt` and `sitemap.xml` are fetchable bare (CDN-cached), but the app HTML is not.
- **`/` → `/chat` 302 redirect** happens on first navigation; don't assume the post-`goto` URL matches what you sent. Read it back (`evaluate` `location.href`) to confirm.
- **IP-geolocation drives "nearby" defaults.** The destination placeholder, the Discover panel cards, and any quick-action labelled "nearby"/"close" use the request's source-IP city, NOT the `Where to` textbox's placeholder string. A residential proxy's exit IP determines the default locale (with a US exit expect a low-population locale — useful for testing but not realistic). To target a specific city, **always type the city into the chat textarea** (Path B) or set the destination textbox (Path C); do not rely on the proxy IP being where you want. Pin the exit region with `proxyCountry` if it matters.
- **"Search places" button is a place-picker, not a submit.** The button with magnifying-glass icon next to the chat input (label `Search`, ref-pattern `button: Search`) inserts `@` into the input and opens a dropdown of nearby Google places (logos + addresses) — it is the `@-mention` affordance, not a query submitter. The actual submit is `button: send-button` (paper-airplane icon). Verified: clicking `Search` after a blank input opened a `dialog` of 10 nearby places (McDonald's, Denny's, etc.) — not what you want for an attractions search.
- **Quick-action labels are dynamic and personalized.** Observed labels in one session: `Find me a good hike nearby`, `I need a coffee break, what's close?`, `Take me to the latest events`, `I want to get outside today`, `Find me a cool cocktail spot`, `I need places that kids will enjoy`, plus event-specific items like `*FREE* Healthy Cooking on a Budget`, `Babysitting Basics Course (Ages 10-15)`. Don't pin to a label — match by intent keywords (`outside`, `hike`, `coffee`, `cocktail`) when matching by string.
- **Conversations are sticky to the session.** Subsequent sends within the same `browserless_agent` call append to the same `/chat/cov_{nanoid}` URL — they do NOT create a new conversation. To start a fresh thread, open a new `browserless_agent` call and navigate to `https://wanderboat.ai/chat` afresh. Multi-query test verified: a Paris query sent after a Hermiston "outside today" quick-action both landed in `cov_XPPGLGUaWXo86hxkynUxL9` with the Paris response appended below.
- **AI generation delay is variable.** Quick-action (cached-prompt) responses: 8–12s. Custom natural-language queries: 10–18s. Cross-region cities (Paris from a US proxy): occasionally up to 20s. A `waitForTimeout` of 15000 is a safe default for Path B.
- **The `Attractions <N>` / `Events <N>` tab badges are the source of truth for result count.** The sidebar virtualizes — only the top 5–6 items render until you scroll. Don't assume the visible sidebar list is complete; cross-check against the tab badge.
- **Map tab exposes markers without names or coordinates in the a11y tree** — only the List tab gives you structured attraction data. If you need lat/lng, you'll have to either parse the DOM `data-*` attributes via an `evaluate` or geocode externally.
- **Static listicle pages exist but require a slug+nanoid.** Sitemaps surface URLs like `https://wanderboat.ai/listicle/{city-slug}/attractions/{nanoid}` and `https://wanderboat.ai/localities/{country}/{slug}/{nanoid}` — these are pre-rendered city-attraction pages, indexed for SEO. They're potentially a faster deep-link path _if_ you already know the slug + nanoid for a target city; but there's no documented slug→nanoid lookup endpoint, so for ad-hoc queries the `/chat` flow is the only practical surface. The sitemap index lists ~5 locality + ~5 listicle shards (`locality_1.xml` through `locality_5.xml`, etc.) — useful for bulk discovery but not for interactive querying.
- **`robots.txt` disallows `/chat?` (with query string), `/chat/`, and `/posts?*` — but allows bare `/chat`.** Honor this. Our flow uses `/chat` and the dynamic `/chat/cov_{nanoid}` — the latter is what `/chat/` disallows for crawlers, so don't curl those URLs out-of-band; interact only through the browser session.
- **No GraphQL/REST endpoints observed in the page snapshot to bypass the UI.** A network trace would reveal the backend (`/api/...`) but as a policy we don't reverse-engineer undocumented private APIs — drive the UI.
- **"Closed" vs "Open until X" is real-time and timezone-localized.** The open-hours strings reflect the moment the AI generated the response, in the target city's local time. Don't cache them — they go stale within hours.
- **No login required, no captcha walls past Cloudflare.** A single session can run an arbitrary number of queries; only rate-limiting concern is the AI generation throughput on Wanderboat's side.

## Expected Output

```json
{
  "query": "I want to get outside today",
  "destination": "Hermiston, OR (IP-located)",
  "conversation_url": "https://wanderboat.ai/chat/cov_XPPGLGUaWXo86hxkynUxL9",
  "result_kind": "attractions",
  "result_count": 20,
  "event_count": 3,
  "ai_commentary": "If you want to get outside in Hermiston today, these are the cleanest bets for a little fresh-air glory. It's Thursday morning, and all of these picks fit the outdoor brief nicely—no indoor detours, no drama.",
  "attractions": [
    {
      "name": "Riverfront Park",
      "rating": 4.5,
      "review_count": 248,
      "open_status": "Open until 10:00 PM",
      "hours_summary": "6 a.m.–10 p.m.",
      "best_seasons": ["spring", "summer", "fall"],
      "post_count": 20,
      "ai_summary": "Riverfront Park is the easygoing pick for a classic outdoor reset: open lawns, river vibes, and a solid 6 a.m.–10 p.m. window today."
    },
    {
      "name": "Hat Rock State Park",
      "rating": 4.5,
      "review_count": 274,
      "open_status": "Open until 9:00 PM",
      "hours_summary": "7 AM–9 PM",
      "best_seasons": ["spring", "summer", "fall"],
      "post_count": 21,
      "ai_summary": "Hat Rock State Park brings the bigger scenery energy, with that state-park feel and a 7 AM–9 PM schedule today."
    }
  ]
}
```

Alternative outcome shapes:

```json
// City-specific query (Path B), international destination
{
  "query": "Show me top attractions in Paris",
  "destination": "Paris",
  "conversation_url": "https://wanderboat.ai/chat/cov_XPPGLGUaWXo86hxkynUxL9",
  "result_kind": "attractions",
  "ai_commentary": "Paris is serving the big-ticket classics today — the kind of spots that make your camera roll look slightly smug...",
  "attractions": [
    { "name": "Eiffel Tower", "rating": 4.7, "review_count": 136900, "open_status": "Open until 11:00 PM", "post_count": 82, "likes": "6.2M" }
  ]
}

// Empty / no-results outcome (when AI cannot find direct matches)
{
  "query": "find outdoor events today",
  "destination": "Hermiston, OR (IP-located)",
  "conversation_url": "https://wanderboat.ai/chat/cov_XPPGLGUaWXo86hxkynUxL9",
  "result_kind": "events",
  "result_count": 0,
  "ai_commentary": "I couldn't find any exact outdoor events in Hermiston that match your request... but here are a few nearby outdoor happenings that still fit the fresh-air vibe.",
  "fallback_results": [
    { "name": "Yakima Federal LIVE@5 - Summer Concert Series", "starts": "2026-05-28T17:00Z", "ends": "2026-05-28T23:59Z", "city": "Richland" }
  ]
}
```
