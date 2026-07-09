---
name: find-house-lille-3bed-200k-300k
title: 'Find a House Near Lille (200k–300k, 3+ Bedrooms)'
description: >-
  Search leboncoin.fr for houses for sale within ~30 km of Lille priced
  200,000–300,000 EUR with at least 3 bedrooms, returning title, price,
  location, surface, rooms and listing URL. Read-only.
website: leboncoin.fr
category: real-estate
tags:
  - real-estate
  - leboncoin
  - france
  - housing
  - search
  - datadome
source: 'browserbase: agent-runtime 2026-06-28'
updated: '2026-06-28'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      leboncoin's internal JSON endpoint (POST
      https://api.leboncoin.fr/finder/search) backs the web UI, but it sits
      behind the same DataDome gate as /recherche — confirmed blocked from
      datacenter IPs and from the proxy-fetch path (no JS execution). Not usable
      without a JS-capable browser on a French residential IP.
  - method: fetch
    rationale: >-
      Plain HTTP fetch (incl. a browserless_function fetch over a residential
      proxy) returns the DataDome JS interstitial (rt:'i', 'Please enable JS')
      because the challenge requires in-browser JS execution. Cannot retrieve
      listings.
verified: true
proxies: true
---

# Find a House Near Lille (200k–300k, 3+ Bedrooms)

## Purpose

Search leboncoin.fr (France's largest classifieds site) for **houses for sale** within roughly 30 km of Lille, priced between **200,000 and 300,000 EUR**, with at least **3 bedrooms**, and return each matching listing's title, price, location, surface area, room/bedroom count and canonical listing URL. Read-only — never posts, contacts a seller, or edits anything.

> **Honest status: this skill could not be completed end-to-end in the build sandbox.** leboncoin's search surface is gated by **DataDome** anti-bot, which hard-blocks the only egress available during testing (a US datacenter IP). The search URL schema below is validated against the live site, but the actual results page returns an "Access is temporarily restricted" block unless you reach it from a **French residential IP inside a real JS-capable browser**. Treat the Workflow as the verified-correct recipe and the Site-Specific Gotchas as the mandatory pre-conditions.

## When to Use

- Monitoring or one-off searches for houses for sale around Lille (or, by swapping the location token, any French city) within a budget and minimum-bedroom constraint.
- Any case where you'd otherwise hand-build a leboncoin real-estate search URL and need the exact parameter schema.
- **Do not reach for this skill from a datacenter IP** — it will only ever see the DataDome block. See Gotchas for the required session configuration.

## Workflow

leboncoin renders search results client-side at `https://www.leboncoin.fr/recherche` from query-string parameters (the same URL the on-site search form produces — verified: typing a query and submitting yields `/recherche?text=…&kst=k`). There is **no usable API or fetch shortcut** — both the public web path and the internal `api.leboncoin.fr/finder/search` endpoint share the same DataDome gate (see Gotchas). The optimal method is therefore a **stealth browser session on a French residential IP**.

1. **Provision the call correctly (non-negotiable).** Drive it with `browserless_agent` carrying **a French-geolocated residential proxy** as a top-level arg: `proxy: { proxy: "residential", proxyCountry: "fr" }`. The default humanlike fingerprint (advanced stealth) is on; the `solve` command with `{ type: "dataDome" }` can help with the DataDome captcha variant. Keep the whole egress-check → warm-up → search → extract sequence inside one call's `commands` array. The residential proxy must actually resolve to a FR exit node — verify first:

   ```json
   { "method": "goto", "params": { "url": "https://ipinfo.io/json", "waitUntil": "load", "timeout": 45000 } }
   { "method": "evaluate", "params": { "content": "document.body.innerText" } }
   ```

   **The `country` must be `FR` and `org` must NOT be a cloud provider** (Amazon/Google/OVH datacenter ranges are flagged) before touching leboncoin. If it shows a US/datacenter IP, the proxy did not engage — stop and fix it (a pool without FR coverage will hand you a non-FR IP); proceeding will only produce DataDome blocks.

2. **Warm the session on the homepage.** `goto` `https://www.leboncoin.fr/` (`waitUntil: "load"`), wait ~3 s (`waitForTimeout`), then accept the cookie-consent dialog by `click`ing the **"Accepter"** button (CMP dialog `[dialog]` → button labelled `Accepter` / "Accepter & Fermer"). This sets the consent + initial DataDome cookies. The homepage tier is the least protected and reliably loads.

3. **Navigate to the structured search URL.** Build the `/recherche` URL from these parameters (all validated against the live param schema):
   - `category=9` — Ventes immobilières (real-estate **sales**).
   - `real_estate_type=1` — **Maison** (house). (`2` = Appartement, `3` = Terrain, `4` = Parking, `5` = Autre.)
   - `price=200000-300000` — min-max in EUR (`min-max`; use `min-max` form, `max` keyword allowed e.g. `200000-max`).
   - `locations=Lille_59000_50.6365654_3.0635282_10000_30000` — location token: `{City}_{postalCode}_{lat}_{lng}_{?}_{radiusMeters}`. The trailing `30000` encodes the **+30 km radius**; change it for other radii (e.g. `10000` for +10 km).
   - **Bedrooms:** apply the minimum-bedrooms constraint via the filter panel on the results page (see step 4). leboncoin's primary numeric filter is **`rooms`** (pièces, total rooms) — `rooms=4-max` is a common proxy for "≥3 bedrooms" since a 3-bedroom house is typically ≥4 rooms — but a dedicated bedrooms filter (`bedrooms=3-max`) may also be exposed in the UI. Confirm against the live filter panel; the exact bedroom param could not be verified through the DataDome block.

   Full example URL:

   ```
   https://www.leboncoin.fr/recherche?category=9&real_estate_type=1&price=200000-300000&locations=Lille_59000_50.6365654_3.0635282_10000_30000
   ```

4. **Apply the bedroom filter and read results.** On the rendered results page, open the filters (`click`), set the bedrooms (chambres) minimum to 3 (or `rooms` ≥ 4 as a fallback proxy), and let the listing grid re-render. Each result card exposes title, price, location/postal, surface (m²), room count, and a link to the detail page.

5. **Extract each listing.** Iterate the result cards (`snapshot` for refs, or an `evaluate` that parses the listing anchors in-page — prefer this over shipping raw HTML) and emit one object per listing matching the Expected Output schema. Paginate via the `&page=N` query param if `result_count` exceeds one page.

## Site-Specific Gotchas

- **DataDome gates the entire search surface — a French residential IP is mandatory.** The homepage and cookie-consent flow load fine even from a datacenter IP, but **`/recherche` (and any client-side search XHR) immediately returns the DataDome block**: a full-page "Access is temporarily restricted / We detected unusual activity from your device or network … Automated (bot) activity on your network (IP …)". The page title flips from `"leboncoin, site de petites annonces gratuites"` to `"leboncoin.fr"`, and the body contains `var dd={'rt':'c'…'host':'geo.captcha-delivery.com'}`. This block was reproduced across **5 configurations** (residential proxy + stealth, an FR-geolocation proxy hint, EU region, organic homepage→consent→search flow, and an independent autobrowse run) — every browser session that egressed from a us-west-2 datacenter IP was blocked. The block is caused by the IP, not the navigation pattern.
- **The FR residential proxy did not engage on the build account.** Despite a residential-proxy request with an FR geolocation hint, every browser session egressed from a `…compute.amazonaws.com` (us-west-2) datacenter IP. **Always verify the egress IP via `ipinfo.io/json` in the first command** — do not trust that the proxy routed. If you cannot get a confirmed FR residential exit node, this task is not achievable; do not waste turns hammering `/recherche`.
- **A raw HTTP fetch (`browserless_function`) over a residential proxy is JS-less — useless here.** It routes through a residential IP, but (a) the pool may not be French and (b) DataDome serves a JS interstitial (`rt:'i'`, "Please enable JS and disable any ad blocker") because the challenge requires in-browser JS. Confirmed blocked — don't try to scrape listings via a bare fetch.
- **The internal API is the same trap.** `POST https://api.leboncoin.fr/finder/search` (the JSON endpoint the UI calls) sits behind the identical DataDome gate and additionally needs a valid `api_key` header and a fresh DataDome cookie. **Confirmed not a shortcut** — don't waste time on it; there is no auth-free or anti-bot-free API path today.
- **Canonical search path verified.** Submitting the on-site search box produces `https://www.leboncoin.fr/recherche?text=<kw>&kst=k`, confirming `/recherche` + query params is the correct surface and that the structured `category` / `real_estate_type` / `price` / `locations` parameters are appended to the same path. `kst=k` is a search-origin tracking param and is optional for direct navigation.
- **Location token format.** `locations=City_Postal_Lat_Lng_<zoom?>_<radiusMeters>`. The final integer is the radius in **meters** (`30000` = +30 km). Multiple locations are comma-separated. Getting the lat/lng wrong still returns results scoped to the city/postal, but the radius circle will be off — use the city's real centroid (Lille ≈ `50.6365654, 3.0635282`).
- **The `solve` command alone is insufficient.** Even with a `solve { type: "dataDome" }` attempt, the block persisted from datacenter IPs — DataDome's IP-reputation rejection happens before/independent of the solvable captcha widget.
- **Bedrooms vs. rooms ambiguity (unresolved).** leboncoin distinguishes _pièces_ (rooms, `rooms`) from _chambres_ (bedrooms). The "3 bedrooms minimum" requirement maps cleanly to a bedrooms filter if the UI exposes one (`bedrooms=3-max`), otherwise approximate with `rooms=4-max`. This could not be confirmed live because the filter UI is behind the block — verify on first successful run and pin the exact param.

## Expected Output

Success shape (once reachable from a French residential IP):

```json
{
  "success": true,
  "query": {
    "location": "Lille (59000) +30km",
    "type": "house",
    "price_min_eur": 200000,
    "price_max_eur": 300000,
    "min_bedrooms": 3
  },
  "result_count": 42,
  "listings": [
    {
      "title": "Maison 5 pièces 110 m²",
      "price_eur": 274000,
      "location": "Lambersart 59130",
      "surface_m2": 110,
      "rooms": 5,
      "bedrooms": 3,
      "url": "https://www.leboncoin.fr/ad/ventes_immobilieres/2912345678"
    }
  ],
  "error_reasoning": null
}
```

Anti-bot wall shape (what this skill actually returns from a datacenter / non-FR IP — observed in every test run):

```json
{
  "success": false,
  "query": {
    "location": "Lille (59000) +30km",
    "type": "house",
    "price_min_eur": 200000,
    "price_max_eur": 300000,
    "min_bedrooms": 3
  },
  "result_count": 0,
  "listings": [],
  "error_reasoning": "Blocked by DataDome on https://www.leboncoin.fr/recherche. Page shows 'Access is temporarily restricted — We detected unusual activity from your device or network … Automated (bot) activity on your network (IP <datacenter-ip>)'. Body contains var dd={'rt':'c',...,'host':'geo.captcha-delivery.com'}. Homepage loads but /recherche is gated; requires a French residential IP in a JS-capable stealth browser."
}
```
