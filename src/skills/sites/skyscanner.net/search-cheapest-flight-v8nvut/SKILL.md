---
name: search-cheapest-flight
title: Skyscanner Cheapest Flight Search
description: >-
  Search Skyscanner for the cheapest one-way flight between two cities on a
  given date, returning price, airlines, depart/arrive times + airports,
  duration, stops, layovers, self-transfer flag, the 7-day nearby-date price
  strip, and the canonical Skyscanner config-URL deeplink that surfaces
  OTA/airline provider booking options. Read-only — never books.
website: skyscanner.net
category: travel
tags:
  - flights
  - travel
  - skyscanner
  - search
  - perimeterx
  - read-only
source: 'browserbase: agent-runtime 2026-05-19'
updated: '2026-05-19'
recommended_method: browser
alternative_methods:
  - method: browser
    rationale: >-
      Skyscanner has no public/free flight-search HTTP API. The site's internal
      XHR endpoints are gated behind PerimeterX cookies and not exposed in
      server-rendered HTML. A plain HTTP fetch (the old a direct HTTP fetch, or
      a residential-proxied `browserless_function`) returns 200 OK on Skyscanner
      pages but the HTML is a SPA shell — only the searchParams are
      server-rendered, never the flight itineraries. Driving the .com TLD with
      `browserless_agent` + residential proxy is the only path that surfaces
      results.
verified: true
proxies: true
---

# Skyscanner Cheapest Flight Search — Browser Skill

## Purpose

Given an origin city, destination, and departure date, return the cheapest one-way flight Skyscanner has for that route on that day — total price, airline(s), depart/arrive times + airports, total duration, stop count + layover airports, and the canonical Skyscanner "config" deeplink that surfaces OTA/airline provider booking options. Read-only; never clicks "Continue to provider" / "Book".

## When to Use

- One-shot "what's the cheapest flight from X to Y on date D?" queries.
- Daily monitoring of headline cheapest-fare prices across multiple routes.
- Price-band discovery — the search results page also exposes a 7-day price strip (e.g. "Jun 12 $247, Jun 13 $281, ..."), useful for "is my date cheaper than ±3 days".
- Anywhere a human would otherwise scroll through Skyscanner results just to copy the top "Cheapest" card.

## Workflow

Skyscanner is **heavily protected by PerimeterX** ("Are you a person or a robot?" / Press & Hold). There is no public/free flight-search HTTP API (the JS bundle's XHR endpoints are gated behind PerimeterX cookies; reverse-engineering them is significantly more expensive than driving the browser). The recommended path is a `browserless_agent` run with residential proxy, on the `.com` TLD, with a homepage warmup.

**Keep the whole flow in one call.** A `browserless_agent` session persists across calls (keyed by the call's `proxy` config), but the cleanest way to guarantee the PerimeterX cookies earned by the warmup carry through to the results and config pages is to run the entire flow — homepage warmup → navigate to search → sort → extract → capture config URL — inside a **single call's `commands` array**, with no chance of dropping the proxy config between steps. Set `proxy: { proxy: "residential" }` (optionally `proxyCountry: "us"`) as a top-level arg on that call, and repeat it on any follow-up call so you reconnect to the same session rather than a fresh, unwarmed one. A bare `browserless_agent` with no proxy hits PerimeterX on the first request.

### 1. Residential proxy, `.com` TLD only

Invoke `browserless_agent` with `proxy: { proxy: "residential" }` and put every step below into that one call's `commands` array. Residential proxy is mandatory — plain stealth without it hits PerimeterX immediately.

### 2. Homepage warmup (CRITICAL)

First commands in the array:

```json
{ "method": "goto", "params": { "url": "https://www.skyscanner.com/", "waitUntil": "load", "timeout": 45000 } }
{ "method": "waitForTimeout", "params": { "time": 8000 } }
{ "method": "evaluate", "params": { "content": "(()=>location.href)()" } }
```

If the URL after wait (the `evaluate` `.value`) contains `/sttc/px/captcha-v2/`, this session is walled — **start a fresh `browserless_agent` call**; there is no recovering it. Do **not** try to click the "Press & Hold" button (see gotchas). Roughly 1 in 3 fresh residential-proxy sessions bypass PerimeterX cleanly on the `.com` homepage; the rest get walled and stay walled. Plan for retries with fresh calls.

Once the homepage loads, a login modal appears — dismiss it:

```json
{ "method": "snapshot" }
{ "method": "click", "params": { "selector": "<close-button selector; a11y label \"Close\" / \"Close modal\">" } }
{ "method": "waitForTimeout", "params": { "time": 3000 } }
```

### 3. Navigate to the search URL

```json
// URL shape: /transport/flights/{origin-iata-or-metro}/{dest-iata-or-metro}/{YYMMDD}/?adultsv2=1&cabinclass=economy&rtn=0&preferdirects=false&ref=home
{ "method": "goto", "params": { "url": "https://www.skyscanner.com/transport/flights/lond/del/260615/?adultsv2=1&cabinclass=economy&childrenv2=&ref=home&rtn=0&preferdirects=false", "waitUntil": "load", "timeout": 45000 } }
{ "method": "waitForTimeout", "params": { "time": 15000 } }   // live polling completes in 10–25s
{ "method": "evaluate", "params": { "content": "(()=>location.href)()" } }   // verify not redirected to captcha
```

`lond` is the Skyscanner metro code for London (all airports: LHR/LGW/STN/LTN/LCY/SEN). `del` is Delhi (DEL). Use IATA airport codes for single-airport queries (`lhr`, `jfk`, etc.) or metro codes for "any airport in city" (`lond`, `nyca`, `chia`, `parl`, `tyoa`). The 6-digit date slug is `YYMMDD` (2026-06-15 → `260615`).

Common modal interruptions after `wait timeout 15000`:

- **"Flexible on your dates?"** popover — has a Close button in the snapshot; dismiss it.
- **"Skyscanner never takes a cut"** interstitial — appears on the provider/config page (step 6); has a Close button or a "Continue" button.

### 4. Switch to "Cheapest" sort

The default sort is **"Best"** (Skyscanner's price/duration blend) and it puts a sponsored card at the top — the actual cheapest result is rarely first. Click the **Cheapest** tab button (text label: `"Cheapest <Xh Ym>"` where `<Xh Ym>` is the lead cheapest duration):

```json
{ "method": "snapshot" }   // find the element labeled "Cheapest 32 hours 55 minutes" or similar
{ "method": "click", "params": { "selector": "<Cheapest-tab selector>" } }
{ "method": "waitForTimeout", "params": { "time": 3000 } }
```

### 5. Read the cheapest itinerary card

Skyscanner renders each itinerary as an a11y `link` with **verbose human-readable text**. Read it with an `evaluate` that projects the card text (or a `snapshot` — the a11y tree carries the same strings), rather than reading visible pixels. Look for the first non-sponsored card after switching to Cheapest. Card text format:

```
Flight option N: Total cost $XXX. Flight with <Airline1>[, <Airline2>]. Departing from <Origin> at <HH:MM AM/PM>, arriving in <Destination> at <HH:MM AM/PM>[, N days later]. <Direct|Indirect> flight taking Xh YYm[ with one stop in <City>][. You need to change airports in <City>]. Carry-on bag info {known|unknown}. Checked bag info {known|unknown}. Prices include taxes and charges.
```

Regex-extract from the StaticText:

- Price: `Total cost \$([0-9,]+)`
- Airlines: `Flight with ([^.]+)\.`
- Depart: `Departing from ([^ ]+(?: [^ ]+)*) at (\d{1,2}:\d{2} [AP]M)`
- Arrive: `arriving in (.+?) at (\d{1,2}:\d{2} [AP]M)(?:, (\d+) days? later)?`
- Duration: `taking (\d+) hours? (\d+) minutes?`
- Stops: `(Direct|Indirect) flight` + `with (one|two|three) stops? in ([^.]+)`
- Self-transfer flag: presence of `You need to change airports` OR `Self-transfer`

**Sponsored cards have the StaticText `Sponsored by <Airline>`** in the heading — skip them when extracting the "headline cheapest" even though they appear in position 1.

### 6. Capture the provider deeplink (canonical config URL)

Click the **"Select"** button on the cheapest itinerary's card. The browser navigates to a deterministic config URL:

```
https://www.skyscanner.com/transport/flights/{orig}/{dest}/{YYMMDD}/config/{itinerary-key}?adultsv2=1&cabinclass=economy&childrenv2=&ref=home&rtn=0&preferdirects=false
```

The `{itinerary-key}` encodes the full itinerary, e.g. `16574-2606151540--32570,-32213-1-10957-2606170505`:

- `16574` — first carrier ID (Skyscanner internal)
- `2606151540` — depart timestamp (YYMMDDhhmm: Jun 15 2026 15:40)
- `-32570,-32213` — flight number tokens (negative = carrier-encoded)
- `1` — number of stops
- `10957` — layover airport ID
- `2606170505` — arrival timestamp (Jun 17 2026 05:05)

```json
{ "method": "click", "params": { "selector": "<Select-button selector on the cheapest card>" } }
{ "method": "waitForTimeout", "params": { "time": 8000 } }
{ "method": "evaluate", "params": { "content": "(()=>location.href)()" } }   // capture the config URL — THIS IS THE "PROVIDER LINK"
```

**Critical**: the config page is significantly more aggressively walled by PerimeterX than the search-results page — about 70% of sessions that survived through step 5 get walled on step 6. Read the config URL via an `evaluate` returning `location.href` **immediately** after the navigation command; the URL itself is the canonical provider-selection deeplink that a human (or a downstream fresh `browserless_agent` call) can open to see the OTA/airline price list.

If the page does render on the config URL (rare), the provider list appears as a series of cards: `<Provider> $X — Select`. Common providers seen for LON→DEL: Trip.com, Kiwi.com, MyTrip, Mytrip.com, Etihad direct, Emirates direct, British Airways direct, Air India direct. **Do not** click "Continue to <provider>" — that starts the booking flow.

Because everything runs inside one `browserless_agent` call, there is no session-release step — nothing to release. (The session itself persists across calls, keyed by the `proxy` config, rather than dying on return.)

## Site-Specific Gotchas

- **READ-ONLY.** Never click "Continue to <provider>" or "Book" on the config page — that initiates the booking flow.
- **PerimeterX is the dominant blocker.** Verified across 4 iterations: 2 of 4 fresh residential-proxy sessions made it past PerimeterX on the `.com` homepage; the other 2 were walled immediately and stayed walled. There is no known way to recover a walled session — abandon it and start a fresh `browserless_agent` call.
- **`.com` is the only TLD that works under US-egress proxies.** `.net` (Skyscanner's primary brand domain) hits PerimeterX on **every** request. `.co.uk` was tested once — also walled. The US `.com` site is the most permissive entry point.
- **Don't try to solve the captcha — it's terminal here.** The PerimeterX "Press & Hold" challenge requires a true 4–5 second `mousedown` event; a `click` command emits a single press-release, and the `browserless_agent` `solve` command has no PerimeterX Press&Hold handler — so `solve` can't clear it. The accessible-challenge button (small icon to the left of "Press & Hold") also failed to clear the wall in testing. Detect via URL pattern `/sttc/px/captcha-v2/` and abandon the session (start a fresh call).
- **A plain HTTP fetch (residential-proxied) returns 200 on Skyscanner pages — but the HTML is a SPA shell.** The initial server-rendered HTML contains only `window["__internal"] = { searchParams: {...} }` (the query, never the results). Flight data is loaded entirely client-side via XHR endpoints that are not referenced in the HTML and require PerimeterX cookies. Plain-HTTP scraping (a `browserless_function` fetch, or any raw client) is **not** a viable shortcut for results extraction.
- **`window["__internal"]` is JS, not JSON.** If you do parse the embedded shell config for the searchParams (e.g. to read the resolved `originEntityId`/`destinationEntityId`), strip `undefined` literals before `JSON.parse` (`s.replace(/:\s*undefined\b/g, ":null")`) — they're not legal JSON.
- **Default sort is "Best", and "Best" puts a sponsored card in position 1.** Always click the **Cheapest** tab before extracting the headline cheapest. The lead-card widget at the top of the results page also exposes Cheapest's headline duration without sorting (e.g. `"Cheapest 32 hours 55 minutes"`), useful for a quick price+duration peek without clicking through.
- **Currency is locked by the TLD + egress IP geo**. On `.com` from a US-egress proxy, currency is USD and cannot be changed via URL param — `&currency=GBP` is silently ignored. For GBP pricing you need a UK egress proxy on `.net` (which is more aggressively walled). Document the currency in the output.
- **"Self-transfer" itineraries are the cheapest tier on LON→DEL.** The cheapest result observed (2026-06-15) was a $278 self-transfer via Istanbul on AJet + IndiGo, requiring an airport change in Istanbul (32h 55m total). The cheapest *direct* would have cost ~$436 (10h 31m, sorted as "Best"). Always preserve the `self_transfer` flag in the output — it's a critical UX caveat (passenger must collect bags + re-check in at the layover).
- **Sponsored cards show `Sponsored by <Airline>` in the card heading.** Skip them when finding the "headline cheapest". They appear regardless of sort tab.
- **Modal interruptions** that block snapshot reads:
  - "Flexible on your dates?" — pops up over results ~1–3s after `load`.
  - "Skyscanner never takes a cut" — interstitial on the config page.
  - Login modal on the homepage.
    All have an unambiguous Close button in the snapshot tree.
- **Live polling**: the results page polls multiple providers and re-sorts as new prices arrive. Always let the `goto` (`waitUntil: "load"`) settle, then a `waitForTimeout` of 15000ms, before reading the cards. Reading too early returns a partial result set.
- **`waitUntil: "load"` returns fast — within ~1s** after the page-load event fires. The 15s `waitForTimeout` after it is doing the actual work of waiting for the XHR-driven result polling to complete.
- **The config URL is stable and shareable.** A user (or another agent on a fresh session) can open the canonical `/config/{itinerary-key}` URL directly to see the provider list — no session state required. The itinerary-key is the authoritative reference for that specific itinerary.
- **The config page is more heavily walled than the search results page.** Even sessions that breezed past PerimeterX on the homepage + results page often get walled when navigating to `/config/`. Read the URL via an `evaluate` returning `location.href` _immediately_ after the post-Select navigation — don't wait for a `snapshot` to fail.
- **Metro codes**: `lond` (London all), `nyca` (New York all), `chia` (Chicago all), `lax` (Los Angeles all is `laxa`), `parl` (Paris all), `tyoa` (Tokyo all). For single-airport, use the IATA code lowercased (`lhr`, `jfk`, `cdg`). The site will redirect single-airport codes to the right URL.
- **Confirmed dead ends — don't try these**:
  - PerimeterX captcha solving via a `click` on the Press & Hold button, or the `solve` command — does nothing (no Press&Hold handler).
  - `m.skyscanner.net` (mobile) — also fully behind PerimeterX.
  - `skyscanner.com/g/conductor/v1/fps3/search/` direct HTTP — endpoint exists but rejects unauthenticated requests.
  - Reading flight results from the initial server-rendered HTML — only search params, never itineraries.

## Expected Output

```json
{
  "success": true,
  "query": {
    "origin": "LON",
    "origin_label": "London (Any)",
    "destination": "DEL",
    "destination_label": "New Delhi (DEL)",
    "depart_date": "2026-06-15",
    "trip_type": "one-way",
    "cabin_class": "economy",
    "adults": 1
  },
  "cheapest": {
    "price": 278,
    "currency": "USD",
    "airlines": ["AJet", "IndiGo"],
    "depart_airport": "STN",
    "depart_airport_label": "London Stansted",
    "depart_time_local": "15:40",
    "arrive_airport": "DEL",
    "arrive_airport_label": "Delhi Indira Gandhi International",
    "arrive_time_local": "05:05",
    "arrive_day_offset": 2,
    "duration_minutes": 1975,
    "stops": 1,
    "layover_cities": ["Istanbul"],
    "self_transfer": true,
    "self_transfer_note": "You need to change airports in Istanbul",
    "config_url": "https://www.skyscanner.com/transport/flights/lond/del/260615/config/16574-2606151540--32570,-32213-1-10957-2606170505?adultsv2=1&cabinclass=economy&childrenv2=&ref=home&rtn=0&preferdirects=false"
  },
  "lead_card_summary": {
    "best": { "price": 436, "duration_minutes": 615 },
    "cheapest": { "price": 278, "duration_minutes": 1975 },
    "fastest": { "price": 783, "duration_minutes": 510 }
  },
  "price_strip_nearby_dates": [
    { "date": "2026-06-12", "price": 247, "is_low": true },
    { "date": "2026-06-13", "price": 281 },
    { "date": "2026-06-14", "price": 261 },
    { "date": "2026-06-15", "price": 278, "selected": true },
    { "date": "2026-06-16", "price": 255 },
    { "date": "2026-06-17", "price": 247, "is_low": true },
    { "date": "2026-06-18", "price": 265 }
  ],
  "total_results": 382,
  "error_reasoning": null
}
```

Failure shapes:

```json
// PerimeterX wall on homepage (session dead — retry with a fresh session)
{ "success": false, "reason": "anti_bot_wall_homepage", "url": "https://www.skyscanner.com/sttc/px/captcha-v2/...", "error_reasoning": "..." }

// PerimeterX wall on results or config page (results captured up to wall)
{ "success": false, "reason": "anti_bot_wall_search" | "anti_bot_wall_config", "partial": { ...whatever was captured... } }

// Zero matching itineraries
{ "success": false, "reason": "no_flights", "query": { ... } }
```
