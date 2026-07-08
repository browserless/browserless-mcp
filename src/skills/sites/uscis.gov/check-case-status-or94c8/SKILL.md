---
name: check-case-status
title: USCIS Case Status Lookup
description: >-
  Look up a USCIS case by its 13-character receipt number on the public Case
  Status Online tool and return the status headline, status/next-step paragraph,
  form type, service-center code, last-updated date, and canonical URL.
  Read-only.
website: uscis.gov
category: government
tags:
  - government
  - immigration
  - uscis
  - case-status
  - read-only
  - cloudflare
source: 'browserbase: agent-runtime 2026-06-04'
updated: '2026-06-04'
recommended_method: browser
alternative_methods:
  - method: fetch
    rationale: >-
      Not viable. Cookieless HTTP GET/fetch (even via residential proxy) returns
      a 403 Cloudflare 'Just a moment...' managed-challenge page — confirmed
      during testing. No HTML form is served to a non-browser client.
  - method: api
    rationale: >-
      Not viable. The lookup is a Next.js server action (POST to / with
      Next-Action headers + RSC encoding), not a documented JSON API. The legacy
      egov.uscis.gov/casestatus/mycasestatus.do?appReceiptNum= GET deep-link is
      dead — it 302-redirects to the SPA root without performing the lookup.
verified: true
proxies: true
---

# USCIS Case Status Lookup

## Purpose

Given a USCIS receipt number (13 characters: a 3-letter service-center prefix + 10 digits, e.g. `EAC2290098765`), look it up on the public USCIS "Case Status Online" tool and return the current case status headline, the human-readable status / next-step paragraph, the form type when surfaced (I-130, I-485, N-400, I-765, …), the service-center code, the last-updated date if shown, and the canonical case-status URL. **Read-only** — this skill only reads the status page; it never signs in, files, or modifies anything. No authentication is required for the public lookup.

## When to Use

- "What's the status of USCIS receipt `IOE0912345678`?"
- Monitoring a pending immigration case (I-130/I-485/I-765/N-400/etc.) for status changes by receipt number.
- Bulk status checks across a list of receipt numbers (one lookup per receipt; see gotchas on rate/anti-bot).
- Any flow that needs the raw status text + next-step paragraph without logging into a USCIS account.

## Workflow

There is **no usable API, JSON endpoint, or URL deep-link** for this task — a real browser is mandatory. The site is a Next.js single-page app fronted by a **Cloudflare managed challenge** (`Cf-Mitigated: challenge`) plus Cloudflare Turnstile; a cookieless HTTP `GET`/`fetch` (even over a residential proxy) returns a `403` "Just a moment…" interstitial, not the form. The submit itself is a **Next.js server action** (`POST` to `https://egov.uscis.gov/` carrying the `receipt_number` field), not a documented endpoint you can call directly. So drive it with a residential-proxy `browserless_agent` call: set the top-level `proxy: { proxy: "residential" }` arg on every call — the session is keyed by that `proxy` config, so repeating it reconnects to the same warmed browser (cookies/session intact) while dropping or changing it lands you in a different, blank session — and batch the whole form flow into ONE call's `commands` array as the convenient default (it saves round-trips and avoids accidentally dropping the session config).

1. **Open the tool and clear Cloudflare.** Navigate to `https://egov.uscis.gov/` (the legacy `…/casestatus/landing.do` URL 302-redirects to this same SPA root); the first load lands on the Cloudflare interstitial. Follow the `goto` with a `solve { type: "cloudflare" }` command, which clears the managed challenge in a few seconds:

   ```json
   [
     {
       "method": "goto",
       "params": {
         "url": "https://egov.uscis.gov/",
         "waitUntil": "load",
         "timeout": 45000
       }
     },
     { "method": "solve", "params": { "type": "cloudflare" } },
     { "method": "waitForTimeout", "params": { "time": 5000 } }
   ]
   ```

   If you need to confirm the challenge cleared, add an `{ "method": "evaluate", "params": { "content": "document.title" } }` command — the title flips from `"Just a moment..."` to `"Case Status Online - Case Status Search"`.

2. **Enter the receipt number.** Snapshot, find the `textbox: Enter a Receipt Number` (internal field name `receipt_number`), click it, then type. **Strip dashes**; keep any `*` asterisks that appear on the paper notice. The "Check Status" button is **disabled** until the field is non-empty. Append these to the same `commands` array:

   ```json
   [
     { "method": "snapshot" },
     { "method": "click", "params": { "selector": "<textbox-selector>" } },
     {
       "method": "type",
       "params": { "selector": "<textbox-selector>", "text": "EAC2290098765" }
     }
   ]
   ```

   Note: refs/selectors from `snapshot` are reassigned on every snapshot — re-`snapshot` right before each click/type rather than reusing an old one; if a selector misses, confirm via `snapshot`.

3. **Submit.** Click the now-enabled `button: Check Status`, then wait for the server action to return, then snapshot:

   ```json
   [
     { "method": "click", "params": { "selector": "<check-status-selector>" } },
     { "method": "waitForTimeout", "params": { "time": 3000 } },
     { "method": "snapshot" }
   ]
   ```

4. **Branch on the result** (the URL stays `https://egov.uscis.gov/` in every case — do not rely on a URL change to detect success):
   - **Status returned** → the card shows a bold status headline (e.g. "Case Was Received", "Case Was Approved", "Request for Additional Evidence Was Sent", "Case Is Being Actively Reviewed by USCIS") followed by a descriptive paragraph. Extract both.
   - **Rejected** → the card shows the red inline text **"The receipt number entered is invalid, please try again."** This single message covers _both_ malformed receipts and well-formed-but-nonexistent ones. Emit it as the `invalid_or_not_found` outcome — it is a valid result, not a tooling failure.

5. **Extract & emit** (see Expected Output):
   - `status` — the headline text.
   - `status_description` — the full paragraph below it.
   - `form_type` — parse from the paragraph (e.g. "Form I-765, Application for Employment Authorization" → `I-765`); `null` if absent.
   - `service_center_code` — first 3 characters of the receipt number (no page read needed).
   - `last_updated` — only if the paragraph/page surfaces a date; frequently `null` on the current SPA.
   - `case_status_url` — `https://egov.uscis.gov/`.

## Site-Specific Gotchas

- **READ-ONLY.** Never click "Login", "Create an account", or any "Visit Page" related-tools button. Stop at the status/result card.
- **Cloudflare, not hCaptcha.** The gate is a Cloudflare _managed challenge_ + Turnstile (verified via response headers `Cf-Mitigated: challenge` and `challenges.cloudflare.com/turnstile/v0/...`). A residential-proxy `browserless_agent` running a `solve { type: "cloudflare" }` clears it; a bare or data-center-IP session does not. A plain fetch/goto without solving returns a `403` "Just a moment…" HTML page — confirmed, do not attempt an HTTP-only path.
- **No API / no deep-link.** The legacy `https://egov.uscis.gov/casestatus/mycasestatus.do?appReceiptNum=<R>` GET endpoint is dead — it 302-redirects to the SPA root and does **not** prefill or look up the receipt. Submission is a Next.js **server action** (`POST /` with `Next-Action` headers + RSC encoding), not a callable JSON API. Don't waste time trying to reconstruct it; drive the form.
- **"The receipt number entered is invalid, please try again." is the catch-all rejection.** It is returned for malformed receipts _and_ for well-formed receipts that don't correspond to a real case. You cannot distinguish "bad format" from "no such case" from the message alone. Both example receipts in typical test prompts (`EAC2290098765`, `MSC2190012345`) and a structurally-plausible synthetic (`EAC2305012345`) all returned this same message during testing — only a genuine, existing receipt number produces a real status. Treat this as `success: false, reason: "invalid_or_not_found"`.
- **The result URL never changes.** Both the success card and the rejection render in-place at `https://egov.uscis.gov/`. Detect the outcome from the card text, never from a navigation/URL change.
- **Receipt formatting:** 13 chars = 3-letter service-center prefix + 10 digits. **Omit dashes.** Keep `*` asterisks only if they are printed on the notice. Common prefixes: `EAC`/`VSC` (Vermont), `WAC`/`CSC` (California), `LIN`/`NSC` (Nebraska), `SRC`/`TSC` (Texas), `MSC` (National Benefits Center), `YSC` (Potomac), `IOE` (USCIS online-filing / ELIS).
- **"Check Status" button is disabled until the field has content** — fill the textbox first, then read the button as enabled before clicking.
- **a11y refs are volatile.** Refs/selectors from `snapshot` (e.g. `[8-451]`) are reassigned on every snapshot and after the Cloudflare clear. Re-`snapshot` immediately before each click/type; a stale ref yields `Unknown ref` errors — if a selector misses, confirm via `snapshot`.
- **Page is heavy Next.js + analytics** (`_next/static/chunks/*`, Google Tag Manager, DAP analytics). Wait for `load` plus a short fixed timeout before reading the result card; the server-action response repaints the card a beat after navigation settles.

## Expected Output

```json
// Success — a real, existing receipt number
{
  "success": true,
  "receipt_number": "EAC2290098765",
  "service_center_code": "EAC",
  "status": "Case Was Received",
  "status_description": "On January 5, 2024, we received your Form I-765, Application for Employment Authorization, Receipt Number EAC2290098765, and sent you a receipt notice. We will mail you a decision or notice if we need something from you. If you move, go to www.uscis.gov/addresschange to give us your new mailing address.",
  "form_type": "I-765",
  "last_updated": null,
  "case_status_url": "https://egov.uscis.gov/",
  "error_reasoning": null
}
```

```json
// Invalid or not found — the catch-all rejection (malformed OR nonexistent receipt)
{
  "success": false,
  "receipt_number": "EAC2290098765",
  "service_center_code": "EAC",
  "status": "The receipt number entered is invalid, please try again.",
  "status_description": null,
  "form_type": null,
  "last_updated": null,
  "case_status_url": "https://egov.uscis.gov/",
  "error_reasoning": "invalid_or_not_found — USCIS returned the catch-all rejection message. The receipt number is either malformed or does not correspond to an existing case; the tool does not distinguish the two."
}
```

```json
// Blocked — Cloudflare challenge never cleared (no path through)
{
  "success": false,
  "receipt_number": "EAC2290098765",
  "service_center_code": "EAC",
  "status": null,
  "status_description": null,
  "form_type": null,
  "last_updated": null,
  "case_status_url": "https://egov.uscis.gov/",
  "error_reasoning": "blocked — Cloudflare managed challenge did not clear; page title stayed 'Just a moment...'. Retry with a fresh residential-proxy browserless_agent call and a `solve {type:'cloudflare'}` command."
}
```
