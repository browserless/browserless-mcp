---
name: find-fifa-tickets
title: FIFA World Cup 2026 Schedule & Lowest Ticket Prices (US & Canada)
description: >-
  Scrape SeatGeek's full FIFA World Cup 2026 match schedule and return US +
  Canada host-city matches as JSON (matchup, stage, date, time, venue, city,
  lowest_price), sorted by cheapest ticket price.
website: seatgeek.com
category: tickets
tags:
  - tickets
  - sports
  - soccer
  - fifa-world-cup
  - seatgeek
  - schedule
source: 'browserbase: agent-runtime 2026-06-10'
updated: '2026-06-10'
recommended_method: fetch
alternative_methods:
  - method: browser
    rationale: >-
      When a plain fetch is blocked, load the page in a browserless_agent call
      with a residential proxy (DataDome present) and evaluate
      document.getElementById('__NEXT_DATA__').textContent — same JSON, same
      parse.
  - method: api
    rationale: >-
      A lighter Next.js data endpoint exists — GET
      /_next/data/{buildId}/performer-tickets.json?slug=fifa-world-cup (2MB
      JSON, no HTML) — but buildId rotates on every deploy and must first be
      read from the page's __NEXT_DATA__, so it is not standalone-stable. Use it
      only when you already have a fresh buildId.
verified: true
proxies: true
---

# FIFA World Cup 2026 Schedule & Lowest Ticket Prices (US & Canada)

## Purpose

Return the full FIFA World Cup 2026 match schedule from SeatGeek, filtered to the **US and Canada host cities only**, as a JSON array where each object is `{ matchup, stage, date, time, venue, city, lowest_price }`, sorted by `lowest_price` ascending. The entire 104-match dataset (teams, venue, city, country, kickoff datetime, and a live lowest ticket price per match) is server-rendered into the landing page's `__NEXT_DATA__` blob, so this is a **single HTTP fetch + JSON parse** — no clicking, scrolling, or per-event navigation. Read-only; never adds to cart or checks out.

## When to Use

- Building a World Cup 2026 price tracker / "cheapest matches" leaderboard for US + Canada venues.
- Pulling the complete fixture list (matchup, stage, date/time, venue, city) for the 91 non-Mexico matches in one shot.
- Monitoring lowest_price drift per match over time (the value is live SeatGeek inventory).
- Anywhere you'd otherwise scrape SeatGeek's infinite-scroll match list — the embedded JSON is faster, complete, and avoids the DataDome-protected UI entirely.

## Workflow

**Recommended method: load the landing page and parse `__NEXT_DATA__`.** One page load returns all 104 matches inside the `__NEXT_DATA__` blob. A residential proxy is required (SeatGeek fronts everything with DataDome — see Gotchas). Run it as a single `browserless_agent` call with the top-level `proxy: { proxy: "residential" }`: `goto` the landing page, then `evaluate` the blob out of the DOM — no clicking, scrolling, or per-event navigation.

1. **Load the landing page** through a residential proxy:

   ```json
   {
     "method": "goto",
     "params": {
       "url": "https://seatgeek.com/fifa-world-cup-tickets",
       "waitUntil": "load",
       "timeout": 45000
     }
   }
   ```

   The page renders straight to HTML with all data inline (~4MB); an un-proxied request gets a DataDome 403.

2. **Extract the embedded JSON in-page.** Read and parse the `__NEXT_DATA__` blob inside an `evaluate` command so you return only a compact projection, never the raw ~4MB payload (the text return is size-capped). The value comes back under `.value`:

   ```json
   {
     "method": "evaluate",
     "params": {
       "content": "(()=>{ const d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent); return JSON.stringify(d.props.pageProps.worldCupAllEvents2026); })()"
     }
   }
   ```

   The full schedule lives at `props.pageProps.worldCupAllEvents2026` — an array of **104** SeatGeek event objects. (`props.pageProps.allEvents` is only the first paginated page of 25 — do **not** use it; use `worldCupAllEvents2026` for the complete set.)

3. **Map each event** to the output shape:
   - **matchup** — the two `performers[]` entries with `type === "international_soccer"` whose `name` does **not** start with `"World Cup"`; join their `short_name` (e.g. `"Cape Verde"`, `"Saudi Arabia"`) with `" vs "`. Knockout-round events carry no team performers — instead pull the bracket placeholder from `title` via regex `-\s*([0-9A-Z]+ vs [0-9A-Z]+)\s*-` (e.g. `"2E vs 2I"`, `"W97 vs W98"`). Third Place and the Final have no placeholder at all → emit `"TBD"`.
   - **stage** — the `performers[]` entry whose name matches `World Cup (Group Stage|Round of N|Quarterfinals|Semifinals|Third Place|Final)`, with the leading `"World Cup "` stripped → `"Group Stage"`, `"Round of 32"`, `"Final"`, etc.
   - **date** / **time** — `datetime_local` (local-to-venue), split into `YYYY-MM-DD` (chars 0–10) and `HH:MM` (chars 11–16).
   - **venue** — `venue.name`. **city** — `venue.city` (the precise municipality, always present, e.g. `"Inglewood"`, `"East Rutherford"`).
   - **lowest_price** — `stats.lowest_price` (a plain number in USD; equals the UI "From $X" price).

4. **Filter** to `venue.country` ∈ `{"US", "Canada"}` (drops the 13 Mexico matches). **Sort** by `lowest_price` ascending. Expect **91 rows** (78 US + 13 Canada).

### Browser fallback

The recommended path is already a `browserless_agent` call, so if the landing page is ever slow to hydrate, the same call handles it — just add a short wait before the `evaluate`:

1. `goto` the landing page with `proxy: { proxy: "residential" }`. The page itself loads without a DataDome interstitial (title → `"World Cup Tickets 2026 ... SeatGeek"`).
2. `{ "method": "waitForTimeout", "params": { "time": 3000 } }` to let the blob settle.
3. Read the blob with an `evaluate` on `document.getElementById('__NEXT_DATA__').textContent` — **do not** use the `snapshot` command (returns 0 a11y refs on this page). The return value comes back under `.value`; parse and project inside the eval, don't ship raw text.
4. Parse and map exactly as in steps 3–4 above.

## Site-Specific Gotchas

- **DataDome on every entry point.** The pre-run homepage probe returned `403 / datadome`. A residential proxy (`proxy: { proxy: "residential" }` on the `browserless_agent` call) is mandatory; bare requests get a DataDome 403. The FIFA landing page itself does **not** present a captcha/interstitial once you're proxied — it renders straight to HTML with all data inline.
- **Use `worldCupAllEvents2026`, not `allEvents`.** `pageProps.allEvents` is only the first 25 (paginated UI page); `pageProps.worldCupAllEvents2026` is the complete 104. `pageProps.totalEvents` is `104` and is a good sanity check.
- **`country` is the literal string `"US"`** (not `"USA"` / `"United States"`); Canada is `"Canada"`, Mexico is `"Mexico"`. Filtering on `{"US","Canada"}` yields exactly 91 of the 104 matches.
- **`stats.lowest_price` is live and is the displayed "From $X".** It matches the UI to the dollar at fetch time and drifts a few dollars between fetches as inventory turns over (observed e.g. $223 vs $221, $774 vs $804 minutes apart). It can be `null` if a match momentarily has zero listings — treat null as "no price" and sort it last. All 91 had a price during testing (range ~$171 group-stage to ~$7,869 Final).
- **city vs host-city label.** `venue.city` is the precise municipality (Inglewood, East Rutherford, Foxborough, Santa Clara, Arlington, Miami Gardens…). The FIFA marketing host-city name (Los Angeles, New York, Boston, San Francisco, Dallas, Miami…) is in `venue.marquee_city`, but that field is **null for roughly half** the venues (Toronto, Vancouver, Houston, Philadelphia, Atlanta, Seattle…), so prefer `venue.city` for a field that's always populated.
- **Knockout matchups are placeholders, not teams.** Round-of-32 through Semifinals encode bracket slots in the title (`"2E vs 2I"`, `"W97 vs W98"`); the Third-Place match and the Final have no placeholder. These are genuinely TBD until the bracket fills — emit the placeholder where present, else `"TBD"`.
- **Don't drive the visible list.** The on-page match list is an infinite-scroll React component; scraping it row-by-row needs scrolling + reflows and gives strictly less data than the JSON. The `snapshot` command returns 0 refs on this page. Always read `__NEXT_DATA__`.
- **Lighter JSON endpoint exists but isn't standalone-stable.** `GET /_next/data/{buildId}/performer-tickets.json?slug=fifa-world-cup` returns the same `pageProps` as a 2MB JSON document (no HTML). Confirmed working, but `buildId` rotates on every SeatGeek deploy and must first be read from a live page's `__NEXT_DATA__` (`buildId` field), so it's only a useful shortcut once you already hold a fresh buildId — otherwise just parse the page HTML.

## Expected Output

A JSON array sorted by `lowest_price` ascending. 91 objects (78 US + 13 Canada). Shapes:

```json
[
  {
    "matchup": "Cape Verde vs Saudi Arabia",
    "stage": "Group Stage",
    "date": "2026-06-26",
    "time": "19:00",
    "venue": "Reliant Stadium",
    "city": "Houston",
    "lowest_price": 171
  },
  {
    "matchup": "2E vs 2I",
    "stage": "Round of 32",
    "date": "2026-06-30",
    "time": "12:00",
    "venue": "AT&T Stadium",
    "city": "Arlington",
    "lowest_price": 552
  },
  {
    "matchup": "W97 vs W98",
    "stage": "Semifinals",
    "date": "2026-07-14",
    "time": "15:00",
    "venue": "AT&T Stadium",
    "city": "Arlington",
    "lowest_price": 2510
  },
  {
    "matchup": "TBD",
    "stage": "Final",
    "date": "2026-07-19",
    "time": "15:00",
    "venue": "MetLife Stadium",
    "city": "East Rutherford",
    "lowest_price": 7869
  }
]
```

Field notes:

- `matchup` — `"<Team A> vs <Team B>"` for group stage (short names); bracket placeholder (`"2E vs 2I"`, `"W97 vs W98"`) for Round of 32 → Semifinals; `"TBD"` for Third Place and Final.
- `stage` — one of `"Group Stage"`, `"Round of 32"`, `"Round of 16"`, `"Quarterfinals"`, `"Semifinals"`, `"Third Place"`, `"Final"`.
- `date` `YYYY-MM-DD`, `time` `HH:MM` (24h, local to venue).
- `lowest_price` — number (USD); may be `null` if a match has no active listings (sort last).
