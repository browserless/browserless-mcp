---
name: travel-deal
title: Priceline Travel Deal Finder
description: >-
  Surface current Priceline travel deals (Express Deals promo callouts,
  city-route hotel and flight prices) by extracting them directly from the
  homepage. Read-only; never books. Recommended path is homepage extraction
  because Priceline's PerimeterX 'Press & Hold' challenge fires on the
  search-form submission path.
website: priceline.com
category: travel
tags:
  - travel
  - hotels
  - flights
  - deals
  - express-deals
  - read-only
  - perimeterx
source: 'browserbase: agent-runtime 2026-05-23'
updated: '2026-05-23'
recommended_method: browser
alternative_methods:
  - method: browser
    rationale: >-
      The optimal browser flow is HOMEPAGE EXTRACTION rather than form
      submission. The homepage already renders dozens of city-route hotel and
      flight deals (with concrete $NN prices) plus promo callouts in the
      accessibility tree.
  - method: api
    rationale: >-
      Priceline has an internal GraphQL endpoint at
      /pws/v0/pcln-graph/?gqlOp=<op> (observed operations:
      getRecentSearchesByCguid, getAbandonedItemsByCguid,
      recognizedCustomerProfile) whose schema knows about every deal type — but
      all calls require a valid cguid cookie plus PerimeterX session tokens that
      only a live, JS-warmed page can build. A direct fetch will be blocked. Do
      not attempt without a fully primed browser session.
verified: true
proxies: true
---

# Priceline Travel Deal Finder

## Purpose

Surface one or more current "fantastic travel deals" from Priceline — including Express Deals (opaque mystery hotels with steep discounts), Pricebreakers (3 mystery hotels at one fixed price), promo-coded sales (e.g. "Up to 30% off hotels", "Up to 60% off packages"), and city-route hotel/flight callouts shown on the homepage. The skill is **read-only** — it never clicks Reserve / Book / Continue to checkout / Pay now.

The optimal path is **homepage extraction**, not the search form: Priceline's homepage already enumerates dozens of city-routed hotel and flight deals (with concrete `$NN` prices) in the accessibility tree, plus promotional callouts for Express Deals, packages, and rentals. Submitting the actual hotel-search form triggers a PerimeterX "Press & Hold" challenge that a stealth browser session does **not** auto-solve.

## When to Use

- A general "find me a great trip deal" prompt with no specific destination or dates.
- A daily-deals digest pulling Priceline's promo callouts and current city-route prices.
- Comparison shopping that needs to see what Priceline is _currently advertising_ (the homepage rotates the featured deals).
- Any flow that would otherwise scrape the homepage manually — this skill's homepage-extraction pattern is faster and survives anti-bot longer than a full search-and-results flow.

## Workflow

### Recommended path: homepage deal extraction

A residential-proxy + stealth session is **mandatory** — a bare session triggers Cloudflare and PerimeterX defenses on first paint. Batching the whole warm-up → dismiss → snapshot flow inside a **single** `browserless_agent` call's `commands` array is the convenient default: it saves round-trips and avoids accidentally dropping the session config between steps. The session itself persists across separate calls — it's keyed by `proxy`/`profile`, so a later call carrying the **same** `proxy` reconnects to the same warmed browser (current page, cookies, and session state intact).

1. **Stealth + residential-proxy session**: call `browserless_agent` with a top-level `proxy: { "proxy": "residential", "proxyCountry": "us" }` and keep every step below in that one call's `commands`. Repeat the **same** `proxy` arg on **every** follow-up call — the session is keyed by `proxy`, so repeating it reconnects to the same warmed session, while dropping or changing `proxy` lands you in a different, bare (blocked) session.

2. **Open the homepage and let it settle**:

   ```json
   { "method": "goto", "params": { "url": "https://www.priceline.com/", "waitUntil": "load", "timeout": 45000 } }
   { "method": "waitForTimeout", "params": { "time": 3000 } }
   ```

3. **Dismiss the "Unlock Offer Instantly" modal with Escape**. This 10%-off email-signup popup overlays the page on first load and is **invisible to the accessibility tree** — a `snapshot` shows ~1349 refs even when the modal is visually blocking the page. Always press Escape before snapshotting:

   ```json
   { "method": "keyboard", "params": { "key": "Escape" } }
   ```

4. **Dismiss the cookie-consent banner** (it appears after the modal closes, anchored at the bottom but visually overlapping the lower form area). Take a `snapshot`, locate the `button: Accept All` node (observed at refs like `[14-3275]`, but the index varies per session), then click it:

   ```json
   { "method": "snapshot" }
   { "method": "click", "params": { "selector": "button:has-text('Accept All')" } }
   { "method": "waitForTimeout", "params": { "time": 1500 } }
   ```

   Confirm the exact node via `snapshot` if the selector misses.

5. **Snapshot the homepage** (`{ "method": "snapshot" }`). The full home page is now in the a11y tree (~4500 lines). Deal surfaces are organized by region:

   - **Promo carousel** (under `listbox: slider` near the top):
     - `link: Up to 30% off hotels`
     - `link: Up to 10% off Hotel Express Deals`
     - `link: Up to 60% off packages`
     - (rotating; iterate over all `option: slide` children of `listbox: slider`)

   - **City-route hotel deals** (lower on the page, grouped per featured city — Las Vegas, Miami, Nashville, Charlotte, Houston, etc.):
     - `link: <Hotel Name> $<price>` (e.g. `link: Holiday Inn Express Nashville Airport by IHG $113`)
     - Parse the trailing `$NN` price out of the link label

   - **City-route flight deals** (interleaved with hotel deals):
     - `link: Flights from <Origin City> to <Destination City> $<price>` (e.g. `link: Flights from Los Angeles to Las Vegas $329`)

   - **Footer deal links** (under `link: Hotel Express Deals™`, etc.) — pointers to dedicated deal-listing pages.

6. **Extract deals**. The recommended extraction is simple regex on the snapshot tree text:
   - Hotels: `link: ([^$]+?) \$(\d+)` → `[name, nightly_price_usd]`
   - Flights: `link: Flights from ([^to]+) to ([^$]+) \$(\d+)` → `[origin, destination, fare_usd]`
   - Promo callouts: `link: (Up to \d+% off [^"]+)` → promo text

7. **Sort and rank**. The homepage doesn't pre-rank by discount %, just by city groupings. A reasonable "best deal" heuristic:
   - For hotels: lowest absolute price under $100 + a marquee brand (Hilton, Marriott, IHG family) usually beats a no-name $40 budget.
   - For flights: lowest $-per-mile is the safer bet than absolute lowest fare (a $268 SFO→NSH may be better than a $329 LAX→LAS).
   - For promo callouts: rank by stated % off, prefer `Express Deals` (typically biggest discount) then `packages` then `hotels`.

8. **Output**. See "Expected Output" below.

### Browser fallback: search form path (use only when the homepage doesn't have a deal for the user's target)

The form-driven path has a much higher PerimeterX-trigger rate. Use it only when the homepage doesn't show a deal to the user's specific city. **Budget at least 15 turns + accept a ~50 % CAPTCHA-trigger rate.**

1. After dismissing modal + cookie banner, locate the "Where to?" combobox (observed at refs like `[14-65]`, varies per session).
2. `{ "method": "type", "params": { "selector": "<where-to selector>", "text": "Las Vegas, NV" } }` — pass the full string, commas and all, in `text` (the old `browse` CLI split on the comma; `type` takes the literal value fine).
3. `{ "method": "waitForTimeout", "params": { "time": 2000 } }`, then `snapshot`. The autocomplete dropdown renders ~170 a11y refs in a fresh subtree.
4. Click the FIRST option matching the destination (e.g. `link: Las Vegas Nevada, United States`).
5. After click, the calendar dialog **auto-opens** (snapshot grows to ~1546 refs). Either select check-in / check-out dates or press Escape (`{ "method": "keyboard", "params": { "key": "Escape" } }`) to keep the defaults (which pre-fill to the upcoming weekend).
6. Find `button: Find Your Hotel` (observed at `[14-762]`) and click it.
7. If a "Press & Hold" modal appears at any step — **stop**. The session is now poisoned; start over in a fresh session by issuing a call with a different `proxy` (repeating the same `proxy` just reconnects you to the poisoned session). Do not attempt to programmatically hold the button; single click does not solve PerimeterX.

## Site-Specific Gotchas

- **PerimeterX "Press & Hold" is the dominant anti-bot mechanism, in two flavors:**
  1. **Full-page lockout** (`https://www.priceline.com/` is replaced by a "Before we continue..." page with `Reference ID <uuid>`). Triggered by invented deep-link URLs like `/hotel-deals/search?q=...&checkIn=...` or `/relax/in/<unknown-id>/from/.../to/...`. **The lockout persists across same-session navigation back to `/`.** Always start over in a fresh session — a call carrying a different `proxy`, since repeating the same `proxy` reconnects to the poisoned session.
  2. **Modal overlay** (the homepage stays in the DOM behind a centered "Press & Hold to confirm you are a human" modal with the same Reference-ID footer). Triggered by automated form fills with unusual timing — observed firing right after `type`-ing "Las Vegas, NV" into the where-to combobox on a stealth + residential-proxy session.
- **A stealth browser session does NOT auto-solve Press & Hold.** A single programmatic click on the "Press & Hold" button leaves the page stuck at the same ~20-ref snapshot indefinitely. There's no mouse press-and-hold primitive to literally hold the button down, and `browserless_agent`'s `solve` command doesn't cover PerimeterX Press & Hold, so this challenge type is currently unsolvable.
- **The "Unlock Offer Instantly" 10%-OFF modal is invisible to `snapshot`** but visually blocks every form click. Always press Escape (`keyboard` Escape) after the initial `waitForTimeout` of 3000 ms before any form interaction.
- **The cookie consent banner appears second, separately from the email modal, and ALSO blocks the bottom of the form** (specifically the `Find Your Hotel` submit button — iter-4 burned all 30 turns submitting against a banner-shadowed button). Click `button: Accept All` (locatable in the snapshot tree) before any submit.
- **Pass the comma-bearing destination as one `text` value** — e.g. `{ "method": "type", "params": { "selector": "...", "text": "Las Vegas, NV" } }`. (The old `browse` CLI parsed the comma as an argument separator and errored with `Unexpected arguments: Ve`; `type` has no such issue.)
- **The destination autocomplete dropdown DOES appear in the a11y tree** (~170 refs after fill, in a fresh subtree), but you must `waitForTimeout` ~2000 ms before snapshotting — it lazy-loads from `GET https://www.priceline.com/svcs/ac/index/hotels/v2/{prefix}`.
- **Selecting an autocomplete option auto-opens the calendar dialog.** If you don't want to set custom dates, press Escape immediately after the destination click — defaults pre-fill to the upcoming weekend (e.g. "Fri, May 22 - Sat, May 23").
- **Default dates pre-fill to today's weekend** (verified across 4 fresh sessions on 2026-05-23). For "find me a deal" tasks this is fine; explicit date selection is only needed when the user specifies dates.
- **Priceline's GraphQL endpoint is visible but cookie-locked.** Pageloads issue `POST https://www.priceline.com/pws/v0/pcln-graph/?gqlOp=<operationName>` with operation names like `getRecentSearchesByCguid`, `getAbandonedItemsByCguid`, `recognizedCustomerProfile`. The `AbandonedSelections` query response shape exposes the full deal-type schema (`SopqHotel` = Express Deal, `AbandonedPriceBreakersHotel` = Pricebreakers, `RtlHotel` = Retail). However: all calls require valid `cguid` cookie + PerimeterX session tokens that only a live page can build. **A direct fetch to the GraphQL endpoint without an established session WILL get blocked.** Do not waste cycles on a headless GraphQL approach.
- **`/hotel-deals/`, `/deals/`, and `/relax/...` direct URLs are unverified.** They were not exercised end-to-end in this skill's iterations. If you try them, expect PerimeterX to challenge — be ready to fall back to the homepage path.
- **The footer link `Hotel Express Deals™` at `link: Hotel Express Deals™`** is a candidate dedicated landing page. Not exercised in this skill's iterations — opening it should be treated as a known unknown.
- **No session-management dance.** There's no explicit session-release call to make — but that's not because the session dies on return. The session persists across calls keyed by `proxy`; repeat the same `proxy` to stay in it, or omit it to start clean. Just `goto https://www.priceline.com/` as the first command of the call.
- **Read-only.** The "Find Your Hotel" button → results page → individual hotel cards eventually leads to a Reserve / Book flow. Never click `Reserve`, `Book`, `Continue`, `Pay now`, `Confirm booking`. Stop at the deal-list view.

## Expected Output

The skill returns a JSON envelope with the surfaced deals. Two distinct outcome shapes are exercised:

### Success — homepage extraction (the recommended path)

```json
{
  "success": true,
  "source": "homepage",
  "promo_callouts": [
    { "label": "Up to 30% off hotels", "category": "hotels" },
    {
      "label": "Up to 10% off Hotel Express Deals",
      "category": "express_deals"
    },
    { "label": "Up to 60% off packages", "category": "packages" }
  ],
  "hotel_deals": [
    {
      "name": "Flamingo Las Vegas",
      "city": "Las Vegas",
      "from_price_usd": 22
    },
    {
      "name": "Holiday Inn Express Nashville Airport by IHG",
      "city": "Nashville",
      "from_price_usd": 113
    },
    {
      "name": "North Miami Beach Gardens Inn & Suites",
      "city": "Miami",
      "from_price_usd": 52
    }
  ],
  "flight_deals": [
    { "origin": "Los Angeles", "destination": "Las Vegas", "fare_usd": 329 },
    { "origin": "Dallas", "destination": "Nashville", "fare_usd": 268 },
    { "origin": "Detroit", "destination": "Houston", "fare_usd": 402 }
  ],
  "best_pick": {
    "type": "hotel",
    "name": "Flamingo Las Vegas",
    "city": "Las Vegas",
    "from_price_usd": 22,
    "rationale": "Lowest absolute price in a marquee Strip-adjacent property; matches 'fantastic travel deal' intent."
  },
  "captured_at": "2026-05-23T00:30:00Z",
  "notes": "Modal + cookie banner dismissed via Escape + Accept All; PerimeterX not triggered."
}
```

### Failure — Press & Hold wall (full-page lockout)

```json
{
  "success": false,
  "reason": "anti_bot_press_and_hold",
  "wall_variant": "full_page_lockout",
  "reference_id": "4b818810-563d-11f1-9b9b-8ff3ce2de60a",
  "trigger": "navigation to /hotel-deals/search?q=... triggered Cloudflare/PerimeterX after homepage was loaded successfully",
  "notes": "Session is poisoned; cannot recover via in-session navigation. Caller should retry in a fresh session (a call carrying a different proxy, since the same proxy reconnects to the poisoned session) if the homepage path is required."
}
```

### Failure — Press & Hold wall (form-interaction modal)

```json
{
  "success": false,
  "reason": "anti_bot_press_and_hold",
  "wall_variant": "modal_overlay",
  "reference_id": "6410e300-5640-11f1-91f0-7bc9b928829b",
  "trigger": "Press & Hold modal appeared immediately after typing \"Las Vegas, NV\" into the where-to combobox on a stealth + residential-proxy session",
  "notes": "Modal overlays the homepage; underlying form is still in the DOM but unusable. Treat the session as poisoned. Falling back to homepage extraction (do not re-trigger the form) is the resilient path."
}
```
