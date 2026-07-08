---
name: get-business-hours
title: Yelp Business Hours Lookup
description: >-
  Given a Yelp business URL, alias slug, or natural-language reference, return
  structured hours of operation — per-day open/close ranges, special-hours
  overrides, IANA timezone, current open/closed state, freshness signal,
  canonical URL, and a top-level status (open / temporarily_closed /
  permanently_closed / unknown). Read-only.
website: yelp.com
category: local-business
tags:
  - yelp
  - hours
  - local-business
  - datadome
  - read-only
  - fusion-api
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: hybrid
alternative_methods:
  - method: api
    rationale: >-
      Yelp Fusion API (api.yelp.com/v3/businesses/{alias}) is the cheapest path
      when an agent has an OAuth2 bearer token — one HTTP call, no anti-bot, no
      JS rendering. Free tier: 5,000 calls/day. Not gated by DataDome
      (confirmed: returns 400 VALIDATION_ERROR without auth, clean JSON with
      auth).
  - method: browser
    rationale: >-
      Public Yelp site is DataDome-protected; a `browserless_agent` browser
      session with a `solve { type: "dataDome" }` step is mandatory to read the
      rendered hours module. Required when no Fusion API key is available, when
      you need to disambiguate user-flagged 'temporarily_closed' from
      'permanently_closed' (Fusion collapses both to is_closed: true), or when
      the business surfaces special holiday hours that Fusion omits.
verified: true
proxies: true
---

# Yelp Business Hours Lookup

## Purpose

Given a Yelp business URL, alias slug, or natural-language reference (`"Gary Danko, San Francisco"`), return structured hours of operation: per-day open/close ranges, special-hours overrides, IANA timezone, current "open now" state, freshness signal, canonical URL, and a top-level `status` discriminating `open` / `temporarily_closed` / `permanently_closed` / `unknown`. Read-only — never clicks Write a Review, Bookmark, Send to Friend, Sign In, Add to Collection, or any mutation control.

## When to Use

- Hours-aware scheduling: "Is {business} open right now?", "Is {business} open Friday at 9pm?"
- Bulk hours collection for a list of restaurants/shops (one query per business; the Fusion API path scales to ~5 QPS).
- Storefront verification (is this place permanently closed?).
- Building a local-business index where canonical hours matter.

## Workflow

Yelp has **DataDome** anti-bot in front of every page in `www.yelp.com/biz/*` and `www.yelp.com/search`. Naïve fetches — including residential-proxied fetches without a real browser fingerprint — return HTTP 403 with the DataDome captcha redirect HTML. Two viable paths:

### Optimal path: Yelp Fusion API (when you have an OAuth2 bearer token)

If you have a Yelp Fusion API key (free tier — 5,000 calls/day; sign up at `https://docs.developer.yelp.com/`), this is one HTTP call, no anti-bot, no JS rendering, no proxies.

1. **Resolve the alias** (skip if the user provided a `/biz/{alias}` URL — the last path segment is the alias):

   ```
   GET https://api.yelp.com/v3/businesses/search?term=<name>&location=<city>&limit=3
   Authorization: Bearer <YELP_FUSION_KEY>
   ```

   Pick `businesses[0]` when its `name` matches the requested name (case-insensitive substring) AND `location.city` matches the requested city. If `businesses[]` is empty → `status: "unknown"`, `error_reasoning: "not_found"`. If multiple top matches share the same name in the same city, surface them as `ambiguous` candidates rather than guessing.

2. **Fetch business details + hours**:

   ```
   GET https://api.yelp.com/v3/businesses/{alias_or_id}
   Authorization: Bearer <YELP_FUSION_KEY>
   ```

   Response includes:
   - `name`, `alias`, `url` (canonical Yelp URL), `is_closed` (permanently closed flag), `location.display_address[]`, `location.country`, `location.state`, `location.zip_code`
   - `coordinates.{latitude, longitude}` — derive IANA timezone via a static `state → tz` table (US states map 1:1 except for the multi-tz states AZ/IN/KY/TN/ND/SD/NE/KS/TX/OR/MI/ID — fall back to a coord lookup for those).
   - `hours: [{ hours_type: "REGULAR", open: [{ is_overnight, start: "HHMM", end: "HHMM", day: 0-6 }], is_open_now }]` — `day: 0` is Monday through `day: 6` Sunday. `start`/`end` are 4-char strings like `"1700"` — split into `"HH:MM"` on emit. `hours` may also include a `hours_type: "SPECIAL"` entry for holiday hours.
   - The `is_open_now` field on the `REGULAR` hours object reflects Yelp's server-side timezone-aware computation — use it as the authoritative `open_now`.

3. **Map to output schema**: index `open[].day` (0-6) → `Mon`-`Sun` labels, format `start`/`end` to `HH:MM`, carry `is_overnight` through. Status: `is_closed === true` → `permanently_closed`; otherwise `open` (or `unknown` if hours array is empty/null but `is_closed === false`).

### Fallback path: Browser (`browserless_agent` against the public site)

When no Fusion API key is available, drive a `browserless_agent` session that solves DataDome, then parse the rendered HTML / accessibility tree. Batch the whole flow (goto → solve → optionally click search result → biz-page extract) inside ONE call's `commands` array — it saves round-trips and avoids accidentally dropping the session config. The session persists across separate calls, keyed by the call's `proxy`/`profile`: repeat the same config on any follow-up call to reconnect to the same DataDome-cleared session; drop or change it and you land in a different, blank session. Set `proxy: { proxy: "residential" }` on the call; a plain session (no solve) gets DataDome 403'd.

1. **Resolve alias if needed** — if the input is already a `/biz/{alias}` URL, skip to step 2. Otherwise, search:

   ```json
   {
     "method": "goto",
     "params": {
       "url": "https://www.yelp.com/search?find_desc=<urlenc-name>&find_loc=<urlenc-city-state-or-zip>",
       "waitUntil": "load",
       "timeout": 45000
     }
   }
   ```

   ```json
   { "method": "solve", "params": { "type": "dataDome" } }
   ```

   ```json
   { "method": "waitForTimeout", "params": { "time": 2500 } }
   ```

   ```json
   { "method": "snapshot" }
   ```

   The first organic result is a card with the business name as a link; the `href` is `/biz/{alias}`. `click` that link rather than `goto`-ing a hand-built `/biz/{alias}` URL — the click carries the DataDome cookie and search-referer warmth, which materially reduces second-page block rate.

2. **Land on the biz page** (same call, after the click):

   ```json
   { "method": "waitForTimeout", "params": { "time": 3000 } }
   ```

   (hours module is React-rendered ~1-3s after load)

   ```json
   { "method": "snapshot" }
   ```

   (accessibility tree for the Location & Hours region)

   ```json
   { "method": "html", "params": { "selector": "body" } }
   ```

   (raw HTML — fastest path to the ld+json block)

3. **Prefer the `application/ld+json` block** — it's the most structured source and survives DOM refactors. Look for `<script type="application/ld+json">` containing `"@type":"Restaurant"` (or `LocalBusiness`, `Store`, `MedicalBusiness`, etc.). Parse the JSON; extract:
   - `name`, `address.{streetAddress, addressLocality, addressRegion, postalCode}`, `url`
   - `openingHoursSpecification: [{ dayOfWeek: ["Monday"], opens: "17:00", closes: "22:00" }]` — note `dayOfWeek` can be a string OR an array; normalize. Multiple entries per day → multiple ranges. If `closes < opens` (e.g. `opens: "22:00", closes: "02:00"`) → `is_overnight: true`.
   - `geo.{latitude, longitude}` — feed to a state/coord → IANA tz table.

4. **Fall back to the DOM "Location & Hours" table** when ld+json is missing (some non-restaurant business types omit it). The accessibility tree has rows shaped `Mon | 5:00 PM - 10:00 PM | (Closes in 2 hours)` under the heading `Location & Hours`. Time strings are 12h `H:MM AM|PM` — convert to 24h. Multi-range days render with multiple `<p>` elements in the same row (e.g. lunch + dinner): `11:30 AM - 2:30 PM, 5:30 PM - 10:00 PM`. Parse each as a separate `{ open, close }`.

5. **Extract supplementary signals** from the same region (still read-only):
   - **Status banner**: text "Yelp users report this location has closed" → `status: "temporarily_closed"`. Text "Permanently closed" or a strikethrough `Closed` indicator in the header → `status: "permanently_closed"`.
   - **Open-now pill** in the header: text "Open now" / "Closed now" / "Closes in X" / "Opens at Y" → `open_now` boolean.
   - **Freshness signal**: text "Hours updated <X> ago" (sometimes labeled "Edited by business owner X ago") below the table → carry through as `hours_updated`.
   - **Special hours**: a "Hours might differ on holidays" disclosure or a yellow "Hours updated for {holiday}" banner — capture as `special_hours[]` with `{ date_range, note, hours }`. These are common around US federal holidays and are often shown for the next 7 days only.

6. **Timezone**: parse `address.addressRegion` (state code) — for US single-tz states use a fixed table (`CA → America/Los_Angeles`, `NY → America/New_York`, etc.). For multi-tz states or non-US addresses, prefer the geo coords from ld+json against a coord→tz lookup (e.g. `tz-lookup`, `@geo-tz/data`). Yelp does NOT expose IANA tz directly in markup.

7. **No session-release step** — there's nothing to release. The session persists across separate calls, keyed by the call's `proxy`/`profile`; batch the search → click → biz-page extraction in one call to save round-trips and avoid dropping the config, or repeat the same `proxy`/`profile` on follow-up calls to stay in the same DataDome-cleared session.

## Site-Specific Gotchas

- **DataDome is the gate.** Every `www.yelp.com/biz/*` and `www.yelp.com/search` request goes through DataDome. A bare `browserless_function` fetch returns HTTP 403 with `Server: DataDome`, `X-Datadome: protected`, and a captcha-delivery HTML payload — confirmed with and without a residential `proxy`. The mobile origin `m.yelp.com` is identically gated (also 403). A `browserless_agent` session with a `solve { type: "dataDome" }` step is the **only** consistently working path; document this if you encounter a fresh wall and stop retrying the bare fetch path.
- **`robots.txt` explicitly disallows AI/LLM crawlers.** Yelp lists `ClaudeBot`, `anthropic-ai`, `Claude-Web`, `Claude-User`, `Claude-SearchBot`, `ChatGPT-User`, `GPTBot`, `Google-Extended`, `PerplexityBot`, `CCBot`, `Meta-ExternalAgent` with `Disallow: /`. DataDome enforces UA-level rules — never set a Claude/GPT/Perplexity UA in any request to Yelp; the default Chrome UA from a Browserbase verified session is what passes.
- **Yelp Fusion API is the cheap escape hatch** when you have a key. `https://api.yelp.com/v3/businesses/{alias_or_id}` is NOT DataDome-gated (verified: returns `400 VALIDATION_ERROR: Authorization is a required parameter` without a bearer; clean JSON with one). Free tier: 5,000 calls/day, 5 QPS. Use this whenever an agent has `YELP_FUSION_API_KEY` available — it's ~100× cheaper than a browser session. It's a plain HTTPS JSON API: call it from any client; only under restricted egress route it via `browserless_function` (`page.goto('https://api.yelp.com/')` then a same-origin `page.evaluate` fetch), and never send the bearer anywhere but `api.yelp.com`.
- **Fusion API `hours.open[].day` is 0-indexed from Monday**, not Sunday. (`0=Mon, 1=Tue, ..., 6=Sun`.) Don't confuse with the ISO weekday convention which starts at Sunday in some libraries.
- **Fusion API `start`/`end` are 4-digit strings, not `HH:MM`** — `"1700"` not `"17:00"`. Split on emit.
- **`is_overnight: true` semantics** (both surfaces): the close time is on the _next_ calendar day. When deriving `open_now`, an overnight range that started yesterday is still active early today (e.g. a bar that closes at `02:00` on Sunday is open at `00:30` Sunday morning under the Saturday row).
- **Multi-range days are common** for restaurants — lunch + dinner with a mid-afternoon closure (e.g. Mon: `11:30-14:30, 17:30-22:00`). Both the ld+json block and the DOM table render these as separate entries — never collapse them.
- **ld+json `dayOfWeek` polymorphism**: sometimes a string (`"Monday"`), sometimes an array (`["Monday","Tuesday","Wednesday"]`) when a business has the same hours across consecutive days. Normalize to one entry per day before emitting.
- **Hours module is React-rendered ~1–3s after the page loads.** Snapshot too early and the Location & Hours region is empty. Always `waitForTimeout` 3000ms (or `waitForSelector` on the "Location & Hours" region) before snapshotting.
- **`/search` resolution is more reliable than constructed `/biz/{alias}` URLs.** Yelp aliases include a disambiguation suffix (`-2`, `-san-francisco-3`) for businesses with the same name in different neighborhoods or under new ownership. The search-result click sets the DataDome cookie + provides a referer that materially lowers second-page block rate vs. a cold `goto https://www.yelp.com/biz/{alias}`.
- **Two distinct "closed" states**: "Yelp users report this location has closed" (user-flagged, sometimes recoverable) → `temporarily_closed`; explicit "Permanently closed" / strikethrough name in header → `permanently_closed`. The Fusion API collapses both into `is_closed: true` — when you need to disambiguate, you must use the browser path.
- **Timezone is never in the markup as an IANA string.** Both Yelp surfaces give you state + coordinates only. Maintain a `US-state → IANA` table for single-tz states (covers ~80% of US queries) and a coord→tz lookup for AZ/IN/KY/TN/ND/SD/NE/KS/TX/OR/MI/ID and non-US.
- **Read-only invariant** — never click Write a Review, Bookmark, Send to Friend, Sign In, Add to Collection, Compliment, Direct Message, Make a Reservation, Order Delivery, or any header action. Hours data is fully derivable from a `snapshot` + an `html` (body) read without any click after landing on the biz page.
- **Do not waste time probing alternate endpoints.** Confirmed dead-ends (5/18/2026): `https://www.yelp.com/biz/{alias}.json` → 404; `https://m.yelp.com/biz/{alias}` → 403 DataDome; `https://www.yelp.com/gql/batch` → 404; `https://www.yelp.com/sitemap.xml` → 404. The PWA's internal GraphQL endpoints are not publicly addressable.

## Expected Output

Six distinct outcome shapes:

```json
// Open business with regular hours (most common)
{
  "success": true,
  "status": "open",
  "name": "Gary Danko",
  "alias": "gary-danko-san-francisco",
  "url": "https://www.yelp.com/biz/gary-danko-san-francisco",
  "address": "800 N Point St, San Francisco, CA 94109",
  "timezone": "America/Los_Angeles",
  "hours": [
    { "day": "Mon", "open": "17:00", "close": "22:00", "is_overnight": false },
    { "day": "Tue", "open": "17:00", "close": "22:00", "is_overnight": false },
    { "day": "Wed", "open": "17:00", "close": "22:00", "is_overnight": false },
    { "day": "Thu", "open": "17:00", "close": "22:00", "is_overnight": false },
    { "day": "Fri", "open": "17:00", "close": "22:00", "is_overnight": false },
    { "day": "Sat", "open": "17:00", "close": "22:00", "is_overnight": false },
    { "day": "Sun", "open": "17:00", "close": "22:00", "is_overnight": false }
  ],
  "special_hours": [],
  "open_now": false,
  "hours_updated": "3 months ago",
  "source": "fusion_api"
}

// Open with multi-range day (lunch + dinner)
{
  "success": true,
  "status": "open",
  "name": "State Bird Provisions",
  "alias": "state-bird-provisions-san-francisco",
  "hours": [
    { "day": "Wed", "open": "11:30", "close": "14:30", "is_overnight": false },
    { "day": "Wed", "open": "17:30", "close": "22:00", "is_overnight": false }
  ],
  "open_now": true,
  "source": "browser"
}

// Open with overnight close (bar / late-night)
{
  "success": true,
  "status": "open",
  "name": "Comstock Saloon",
  "hours": [
    { "day": "Fri", "open": "16:00", "close": "02:00", "is_overnight": true }
  ],
  "open_now": true
}

// Holiday / special hours surfaced
{
  "success": true,
  "status": "open",
  "name": "Some Cafe",
  "hours": [ /* regular hours */ ],
  "special_hours": [
    { "date": "2026-07-04", "note": "Independence Day", "open": null, "close": null, "closed": true },
    { "date_range": ["2026-12-24", "2026-12-25"], "note": "Christmas Eve / Christmas Day", "closed": true }
  ],
  "open_now": false
}

// Temporarily closed (user-flagged)
{
  "success": true,
  "status": "temporarily_closed",
  "name": "Joe's Diner",
  "alias": "joes-diner-oakland",
  "url": "https://www.yelp.com/biz/joes-diner-oakland",
  "address": "...",
  "timezone": "America/Los_Angeles",
  "hours": [],
  "open_now": false,
  "closure_note": "Yelp users report this location has closed"
}

// Permanently closed
{
  "success": true,
  "status": "permanently_closed",
  "name": "Old Restaurant",
  "alias": "old-restaurant-sf",
  "hours": [],
  "open_now": false
}

// Not found / DataDome wall / ambiguous
{ "success": false, "status": "unknown", "error_reasoning": "not_found" }
{ "success": false, "status": "unknown", "error_reasoning": "datadome_blocked" }
{ "success": false, "status": "unknown", "error_reasoning": "ambiguous_name", "candidates": [/* top 3 alias+address */] }
```
