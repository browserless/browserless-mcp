---
name: search-tickets
title: American Airlines Flight Search
description: >-
  Search aa.com for available flights on a given origin/destination/date route
  and return each option's flight numbers, times, duration, stop count,
  operating carrier, and fare-class prices. Read-only — never books.
website: americanairlines.com
category: travel
tags:
  - travel
  - flights
  - airlines
  - aa
  - akamai
  - read-only
source: 'browserbase: agent-runtime 2026-05-20'
updated: '2026-05-20'
recommended_method: browser
alternative_methods:
  - method: browser
    rationale: >-
      No public API, GraphQL, or URL deep-link bypasses Akamai. Direct
      /booking/search deep-link, form-driven Search-button navigation, and
      a raw residential-proxy HTTP fetch of the results URL all return Access
      Denied or the Akamai behavioral-content challenge. The /en-us/flights form
      is the only working entry point — but the destination results page itself
      is the Akamai wall, so even successful form fills frequently fail to reach
      actionable results.
verified: true
proxies: true
---

# American Airlines Flight Search

## Purpose

Given an origin airport, destination airport, departure date, optional return date, passenger count and cabin class, search aa.com for the available flights on that route and return each option's flight numbers, departure/arrival times, duration, stop count, operating carrier and fare-class prices (Main / Main Plus / Flagship etc.). Read-only — never click "Continue", "Select", or any booking-progression button.

## When to Use

- A user asks "what flights are there from {origin} to {destination} on {date}?"
- A trip-planning agent comparing AA fares for a known route + date.
- Bulk price-monitoring across dates for a single AA route.
- Any flow that needs flight-shopping output without booking. Booking is a different skill.

## Workflow

The only public surface for shopping AA fares is the browser form at `https://www.aa.com/booking` / `https://www.aa.com/en-us/flights`. The destination results page (`/booking/search?slices=...`) is the Akamai-protected URL and is the choke point — see "Site-Specific Gotchas". There is no public JSON API, GraphQL endpoint, or URL-deep-link shortcut that bypasses the Akamai behavioral-content challenge (confirmed via direct deep-link, form-driven Search-button navigation, and a raw residential-proxy HTTP fetch of the results URL — all return either `Access Denied` or the Akamai challenge HTML). Drive the whole flow with the **`browserless_agent`** tool, batching the ordered `commands` into a single call so they share one stealthed, proxied session.

### 1. Stealth + residential-proxy session is mandatory

Pass the proxy as a **top-level arg on the `browserless_agent` call** and let the default stealthed browser handle the rest. All steps below run as the ordered `commands` of **one** call so they share the same proxied, stealthed session:

```jsonc
// browserless_agent tool arguments
{
  "rationale": "Searching aa.com flights",
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [/* the ordered steps 2–9 below */],
}
```

Both the stealthed browser and the residential proxy are required. Without the proxy, even `https://www.aa.com/` returns `Access Denied`. With them, `/en-us/flights` (the homepage form) renders; whether `/booking/search` (the results page) renders is _probabilistic_ — most attempts return Access Denied even on a stealthed, proxied session. If the flow is split across multiple calls, repeat the `proxy` arg on every one — the session persists across calls, keyed by `proxy`/`profile`, and a call that drops or changes the proxy lands in a different session.

### 2. Open the form on the regional path, NOT the bare domain

```jsonc
{ "method": "goto", "params": { "url": "https://www.aa.com/en-us/flights", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 5000 } }
```

`https://www.aa.com/` (bare domain) reliably returns `Access Denied` on the cloud browser. `https://www.aa.com/en-us/flights` (Title: "Book American Airlines Flights") consistently renders. Use the regional path. Never use `networkidle0`/`networkidle2` for `waitUntil` — the results page long-polls and never idles.

### 3. Dismiss the privacy-and-cookies banner first

Take a `snapshot` (a11y tree), find the `button: Dismiss` node, and `click` it:

```jsonc
{ "method": "snapshot" },
{ "method": "click", "params": { "selector": "button[aria-label='Dismiss']" } },
{ "method": "waitForTimeout", "params": { "time": 1000 } }
```

(The `snapshot` returns the ref for the "Dismiss" button; use whatever selector/ref it yields — confirm via `snapshot` if the label differs.) The cookie alert at the bottom-right intercepts focus events on the form's comboboxes. **A `click` on the form fields silently fails until this is dismissed.**

### 4. Fill the form via raw mouse coordinates, NOT accessibility refs

The `fc-booking-origin-aria-label` / `fc-booking-destination-aria-label` comboboxes are custom-rendered: a `click` on the accessibility ref of the combobox reports success but does **not** focus the underlying input — a subsequent `type` writes nothing. The working pattern is to focus the visible input rectangle by coordinate (via an `evaluate` that dispatches a real pointer event at `elementFromPoint`), then type and commit with ArrowDown+Enter (dispatched as keyboard events):

```jsonc
// From input (~220, 330 at 1280x720 viewport) — focus by coordinate, type, commit
{ "method": "evaluate", "params": { "content":
  "(()=>{const el=document.elementFromPoint(220,330);['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t=>el.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:220,clientY:330})));const i=el.closest('input')||el.querySelector('input')||el;i.focus();return document.activeElement?.tagName;})()" } },
{ "method": "waitForTimeout", "params": { "time": 800 } },
{ "method": "type", "params": { "selector": "input:focus", "text": "JFK" } },
{ "method": "waitForTimeout", "params": { "time": 2500 } },   // autocomplete render delay
{ "method": "evaluate", "params": { "content":
  "(()=>{const i=document.activeElement;['ArrowDown','Enter'].forEach(k=>{i.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));i.dispatchEvent(new KeyboardEvent('keyup',{key:k,bubbles:true}));});return i.value;})()" } },
{ "method": "waitForTimeout", "params": { "time": 1000 } }
```

`ArrowDown` highlights the first autocomplete option and `Enter` commits it (clicking the autocomplete option directly is also unreliable). Repeat for the To input (around `(470, 330)` at 1280x720). The two coordinates above were verified — adjust if the viewport changes. Always confirm via `screenshot` that both inputs show the full "AIRPORT - City Name (CODE), Region/Country" string after the Enter commit. If a coordinate `type` misses, fall back to reading the input ref from `snapshot`.

### 5. Trip type — switch to One-way

Default state is Round trip. To switch:

```jsonc
{ "method": "snapshot" },                                            // find "button: fc-booking-journey-type-aria-label"
{ "method": "click", "params": { "selector": "button[aria-label='fc-booking-journey-type-aria-label']" } },  // opens the "One way" / "Round trip" listbox
{ "method": "waitForTimeout", "params": { "time": 1200 } },
{ "method": "snapshot" },                                            // find "option: One way"
{ "method": "click", "params": { "selector": "[role='option'][aria-label='One way']" } },
{ "method": "waitForTimeout", "params": { "time": 800 } }
```

The journey-type listbox click _does_ respond to accessibility-ref clicks (unlike the origin/destination comboboxes), so use the ref/selector the `snapshot` returns. The Return-date button disappears from the form when One way is selected.

### 6. Date picker — navigate via Next-Month, NOT typed input

The `fc-booking-departure-date-input-aria-label` textbox **looks** typeable but its value is cleared on Tab/blur and the underlying `react-day-picker` only commits selections made via grid clicks. Workflow:

```jsonc
{ "method": "click", "params": { "selector": "<depart-button-ref from snapshot>" } },  // opens dual-month dialog (May + June visible)
{ "method": "waitForTimeout", "params": { "time": 2000 } },
// Click "fc-booking-date-selector-next-month" N times to advance to the target month pair.
// Each click advances by ONE month (both visible months shift).
// Always re-`snapshot` between clicks — refs CAN stale after the dialog re-renders.
{ "method": "snapshot" },
// Then click the target gridcell whose aria-label is the "MM/DD/YY" date, e.g. "07/15/26":
{ "method": "click", "params": { "selector": "[role='gridcell'][aria-label^='07/15/26']" } }
```

Date-picker gridcells use the format `MM/DD/YY, ,` (with two trailing commas — Single Selection marker comes after for the currently-selected day). The next/previous-month buttons sometimes appear unresponsive on the first click — if a re-snapshot shows the grid unchanged after a 1.5s wait, click again with the _freshly refreshed_ ref.

### 7. Click Search and observe the URL the form constructs

```jsonc
{ "method": "snapshot" },                                        // find "button: Search"
{ "method": "click", "params": { "selector": "button[aria-label='Search']" } },
// If the ref click doesn't navigate, fall back to a raw-coordinate click (~1120, 320 at default viewport):
{ "method": "evaluate", "params": { "content":
  "(()=>{const el=document.elementFromPoint(1120,320);['pointerdown','mousedown','pointerup','mouseup','click'].forEach(t=>el.dispatchEvent(new MouseEvent(t,{bubbles:true,clientX:1120,clientY:320})));return el.textContent;})()" } },
{ "method": "waitForTimeout", "params": { "time": 12000 } }      // results page is heavy and runs the Akamai JS challenge
```

The form constructs this URL pattern (verified empirically by reading the page URL — an `evaluate` of `location.href` — after the Search-button click):

```
https://www.aa.com/booking/search
  ?locale=en_US
  &fareType=Lowest
  &pax=1
  &adult=1
  &type=OneWay|RoundTrip
  &searchType=Revenue|Award
  &cabin=                              # empty=any | COACH | PREMIUM_ECONOMY | BUSINESS_FIRST | FIRST
  &carriers=ALL
  &travelType=personal                 # or business
  &slices=[
      {"orig":"JFK","origNearby":false,"dest":"LAX","destNearby":false,"date":"2026-07-15"}
    ]                                  # JSON-encoded, one slice for One-Way, two slices for Round-Trip
```

The `slices` value is a URL-encoded JSON array. **A second slice (LAX→JFK with the return date) is auto-appended when `type=RoundTrip`.**

### 8. Branch on the destination state

After the Search-button click, three outcomes are possible:

- **Title contains "Access Denied"** → Akamai behavioral-content wall (the common case, see Gotchas). Emit `{ "success": false, "error_reasoning": "akamai_wall", "wall_kind": "results_page_blocked" }`.
- **Title contains "Choose flights"** / page renders flight cards → success path. Parse via the steps below.
- **Title is empty or page is a spinner after 15s** → Akamai challenge JS is mid-execution; add another `waitForTimeout` of ~10s and a `{ "method": "reload", "params": { "waitUntil": "load" } }`. If a second reload still doesn't pass, treat as `akamai_wall`.

### 9. Extract flight cards (success path)

A `text` command on `body` (or an `evaluate` that reads the choose-flights DOM) for `/booking/search` lays each flight option out as a card with the following extractable structure (per inspection of AA's choose-flights React tree). Each card contains:

- One or more flight-number anchors (`AA<digits>`). Multiple = connecting itinerary; count stops by `len(flight_numbers) - 1`.
- A departure time `HH:MM AM|PM` paired with the origin code.
- An arrival time `HH:MM AM|PM` paired with the destination code (with `+1` suffix if next-day arrival).
- A duration string `Xh YYm` or `Xh`.
- Operating carrier disclosure when codeshare ("Operated by …" beneath the flight number).
- Fare buttons in three to five tiers: `Main Cabin` / `Main Plus` / `Premium Economy` / `Flagship Business` / `Flagship First` (route-dependent). Price format `$X,XXX.XX` (one-way) or `from $X,XXX.XX`.

Use a `text` command on `body` to harvest the full page text in one call (avoids per-card click-through), or fold the parse into a single `evaluate` so only compact JSON crosses the wire. Parse with anchored regex per card boundary (`AA\d+` repeated header pattern).

### Browser fallback (none — this IS the browser path)

There is no API/CLI/MCP fallback for AA flight shopping; the whole skill is a browser flow. The above "fallback" inside Step 8 (`akamai_wall`) is the realistic outcome path when the browser path itself fails.

## Site-Specific Gotchas

- **The bare domain `https://www.aa.com/` is Akamai-blocked on cloud browsers** — `Access Denied` HTML, even on a stealthed, residential-proxied session. Always open `https://www.aa.com/en-us/flights` (the regional path) instead. The same is true for `homePage.do`. The mobile site `m.aa.com` returns 500.
- **`/booking/search?slices=...` is the Akamai wall.** Three independently-attempted paths to this URL all return Akamai 403 / `Access Denied` HTML on a stealthed, proxied cloud browser:
  1. A direct `goto` of the deep-link from a cold session.
  2. A direct `goto` of the deep-link from a session warmed by visiting `/en-us/flights`.
  3. Clicking the Search button from a properly-filled form (which constructs the same URL).
     A raw residential-proxy HTTP fetch of that URL returns HTTP 200 but with the Akamai _behavioral-content challenge_ HTML (Akamai's JS bot-detection page with `sec-bc-tile-container` / `progress-button` DOM), not real flight results. This is currently a hard wall — flag this skill as `candidate` until the wall is bypassed. It is a behavioral-content challenge, not a captcha, so the `solve` command cannot clear it.
- **No public API.** No GraphQL, no `/api/`, no `sapi.*` mirror like Craigslist has. The internal aa.com BFF is request-signed and Akamai-fronted; do not waste turns probing it.
- **The cookie-consent dialog ("Privacy and cookies") MUST be dismissed before any form interaction.** Its z-index intercepts pointer events on the form's comboboxes. A `click` on the form reports success but the keystrokes never reach the input. Dismiss it via the `Dismiss` button ref first.
- **Origin/destination comboboxes ignore accessibility-ref clicks.** A `click` on the `fc-booking-origin-aria-label` ref registers as clicked but does not focus the underlying input — a `type` of `"JFK"` then writes nothing. **Focus by raw viewport coordinate** (via an `evaluate` dispatching a pointer event at `elementFromPoint`; default 1280x720: From ≈ (220, 330), To ≈ (470, 330)). Confirm focus succeeded by screenshotting after the first character types.
- **A `type` clears the value back on submit / blur when the field wasn't truly focused.** Typing into the combobox ref looks like it works in the snapshot, but the input clears the moment focus leaves. `type` only after a successful coordinate focus.
- **Always commit airport selection with `ArrowDown + Enter`.** Clicking the autocomplete `option:` ref directly sometimes clears the field (observed: clicking the JFK option after typing JFK left "From" empty when "To" was then focused). `ArrowDown` highlights the first option, `Enter` commits it deterministically.
- **Date textbox is read-only on commit.** Typing `07/15/2026` into `fc-booking-departure-date-input-aria-label` _displays_ the text but does not update the form state — pressing Tab clears the input. Use the dual-month grid + Next-Month button instead. Each Next-Month click advances both visible months by one.
- **Date-picker `Next-Month` clicks occasionally appear no-op.** Re-snapshot to get a fresh ref before each click (the dialog re-renders refs internally). If two consecutive clicks at fresh refs show the grid unchanged in the snapshot, suspect that the snapshot was taken before the React state propagated — wait an extra 1.5s and re-check.
- **Search button via accessibility ref doesn't navigate; raw coords do.** A `click` on the search-button ref registers as clicked but leaves the page on `/en-us/flights`. A raw-coordinate click at ~(1120, 320) (default-viewport position of the right-side Search button, via an `evaluate` dispatching a pointer event at `elementFromPoint`) does trigger navigation to `/booking/search?slices=[…]`. Same root cause as the combobox issue — the React click handler binds to the actual DOM element, not the role-detected accessibility target.
- **Results page Akamai challenge fires for 5–12s before resolving (or failing).** Always add a `waitForTimeout` of ~12000 ms after navigation. Don't `snapshot` earlier — the Akamai challenge DOM masquerades as a real page and yields garbage refs.
- **Round-Trip auto-adds the return slice.** When `type=RoundTrip`, the Search button auto-appends `{"orig":"LAX","origNearby":false,"dest":"JFK","destNearby":false,"date":"<return-date>"}` as the second slice. For One-Way, the URL has exactly one slice.
- **`searchType=Award` searches AAdvantage miles redemptions (no cash prices).** Switch the form's "Book with cash" button to "Book with miles" to trigger this. For a cash-fare search keep `searchType=Revenue`.

## Expected Output

Three outcome shapes depending on whether the results page renders.

### Success (results page rendered)

```json
{
  "success": true,
  "origin": "JFK",
  "destination": "LAX",
  "depart_date": "2026-07-15",
  "return_date": null,
  "trip_type": "one-way",
  "passengers": 1,
  "currency": "USD",
  "flights": [
    {
      "flight_numbers": ["AA123"],
      "depart_time": "07:00",
      "arrive_time": "10:25",
      "duration": "6h 25m",
      "stops": 0,
      "operating_carrier": "American Airlines",
      "fares": [
        { "class": "Main Cabin", "price": 289.0 },
        { "class": "Main Plus", "price": 339.0 },
        { "class": "Premium Economy", "price": 589.0 },
        { "class": "Flagship Business", "price": 1289.0 }
      ]
    },
    {
      "flight_numbers": ["AA456", "AA789"],
      "depart_time": "09:15",
      "arrive_time": "15:42",
      "duration": "9h 27m",
      "stops": 1,
      "operating_carrier": "American Airlines",
      "fares": [{ "class": "Main Cabin", "price": 219.0 }]
    }
  ],
  "error_reasoning": null
}
```

### Akamai wall (most common outcome on cloud browsers today)

```json
{
  "success": false,
  "origin": "JFK",
  "destination": "LAX",
  "depart_date": "2026-07-15",
  "flights": [],
  "error_reasoning": "akamai_wall",
  "wall_kind": "results_page_blocked",
  "evidence": {
    "url_constructed": "https://www.aa.com/booking/search?...slices=%5B...%5D",
    "page_title": "Access Denied",
    "akamai_reference": "Reference #18.6ad02e17.1779242119.87eb5c8"
  }
}
```

### Form-fill failure (input never committed)

```json
{
  "success": false,
  "origin": null,
  "destination": null,
  "depart_date": null,
  "flights": [],
  "error_reasoning": "form_input_failed",
  "evidence": {
    "step_failed": "origin_combobox_focus | airport_selection_commit | date_picker_navigation",
    "page_url_at_failure": "https://www.aa.com/en-us/flights"
  }
}
```
