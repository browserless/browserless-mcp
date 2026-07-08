---
name: track-package
title: USPS Package Tracking
description: >-
  Track a USPS package by tracking number and return current status, current
  location (city/state), expected delivery date, and the full chronological
  event timeline. Read-only.
website: tools.usps.com
category: logistics
tags:
  - logistics
  - tracking
  - usps
  - shipping
  - akamai
  - read-only
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      USPS Web Tools `TrackV2` (SOAP/REST) is the right path when you have a
      registered USERID — free but requires a one-time account setup at
      usps.com/business/web-tools-apis. This skill is the unauthenticated
      browser fallback.
  - method: browser
    rationale: >-
      tools.usps.com/go/TrackConfirmAction is a JavaScript SPA behind Akamai.
      Deep-link via the qtc_tLabels1 query param, then read the rendered DOM.
      The page's own /track-confirm/v1/details/{n} XHR endpoint is
      sender-cookie-bound and returns 403 from any out-of-band caller — driving
      the page is the only reliable path without USPS Web Tools credentials.
verified: false
proxies: true
---

# USPS Package Tracking

## Purpose

Given a USPS tracking number (any service type — Certified, Priority, Ground Advantage, Priority Mail Express, First-Class Package, registered, etc.), return the package's current status, current/last-scanned location (city + state), expected delivery date/window, and the full chronological event timeline. Read-only — never click Sign-Up-For-Updates, Schedule-Redelivery, or any button that initiates an action. Treat the tracking number as PII: if exposing screenshots or logs to a third party, redact the number itself and crop locations to city/state (never full street addresses, which can appear on signed-for delivery events).

## When to Use

- "Where is my USPS package with tracking number `9434...`?" (the canonical case).
- Batch status polling of certified-mail receipts for legal/operations workflows.
- Detecting a `delivered` transition for shipping-notification automation.
- Disambiguating between _label-created-but-not-yet-mailed_ (USPS Awaiting Item) and _in-transit_, which the carrier's own confirmation emails don't always distinguish.
- Surfacing exception states (`Delivery Attempted - No Authorized Recipient Available`, `Returned to Sender`, `Forwarded`, `Insufficient Address`).

For high-volume / programmatic tracking with rate guarantees, prefer the official **USPS Web Tools `TrackV2` SOAP/REST API** (free, requires a one-time `USERID` registration at <https://www.usps.com/business/web-tools-apis/welcome.htm>) — that path is out of scope for this skill, which is the browser/public-page fallback. The Web Tools API is the right answer when you have credentials; this skill is the right answer when you don't, or for a one-off look-up.

## Workflow

USPS's `tools.usps.com/go/TrackConfirmAction` page is a JavaScript SPA fronted by Akamai bot defense. There is **no working unauthenticated JSON endpoint** on this host — the page's XHR backend (`/track-confirm/v1/details/{trackingNumber}`) requires Akamai-acquired session cookies (`bm_sv`, `_abck`, `ak_bmsc`) that you only get by loading the page in a real browser with a residential IP. Lead with the deep-link URL pattern; the form-fill flow is a backup if the deep-link is silently rewritten or stripped.

1. **Use a residential-proxy `browserless_agent` call — and keep the whole flow in ONE call.** A bare or datacenter session reliably gets an Akamai 403 "Access Denied" interstitial, so set `proxy: { proxy: "residential" }` (add `proxyCountry: "us"`) at the **top level** of the `browserless_agent` call, and repeat that `proxy` arg on every call you make. There is **no session-release step** — nothing to release. The session persists across calls, keyed by the `proxy` config: a call repeating the same residential `proxy` reconnects to the same warmed browser with its Akamai session cookies (`bm_sv`, `_abck`, `ak_bmsc`) intact. As a convenience, sequence the whole flow — deep-link → wait → snapshot → accordion clicks → extract — inside a single call's `commands` array to save round-trips and avoid dropping the `proxy`; if you split it, repeat the same `proxy` on every call so you stay in the same session.

2. **Deep-link directly to the tracking page** with the tracking number in the `qtc_tLabels1` query parameter. Strip any whitespace from the tracking number first — the param is space-sensitive and a literal space causes the page to render the "enter a tracking number" form instead of the result. First `commands` entries:

   ```json
   { "method": "goto", "params": { "url": "https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1=<TRACK>", "waitUntil": "load", "timeout": 45000 } },
   { "method": "waitForTimeout", "params": { "time": 3500 } }
   ```

   (`<TRACK>` = the tracking number with all whitespace stripped. Use `waitUntil: "load"`, never networkidle — the SPA streams. The status banner + timeline render 2–4s after `load` fires, hence the `waitForTimeout`.)

3. **Snapshot, then branch on the visible state.** The page has five well-defined terminal shapes (see Expected Output below) plus three "still rendering" intermediate states. Always wait for the status banner before classifying.

   ```json
   { "method": "snapshot" }
   ```

   The accessibility tree's first `heading level=2` near the top of the result region is the **status banner** — its text classifies the outcome. Common banner strings, normalized:

   | Banner text (verbatim from page)                                                                                                                                                     | Normalized status                 |
   | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
   | `Delivered`, `Delivered, In/At Mailbox`, `Delivered, Front Door/Porch`, `Delivered, Parcel Locker`, `Delivered, Individual Picked Up at Postal Facility`                             | `delivered`                       |
   | `Out for Delivery`                                                                                                                                                                   | `out_for_delivery`                |
   | `Arriving Late`, `Moving Through Network`, `In Transit to Next Facility`, `Accepted at USPS Origin Facility`, `Departed USPS Regional Facility`, `Arrived at USPS Regional Facility` | `in_transit`                      |
   | `Pre-Shipment`, `Shipping Label Created, USPS Awaiting Item`, `USPS in possession of item` (after Pre-Shipment)                                                                      | `label_created` / `awaiting_item` |
   | `Delivery Attempted - No Authorized Recipient Available`, `Notice Left (No Authorized Recipient Available)`, `No Access to Delivery Location - Notice Left`, `Available for Pickup`  | `delivery_attempted`              |
   | `Alert`, `Insufficient Address`, `Forwarded`, `Returned to Sender`, `Undeliverable as Addressed`, `Refused`, `Awaiting Delivery Scan`                                                | `exception`                       |
   | `Status Not Available`, `Could not locate the tracking information` (and the page header reads "Could not locate the tracking information for your request")                         | `not_found`                       |

4. **Extract the structured fields.** All four are present in the same DOM region (`<div class="tracking-progress-bar-status-container">` and its siblings). Pull them with `{ "method": "text", "params": { "selector": "..." } }` on the labelled spans/headings (or fold the whole parse into a single `{ "method": "evaluate", "params": { "content": "(()=>{ ... return JSON.stringify({...}); })()" } }` that reads the region and returns a compact projection under `.value`) — never by absolute pixel position, the layout reflows on viewport changes.

   - **`expected_delivery`** — under the "Expected Delivery on" / "Arriving on" / "Arriving by" heading. Often two lines: the date (e.g. `Monday, June 3, 2026`) and an optional window (`9:00 PM` or `between 12:00pm and 8:00pm`). When the package is already delivered this block is replaced with the actual `Delivered, <date> <time>`. When `label_created`, it's typically absent or shows "Estimated Delivery Pending".
   - **`current_location`** — the bolded city/state line just below the status banner. For `delivered` items it shows the destination city/state; for `in_transit` it shows the last scan facility; for `out_for_delivery` it shows the local delivery unit. **Never extract a street address from this field** even if one is rendered (it can appear on signature-required deliveries) — clip to city + state + ZIP only.
   - **`tracking_history`** — the timeline below the "Tracking History" / "Text & Email Updates" / "Product Information" accordions. The "Tracking History" accordion may be collapsed by default; click it once with `{ "method": "click", "params": { "selector": "<Tracking History button>" } }` before reading (confirm the ref via `{ "method": "snapshot" }` if it misses). Each row is `{ timestamp, status, location }`; the rows are ordered most-recent-first.
   - **`service_type`** — under the "Product Information" accordion (also collapsed by default). Strings like `USPS Ground Advantage`, `Priority Mail`, `Certified Mail`, `Priority Mail Express`, `First-Class Mail`. Useful for downstream classification but optional.

5. **Verify the page is really showing your tracking number** before emitting a result. Akamai sometimes serves a stale cached page for a different number, and the SPA's URL-stripping behaviour can drop the query param on a soft-nav. Read the bolded label string near the status banner (`Tracking Number: 9434 6502 0621 7216 1838 46`), normalize by removing spaces, and string-compare against the input. If it doesn't match, treat the result as untrusted and re-open the deep-link (in a fresh residential-proxy `browserless_agent` call) with a cache-buster (`&_=<epoch-seconds>`).

There is no explicit release step — nothing to release. The session isn't torn down on return; it persists across calls keyed by the `proxy` config (a later call repeating the same residential `proxy` reconnects to it).

### Browser fallback: form-fill flow

If the deep-link is silently rewritten or the page renders the entry form instead of the result (rare, but observed when the URL contains an extra leading space or a non-USPS tracking number format), drive the form directly — again as one residential-proxy `browserless_agent` call whose `commands` array holds the full sequence:

```json
{ "method": "goto", "params": { "url": "https://tools.usps.com/", "waitUntil": "load", "timeout": 45000 } },
{ "method": "snapshot" },
{ "method": "click", "params": { "selector": "<Track Packages input>" } },
{ "method": "type", "params": { "selector": "<Track Packages input>", "text": "<TRACK>" } },
{ "method": "press", "params": { "key": "Enter" } },
{ "method": "waitForTimeout", "params": { "time": 3500 } },
{ "method": "snapshot" }
```

(The home page has a single tracking input near the top, ARIA labelled "Track Packages" — confirm the ref via the first `snapshot` if it misses.) Same classification logic as step 3 from there.

## Site-Specific Gotchas

- **A residential proxy is mandatory.** A bare or datacenter session reliably gets an Akamai-served "Access Denied" interstitial (HTTP 403 with `<title>Access Denied</title>`). Set `proxy: { proxy: "residential" }` at the top level of every `browserless_agent` call; a stealth session without a residential IP is not enough.
- **The deep-link query param is `qtc_tLabels1`, not `tLabels` or `trackingNumber`.** The old `tLabels` form is silently rewritten on landing but does not always populate `qtc_tLabels1` correctly, causing the entry form to render instead of the result. Always use `qtc_tLabels1`.
- **Tracking-number whitespace must be stripped.** A literal space (or %20) in the value causes a soft-fallback to the empty entry form with no error indicator — looks like "page didn't load" but isn't.
- **`waitUntil: "load"` is necessary but not sufficient.** The status banner, expected-delivery block, and tracking-history accordions render 2–4 seconds after the `load` event fires (lazy XHR populates them). Always add a `{ "method": "waitForTimeout", "params": { "time": 3500 } }` after the goto before snapshotting.
- **Tracking History and Product Information accordions are collapsed by default.** You must `click` the accordion header before the row data is in the snapshot. Look for a `button` with text `Tracking History` (and `aria-expanded="false"`); the click toggles it to `true`.
- **The unauthenticated JSON endpoint is a trap.** `https://tools.usps.com/track-confirm/v1/details/{trackingNumber}` returns valid JSON when called _from the page context_ (because the page's Akamai cookies are attached) but returns `403 Access Denied` from any out-of-band request — including a residential-proxy `browserless_function` fetch, a `curl` with copied cookies (Akamai's `bm_sv`/`_abck` are sender-bound), and a page-context `fetch()` from a session that hasn't yet rendered the tracking page once. Don't waste time on it. Drive the page and read the rendered DOM.
- **Akamai 403 interstitials look identical to a "tracking number not found" page** at first glance — both render a sparse single-paragraph response with no obvious error chrome. Distinguish by reading `document.title`: `Access Denied` is Akamai; `USPS.com® - USPS Tracking® Results` (even when the body says "Could not locate") is the real not-found state.
- **Multiple matches when scanning a Customs / IMpb / Intelligent Mail composite barcode.** If the user pastes the full IMpb barcode (~26+ digits) rather than the 22-digit tracking number, the page may show a "Select the tracking number you want to view" disambiguator. The skill should reject inputs longer than 22 digits and prompt the user, rather than auto-selecting.
- **"Status Not Available" is NOT the same as "Could not locate".** `Status Not Available` (banner inside an otherwise-rendered tracking page with the number shown) means the carrier has the number on file but no scans yet — typically a few hours between label-purchase and first acceptance. `Could not locate the tracking information for your request` (page-level header) means the number is unknown to USPS. Both are valid terminal outcomes; emit `awaiting_item` for the former and `not_found` for the latter.
- **Delivered events sometimes include a full street address** in the tracking history (e.g. `Delivered, Front Door/Porch — 555 MAIN ST, ANYTOWN, CA 90210`). When emitting locations downstream, redact to `<CITY>, <STATE> <ZIP5>`. The same goes for screenshots — crop or blur to city/state level.
- **Tracking-number format leakage.** When screenshotting result pages for documentation or eval purposes, the full tracking number appears in three places: the URL bar, the page heading (`Tracking Number: 9434 6502 0621 7216 1838 46`), and inside any "Share" link copy-buttons. Mask all three or capture viewport screenshots cropped below the heading.
- **Rate limits are unobtrusive but real.** No formal rate-limit header is returned, but Akamai begins serving the 403 interstitial after roughly 30–50 rapid sequential requests from the same residential-proxy IP. Keep sustained rate ≤ 1 req / 2 s, or rotate sessions every 20 lookups.
- **The "Sign Up for Updates" button is a redirect to USPS Informed Delivery account flow** — never click it. Same for "Schedule a Redelivery" (initiates a USPS account-bound action) and "Modify Delivery" (USPS Hold Mail).
- **Authoring note** — this SKILL.md was authored against USPS's documented, publicly-observable page structure and historical scraping patterns; **the generation environment for this run was network-restricted (the sandbox could reach `api.browserbase.com` for session lifecycle but not `connect.*.browserbase.com` for CDP)**, so the workflow above was not browser-validated end-to-end in the generation pass. The selectors and outcome classifications reflect the USPS surface as of mid-2026; a single browser-validated re-run on a sample of mixed-state tracking numbers is recommended before flipping `verified: true` in the metadata.

## Expected Output

Six distinct outcome shapes. All include `tracking_number_masked` (last-4 only) and `service_type` when discoverable.

```json
// 1. Delivered
{
  "success": true,
  "status": "delivered",
  "tracking_number_masked": "****3846",
  "service_type": "Certified Mail",
  "delivered_at": "2026-05-15T14:32:00-04:00",
  "delivered_to_description": "Front Door/Porch",
  "current_location": { "city": "RICHMOND", "state": "VA", "zip5": "23230" },
  "expected_delivery": null,
  "events": [
    { "timestamp": "2026-05-15T14:32:00-04:00", "status": "Delivered, Front Door/Porch", "location": "RICHMOND, VA 23230" },
    { "timestamp": "2026-05-15T08:14:00-04:00", "status": "Out for Delivery",                "location": "RICHMOND, VA 23230" },
    { "timestamp": "2026-05-15T07:55:00-04:00", "status": "Arrived at Post Office",          "location": "RICHMOND, VA 23230" }
  ]
}

// 2. Out for delivery
{
  "success": true,
  "status": "out_for_delivery",
  "tracking_number_masked": "****3846",
  "service_type": "Priority Mail",
  "current_location": { "city": "RICHMOND", "state": "VA", "zip5": "23230" },
  "expected_delivery": { "date": "2026-05-15", "window_end": "2026-05-15T21:00:00-04:00" },
  "events": [ /* ... */ ]
}

// 3. In transit
{
  "success": true,
  "status": "in_transit",
  "tracking_number_masked": "****3846",
  "service_type": "USPS Ground Advantage",
  "current_location": { "city": "GREENSBORO", "state": "NC", "zip5": "27498" },
  "expected_delivery": { "date": "2026-05-17", "window_end": null },
  "events": [ /* ... */ ]
}

// 4. Label created / awaiting item
{
  "success": true,
  "status": "awaiting_item",
  "tracking_number_masked": "****3846",
  "service_type": "Priority Mail",
  "current_location": null,
  "expected_delivery": null,
  "events": [
    { "timestamp": "2026-05-14T09:02:00-04:00", "status": "Shipping Label Created, USPS Awaiting Item", "location": "BROOKLYN, NY 11201" }
  ]
}

// 5. Exception / delivery attempted
{
  "success": true,
  "status": "exception",
  "exception_reason": "Delivery Attempted - No Authorized Recipient Available",
  "tracking_number_masked": "****3846",
  "service_type": "Certified Mail",
  "current_location": { "city": "RICHMOND", "state": "VA", "zip5": "23230" },
  "expected_delivery": { "date": "2026-05-16", "window_end": null },
  "events": [ /* ... */ ]
}

// 6. Not found
{
  "success": false,
  "reason": "not_found",
  "tracking_number_masked": "****3846",
  "message_from_page": "Could not locate the tracking information for your request. Please verify your tracking number and try again."
}
```
