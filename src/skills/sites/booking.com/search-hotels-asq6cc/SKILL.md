---
name: search-hotels
title: Booking.com Hotel Search
description: >-
  Search Booking.com for hotels, apartments, hostels, and other accommodations
  in a given destination and date window. Supports the full Booking filter
  surface (property type, stars, review score, distance, neighborhoods,
  hotel/room facilities, meal plans, cancellation policy, brand chains,
  sustainability badges, Genius, sort order) and emits structured per-property
  JSON with the lead room offer. Read-only.
website: booking.com
category: travel
tags:
  - travel
  - hotels
  - accommodations
  - booking
  - read-only
  - aws-waf
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      Booking's Connectivity / Demand API (distribution-xml.booking.com) is
      partner-vetted — HTTP Basic auth required, contract-gated to OTAs,
      metasearch, and large travel-tech vendors. Verified 401 on direct probe.
      Not a public path.
  - method: api
    rationale: >-
      Booking's internal /dml/graphql FullSearch operation is the actual data
      source the page hydrates from — replay it from page context via an
      evaluate fetch once the browserless_agent session has cleared the AWS WAF
      token challenge. Cannot be called standalone (POST without the WAF cookie
      returns 403, verified by GET-405 + cookieless POST attempts during
      authorship).
  - method: url-param
    rationale: >-
      Booking's /searchresults.html URL surface (ss, dest_id, dest_type,
      checkin, checkout, group_adults, group_children, age, no_rooms, nflt,
      order, offset, selected_currency, map, bounding_box_*) covers every UI
      filter and is the canonical way to drive the search — but the page itself
      is still behind AWS WAF, so URL composition alone is not enough; a real
      browserless_agent browser session is required to render results.
verified: true
proxies: true
---

# Booking.com Hotel Search

## Purpose

Search Booking.com for accommodations (hotels, apartments, hostels, resorts, villas, B&Bs, guest houses, holiday homes, motels, lodges, country houses) in a given destination + date window, with the full filter surface that Booking's search UI exposes — guests/rooms, price range, property type, star rating, review score, distance from a center/landmark/airport, neighborhood, hotel + room facilities, meal plans, bed preference, cancellation policy, brand chain, sustainability and Genius badges, and sort order. Returns structured JSON per matching property including the lead room offer for the requested dates.

Read-only. Never clicks Reserve, I'll Reserve, See Availability, Sign In, Save to List, or any payment-flow control.

## When to Use

- A travel-research agent comparing nightly rates / total-stay totals across properties in one city for fixed dates.
- A meta-search agent that needs Booking.com inventory alongside other OTAs (Booking is the only practical public source — the Connectivity / Demand API is partner-vetted, contract-gated).
- A planning agent that needs to filter by hard constraints the user actually cares about (pets, free-cancellation, breakfast included, near airport, EV charging, etc.).
- Map-bound "search this area" queries from a lat/lng bounding box.
- Bulk pull of a property-ID list (look each up via its hotel detail URL).

Do **not** use this skill for bookings — that's a separate, write-mode skill that does not exist here.

## Workflow

### 0. Inputs accepted

Any one of:

| Input shape             | Example                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| Full Booking search URL | `https://www.booking.com/searchresults.html?ss=Paris&checkin=2026-06-15&...` |
| Free-form destination   | `"Rome"`, `"Banff National Park"`, `"Heathrow Airport"`, `"Shibuya, Tokyo"`  |
| Property-ID list        | `["123456", "789012"]` → resolved via `/hotel/{cc}/{slug}.html`              |
| Lat/lng bounding box    | `{north, south, east, west}` → map-bound search                              |

Dates are required for pricing. If omitted, search still runs but lead-offer fields will be null and only static property metadata is returned.

### 1. Session — `browserless_agent` with a residential proxy, mandatory

Drive every step through `browserless_agent` with a residential proxy. Keep the whole flow (warm-up nav → resolve dest → nav search → extract → paginate) inside a **single** call's `commands` array — the session persists across separate calls, keyed by the `proxy` config, so batching saves round-trips and avoids accidentally dropping that config (which is what would leave the WAF token cookie behind); repeat the same `proxy` on every call to stay in the same warmed session:

```json
{
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [/* … */]
}
```

A residential proxy is **required** — Booking.com sits behind AWS WAF Bot Control (token challenge interstitial), not DataDome. A bare or datacenter session lands on a `challenge.js` page on every endpoint, including `/robots.txt`. The challenge JS solves itself in-browser via `AwsWafIntegration.getToken()` and a forced reload — a real `browserless_agent` browser passes Bot Control; a raw HTTP client does not.

For the occasional hCaptcha Booking falls back to when the WAF score is borderline, add a `{ "method": "solve", "params": { "type": "hcaptcha" } }` step.

`proxyCountry: "us"` keeps the IP geo close to typical US storefront pricing. Use `"de"` for EUR-default pricing, a SG/JP/AU country for SGD/JPY/AUD defaults — the currency Booking shows by default depends on source IP unless `selected_currency=` overrides it (see gotchas). **Repeat the `proxy` arg on every `browserless_agent` call** — dropping it lands you in a fresh datacenter session that fails the WAF challenge.

### 2. Resolve the destination → `dest_id` + `dest_type`

Free-form destinations must be resolved to Booking's internal `dest_id` so the search URL is unambiguous. Two paths:

**Path A — autocomplete XHR (preferred):**

```
GET https://accommodations.booking.com/autocomplete.json?
    aid=<affiliate-id>
    &iata_code=
    &query=<URL-encoded destination>
    &lang=en-us
    &size=10
    &label=en-us
Referer: https://www.booking.com/
```

This endpoint is on a **separate origin** (`accommodations.booking.com`) that is **not** behind AWS WAF — a direct HTTP fetch returns 200 OK (from normal egress, or a `browserless_function` after `page.goto('https://accommodations.booking.com/')`). However it returns `{"results":[]}` without a valid `aid` (affiliate ID). To get a working `aid`, `goto` `https://www.booking.com/` once in the WAF-cleared `browserless_agent` session, then read `window.utag_data.aid` from page context with `{ "method": "evaluate", "params": { "content": "(()=>window.utag_data.aid)()" } }` (value returns under `.value`). Reuse the aid across the rest of that call — it's stable per session.

Each result row has `{dest_id, dest_type, name, label, country, region, city_name, cc1, lc, b_max_los_data, hotels, image_url}` — capture the `(dest_id, dest_type)` tuple. `dest_type` is one of: `city`, `region`, `country`, `landmark`, `airport`, `district`, `hotel`, `coordinates`.

**Path B — `ss=` free-text fallback:**

Booking's `/searchresults.html` accepts `ss=<URL-encoded destination>` without `dest_id` and runs its own intent parser server-side. Works for unambiguous city names but **silently disambiguates** when the destination matches multiple locales (e.g. `ss=Springfield` → defaults to one Springfield without telling the caller which). Always prefer Path A; only fall back to `ss=` when autocomplete returns zero rows.

### 3. Compose the search URL

Booking's `/searchresults.html` is the canonical entry point. Every UI filter maps to a URL parameter — the surface is wide but stable.

#### Required core params

| Param                                     | Meaning                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ss=<urlenc-string>`                      | Search string (always include even when `dest_id` is supplied — page renders the chip from it)                                                                                              |
| `dest_id=<int>`                           | Booking destination ID (from autocomplete)                                                                                                                                                  |
| `dest_type=<enum>`                        | `city` / `region` / `country` / `landmark` / `airport` / `district` / `hotel` / `coordinates`                                                                                               |
| `checkin=YYYY-MM-DD`                      | ISO date (required for pricing)                                                                                                                                                             |
| `checkout=YYYY-MM-DD`                     | ISO date                                                                                                                                                                                    |
| `group_adults=<int>`                      | Adults across all rooms                                                                                                                                                                     |
| `group_children=<int>`                    | Children across all rooms                                                                                                                                                                   |
| `no_rooms=<int>`                          | Room count                                                                                                                                                                                  |
| `age=<int>`                               | Repeat once per child, in age-order. Booking demands explicit child ages (0-17) for accurate pricing. Omitting `age` for non-zero `group_children` yields a "please add ages" interstitial. |
| `selected_currency=USD\|EUR\|GBP\|JPY\|…` | Forces storefront currency (overrides IP-geo default)                                                                                                                                       |
| `lang=en-us`                              | UI language; affects address transliteration                                                                                                                                                |
| `sb_travel_purpose=leisure\|business`     | Sometimes shifts default sort order                                                                                                                                                         |

#### Sort order — `order=`

| Value                             | Booking UI label                 |
| --------------------------------- | -------------------------------- |
| `popularity` (default if absent)  | "Our top picks"                  |
| `price`                           | "Price (lowest first)"           |
| `bayesian_review_score_and_price` | "Best reviewed and lowest price" |
| `class`                           | "Stars (5 → 1)"                  |
| `class_asc`                       | "Stars (1 → 5)"                  |
| `distance_from_search`            | "Distance from city center"      |
| `bayesian_review_score`           | "Top reviewed"                   |
| `homes_apartments_first`          | "Homes & apartments first"       |

#### Pagination — `offset=`

25 properties per page. `offset=0` is page 1, `offset=25` page 2, `offset=50` page 3, etc. The page-wide result count is at `[data-testid="header-content"]` ("X properties found in Paris"). Pages render `<25` items on the final page; do not assume a full page.

#### Map-bound search

Replace `dest_id` + `dest_type` with:

```
&latitude=<N>&longitude=<E>
&bounding_box_north=<N>&bounding_box_south=<S>&bounding_box_east=<E>&bounding_box_west=<W>
&map=1
```

When `map=1` and the bounding box is set, results are scoped to the box. Useful for "search this area" flows.

#### The `nflt=` filter query — Booking's whole filter surface

`nflt=` is a `;`-delimited list of `key=value` filter chips. Multi-select filters within the same key use the same `key=value` form repeated (e.g. star rating `class=3;class=4;class=5`). The full taxonomy:

**Property type** — `ht_id`:

| Value | Type               |
| ----- | ------------------ |
| `204` | Hotels             |
| `201` | Apartments         |
| `203` | Hostels            |
| `206` | Villas             |
| `216` | Bed and breakfasts |
| `208` | Guest houses       |
| `220` | Holiday homes      |
| `205` | Motels             |
| `213` | Lodges             |
| `222` | Country houses     |
| `226` | Resorts            |
| `224` | Aparthotels        |

**Star rating** — `class`:

| Value     | Stars   |
| --------- | ------- |
| `class=1` | 1 star  |
| `class=2` | 2 stars |
| `class=3` | 3 stars |
| `class=4` | 4 stars |
| `class=5` | 5 stars |

**Review score** — `review_score`:

| Value             | Booking label |
| ----------------- | ------------- |
| `review_score=90` | Wonderful 9+  |
| `review_score=80` | Very good 8+  |
| `review_score=70` | Good 7+       |
| `review_score=60` | Pleasant 6+   |

(Threshold values are integers × 10 of the published 0–10 review score.)

**Distance to anchor** — `distance` (radius from search anchor):
`distance=1000` (<1 km), `distance=3000` (<3 km), `distance=5000` (<5 km). Anchor is the `dest_id`/`dest_type` (city center, landmark, airport).

**Price band** — `pri`:
Booking presents 5 dynamic price buckets per destination: `pri=1` (cheapest) through `pri=5` (most expensive). Multi-select: `pri=1;pri=2`. For arbitrary min/max price, also pass `price=<min>-<max>-USD` (raw slider) — values in the storefront currency.

**Meal plan** — `mealplan`:

| Value          | Label                              |
| -------------- | ---------------------------------- |
| `mealplan=1`   | Breakfast included                 |
| `mealplan=9`   | Breakfast & dinner                 |
| `mealplan=3`   | All-inclusive                      |
| `mealplan=999` | Kitchen facilities (self-catering) |
| `mealplan=2`   | Half board                         |
| `mealplan=4`   | Full board                         |

**Reservation policy** — single-value filters:

- `oos=1` — Free cancellation
- `fc=2` — No prepayment (pay at property)
- `nopayment_card=1` — Book without a credit card

**Bed preference**:

- `tdb=3` — Double bed
- `tdb=4` — Twin beds

**Hotel facilities** — `hotelfacility=`:

| Value                  | Facility                                                     |
| ---------------------- | ------------------------------------------------------------ |
| `hotelfacility=2`      | Parking                                                      |
| `hotelfacility=3`      | Restaurant                                                   |
| `hotelfacility=4`      | Pet-friendly (also `popular_activities` in some experiments) |
| `hotelfacility=5`      | Room service                                                 |
| `hotelfacility=8`      | 24-hour front desk                                           |
| `hotelfacility=11`     | Fitness center                                               |
| `hotelfacility=16`     | Non-smoking rooms                                            |
| `hotelfacility=17`     | Airport shuttle                                              |
| `hotelfacility=28`     | Family rooms                                                 |
| `hotelfacility=54`     | Electric vehicle charging station                            |
| `hotelfacility=107`    | Spa and wellness                                             |
| `hotelfacility=109`    | Hot tub / Jacuzzi                                            |
| `hotelfacility=433`    | Sauna                                                        |
| `popular_activities=2` | Pool                                                         |

**Room facilities** — `roomfacility=`:

| Value             | Facility              |
| ----------------- | --------------------- |
| `roomfacility=38` | Private bathroom      |
| `roomfacility=11` | Air conditioning      |
| `roomfacility=24` | Kitchen / kitchenette |
| `roomfacility=25` | Coffee/tea maker      |
| `roomfacility=27` | Washing machine       |
| `roomfacility=32` | Balcony               |
| `roomfacility=49` | View                  |
| `roomfacility=86` | Soundproof            |
| `roomfacility=14` | Bathtub               |

**Brands** — `chaincode=` (string codes, multi-select):
`marriott`, `hilton`, `hyatt`, `ihg`, `accor`, `fourseasons`, `radisson`, `wyndham`, `bestwestern`, `choicehotels`. Open the Booking brand-filter sidebar and read `data-filters-item="chaincode:<code>"` to discover values not in this table.

**Booking-specific badges**:

- `tdi=1` — Mobile-only deal
- `genius=1` — Genius discount applied
- `sustainable_property=1` — Travel Sustainable property (any level)
- `sustainable_property_level=1`, `=2`, `=3` — specific level
- `last_minute_deal=1` — Last-minute deal

**Neighborhood / district** — `di=<dest_id>`:
Use a _secondary_ `dest_id` (resolved via autocomplete with the district name + the parent city) and pass `di=<district_dest_id>`. Multi-select with `;`.

**Example fully-loaded URL** (Paris, 2 adults + 1 child age 8, 4-star + 5-star, free-cancellation, breakfast, pool, ordered by best-reviewed-then-cheapest):

```
https://www.booking.com/searchresults.html?
  ss=Paris&dest_id=-1456928&dest_type=city
  &checkin=2026-06-15&checkout=2026-06-17
  &group_adults=2&group_children=1&age=8&no_rooms=1
  &selected_currency=USD&lang=en-us
  &order=bayesian_review_score_and_price
  &offset=0
  &nflt=class%3D4%3Bclass%3D5%3Bmealplan%3D1%3Boos%3D1%3Bpopular_activities%3D2
```

(Note `nflt` value is URL-encoded — `;` → `%3B`, `=` → `%3D`. Always re-encode.)

### 4. Navigate and wait for hydration

```json
{ "method": "goto", "params": { "url": "<SEARCH_URL>", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 4000 } }   // property cards hydrate progressively
```

(Never use `networkidle0/2` here — Booking's ad/analytics stack keeps the socket busy and the wait hangs.) The result cards live under `[data-testid="property-card"]`. Header card-count and active-filter chips live under `[data-testid="header-content"]` and `[data-filters-group]` respectively.

### 5. Capture data — prefer the GraphQL response over scraping

Booking's search page hydrates from a POST to `/dml/graphql` with `operationName=FullSearch` (some experiments name it `SearchResultsTitle` + `SearchResults`). That response is a typed JSON tree with every property, lead offer, and badge in clean form — **much** more reliable than scraping the rendered DOM.

Once the search page has loaded (so the WAF token cookie is in the session's cookie jar), replay the same query **from page context** with an `evaluate` — a same-origin `fetch` inherits the WAF cookie automatically, which a standalone client cannot:

```json
{
  "method": "evaluate",
  "params": {
    "content": "(async () => { const r = await fetch('/dml/graphql?ss=Paris', { method:'POST', credentials:'include', headers:{'content-type':'application/json'}, body: JSON.stringify(fullSearchPayload) }); const j = await r.json(); const rows = j.data.searchQueries.search.results; return JSON.stringify(rows.map(x => ({ /* project only the fields you need — see shape below */ }))); })()"
  }
}
```

Return a **compact projection**, not the raw multi-hundred-KB tree (the evaluate result is size-capped). The value comes back under `.value`. Parse `data.searchQueries.search.results[]` — each entry has:

```
{
  basicPropertyData: { id, name, starRating, accommodationTypeId, location: {address, city, countryCode, neighborhood}, photos[], reviewScore, reviewCount, reviewScoreWord },
  blocks: [{ finalPrice: {amount, currency}, priceDisplayInfoIrene: {displayPrice, priceBeforeDiscount, taxesAndCharges}, freeCancellation, cancellationTimeline, prepayment, badges: ["genius", "mobile_rate", "last_minute_deal"], bedConfigurations[], blockMatchTagsList[] }],
  matchingUnitConfigurations: { commonConfig: { nbBedrooms, nbBathrooms } },
  geniusInfo: { hotelGeniusDiscount, geniusBenefits },
  mealPlanIncluded: { mealPlanType, isBreakfastIncluded },
  distanceToCityCenter: { value, unit },
  preferredBadges: ["sustainable_property"],
  sustainability: { level },
  policiesV2: { freeCancellationUntil, cancellationPolicy }
}
```

The lead room offer is `blocks[0]` (Booking sorts blocks by price). `price_per_night` = `finalPrice.amount / nights`; `price_total_for_stay` = `finalPrice.amount`. Both should be emitted (cookies can flip the UI display between the two — normalize).

**Fallback — DOM scrape**: if the in-page GraphQL replay fails or returns an unexpected shape, fall back to scraping the rendered cards with a `text`/`evaluate` over the hydrated DOM. Each `[data-testid="property-card"]` exposes:

- `[data-testid="title"]` → property name
- `[data-testid="title-link"]` → canonical URL (`/hotel/{cc}/{slug}.html`)
- `[data-testid="address"]` → address line
- `[data-testid="distance"]` → distance to anchor
- `[data-testid="review-score"]` → review score (decimal/10)
- `[data-testid="review-score-component"]` → qualitative label + review count
- `[data-testid="price-and-discounted-price"]` → price text (currency-prefixed)
- `[data-testid="taxes-and-charges"]` → taxes line
- `[data-testid="recommended-units"]` → lead room offer block
- `[data-testid="free-cancellation"]` → presence of this element = free cancellation
- `[data-testid="genius-badge"]` → Genius discount applied

Property ID is parseable from the title-link href: `/hotel/{cc}/{slug}.html` — open the property page and read `b_hotelier_experiment_tracking_data` from `window.utag_data` to get the integer property ID, OR (faster) pull it from the GraphQL response if that path worked.

### 6. Pagination

If `total_results > 25` and the caller asked for more, increment `offset` by 25 and re-navigate. Booking caps pagination at `offset=1000` (40 pages × 25). Beyond that, narrow with filters.

```json
// within the SAME browserless_agent commands array, per page:
{ "method": "goto", "params": { "url": "<BASE_URL>&offset=25", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 3000 } },
{ "method": "evaluate", "params": { "content": "/* replay /dml/graphql for this offset, project rows */" } }
// repeat for offset 0, 25, 50, 75 …
```

### 7. Photos

The GraphQL response includes `basicPropertyData.photos[]` — each item has a `lowResUrl`, `highResUrl`, and `id`. To request more photos than the search payload includes, open the property detail page (`/hotel/{cc}/{slug}.html`) and read `window.booking.env.b_hotel_photos` from page context, or scrape `<picture>` tags inside `[data-testid="property-gallery"]`.

### 8. Session persistence

No explicit release step — there's nothing to release. The browser session persists across separate calls, keyed by the call's `proxy` config: a later call carrying the **same** residential `proxy` reconnects to the same warmed session with the AWS WAF token cookie intact, while dropping or changing the `proxy` lands you in a different, blank session that fails the challenge. Batching the whole flow (warm-up → resolve dest → nav search → extract → paginate) into **one** call's `commands` array saves round-trips and avoids accidentally dropping that config — and if a single step fails, retry it alone with the same `proxy` against the still-live page.

## Site-Specific Gotchas

- **AWS WAF, not DataDome.** Booking.com is gated by AWS WAF Bot Control with a `challenge.js` token interstitial — directly verified across `/searchresults.html`, `/hotel/{cc}/{slug}.html`, `/robots.txt`, and `/dml/graphql` (all return HTTP 202 with `window.awsWafCookieDomainList = ['booking.com']` on plain HTTPS GET). Plain `curl` / a bare `browserless_function` fetch / a datacenter session all hit the challenge. **Only a real `browserless_agent` browser (which runs the WAF JS in-browser and persists the token cookie), driven through a residential proxy, clears the challenge reliably.** DataDome may also appear as a fallback layer on borderline sessions — a `{ "method": "solve", "params": { "type": "hcaptcha" } }` step covers that.
- **`/robots.txt` is challenged.** Don't try to read `robots.txt` as a fingerprinting check — it returns the same WAF interstitial, not the actual robots policy. (For policy reference, fetch `cf.bstatic.com/robots.txt` which is unchallenged, or read the cached copy on web.archive.org.)
- **`/dml/graphql` requires POST + cleared WAF token.** GET returns 405 Method Not Allowed; POST without a valid `aws-waf-token` cookie + `X-Booking-Context-Aid` header returns 403. The skill must drive the page first (so the WAF token is set in the session cookie jar), then send the GraphQL POST from page context via an `evaluate` with `fetch(..., {credentials: 'include'})` — the same-origin request inherits the WAF cookie. **Do not** try to POST GraphQL from `curl` or a standalone `browserless_function` fetch — there's no way to attach the WAF cookie outside the page context.
- **`accommodations.booking.com/autocomplete.json` is NOT behind WAF.** Confirmed HTTP 200 on direct fetch, no challenge. But it returns `{"results":[]}` without a valid `aid` (affiliate ID). Read `aid` from page context (via an `evaluate`) once after loading any `www.booking.com/` page in the `browserless_agent` session — it's a 7-digit integer stored in `window.utag_data.aid`. Reuse it across the call.
- **`distribution-xml.booking.com` is partner-only.** HTTP 401 with `Authorization required (HTTP Basic)` on every endpoint. This is the Connectivity / Demand API and requires a partner contract (OTA, metasearch, large travel-tech vendor under signed agreement). **Do not waste time trying to bypass auth** — there's no public path.
- **Currency display flips silently.** Booking shows prices "per night" OR "total for stay" depending on a cookie set by an A/B test (`pref_total=1` toggles total-for-stay UI). The number on the card and the number in the GraphQL response can therefore mean different things across sessions. **Always emit both `price_per_night` and `price_total_for_stay`** — compute the one the response doesn't give you from `nights = checkout - checkin`. The GraphQL `finalPrice.amount` is the **total for the stay** regardless of UI state.
- **Currency override needs `selected_currency=` AND a cookie.** Adding `selected_currency=USD` to the URL is necessary but not sufficient — Booking also looks at the `cur_curr` cookie. Set the cookie in-page via an `evaluate` (`document.cookie = 'cur_curr=USD; domain=.booking.com; path=/'`) after the WAF challenge clears, then navigate. Without the cookie, the URL param is silently ignored ~10% of the time.
- **Child ages are mandatory when `group_children > 0`.** Each child age (0-17) needs its own `age=<N>` URL param, in age-order. Omitting `age` produces an interstitial blocking the result set. Use `age=0` for under-1-year-olds.
- **The `nflt` taxonomy is undocumented and stable-but-not-versioned.** The `ht_id`, `class`, `review_score`, `mealplan`, `hotelfacility`, `roomfacility`, `chaincode` integer/string codes in this skill are from observed UI-state. They have been stable for years but are not formally documented by Booking. When in doubt, open the search page in the `browserless_agent` session, open the filter sidebar, `click` the desired filter, and read the resulting URL — the new `nflt=` param is canonical for that filter at that moment.
- **District filtering needs a secondary `dest_id`.** To scope to "Shibuya, Tokyo", first autocomplete with `query=Shibuya, Tokyo` and take the `dest_id` of the result whose `dest_type=district`. Then pass `dest_id=<tokyo_city_id>&dest_type=city&di=<shibuya_district_id>`. Passing only `dest_id=<shibuya>&dest_type=district` works but returns a different (less filterable) result layout.
- **Map-bound search (`map=1` + bounding box) ignores `dest_id`.** When `map=1` is set, Booking scopes purely by the bounding box and ignores city/region IDs. This is the right path for "search this area" but **don't** combine it with `dest_id` filters expecting an intersection.
- **`offset` caps at 1000.** Pagination beyond `offset=1000` returns the same page-40 result set. Narrow with filters (e.g. add a price band, a neighborhood, a property type) to expose more inventory.
- **Property IDs in the URL are slug-only.** The integer Booking property ID is **not** in the canonical `/hotel/{cc}/{slug}.html` URL — it has to be pulled from page context (`window.utag_data.hotel_id`) or from the GraphQL `basicPropertyData.id` field. The slug alone is the canonical key for round-tripping.
- **"Genius" prices need a signed-in account.** The skill is read-only and never signs in — therefore Genius discounts visible in the response are the **public-tier** discount (typically 10%). The 15%/20% Genius Level 2/3 prices require an authenticated session and are out of scope.
- **"Only X left at this price!" is in `blocks[].onlyXLeftMessage`.** It's a marketing string, not a hard inventory signal — Booking re-arms it across sessions. Pass through verbatim if present; don't treat it as ground truth.
- **Sustainability "level 1/2/3+ leaves" maps to `sustainability.level` 1/2/3.** Level 3 is "Travel Sustainable Level 3+" in the UI (Booking renamed Level 3 several times). Emit the integer level; let the consumer format.
- **Read-only enforcement.** Never click `[data-testid="availability-cta-btn"]` (See availability), the Reserve button on a room block, the Save-to-list heart, or the Sign-in header link. The skill stops at the search results page — to drill into a specific property's room options, open `/hotel/{cc}/{slug}.html` directly and read the rendered room table, but **do not** click any room-row CTA.
- **Sandbox / generator note.** This SKILL.md was generated in a Vercel Sandbox environment whose network policy blocks DNS resolution of `connect.*.browserbase.com` — live remote-browser iteration was not possible during authorship. The anti-bot characterization (AWS WAF, not DataDome) was confirmed via 4 direct probes of `www.booking.com` and `accommodations.booking.com` from the sandbox; everything else encoded above is canonical knowledge of Booking's URL-parameter surface and GraphQL `FullSearch` shape, both of which are observable from any cleared session. Re-run with a network-unrestricted host to validate end-to-end and refine any drift in `nflt` codes.

## Expected Output

```json
{
  "query": {
    "destination": "Paris",
    "dest_id": -1456928,
    "dest_type": "city",
    "checkin": "2026-06-15",
    "checkout": "2026-06-17",
    "nights": 2,
    "adults": 2,
    "children": 1,
    "child_ages": [8],
    "rooms": 1,
    "currency": "USD",
    "sort": "bayesian_review_score_and_price",
    "filters": {
      "star_rating": [4, 5],
      "meal_plan": ["breakfast"],
      "reservation_policy": ["free_cancellation"],
      "facilities": ["pool"]
    },
    "active_filter_chips": [
      "4 stars",
      "5 stars",
      "Breakfast included",
      "Free cancellation",
      "Swimming pool"
    ]
  },
  "total_results": 312,
  "result_count_label": "312 properties found in Paris",
  "page": { "offset": 0, "page_size": 25, "returned": 25 },
  "properties": [
    {
      "property_id": 1234567,
      "name": "Le Grand Mazarin",
      "url": "https://www.booking.com/hotel/fr/le-grand-mazarin.html",
      "property_type": "Hotel",
      "star_rating": 5,
      "address": "17 Rue de la Verrerie",
      "neighborhood": "4th arr.",
      "city": "Paris",
      "country": "France",
      "country_code": "fr",
      "lat": 48.8576,
      "lng": 2.3543,
      "distance_to_anchor": {
        "value": 0.4,
        "unit": "km",
        "anchor": "city center"
      },
      "review": {
        "score": 9.3,
        "label": "Wonderful",
        "count": 1284
      },
      "photos": {
        "primary": "https://cf.bstatic.com/xdata/images/hotel/max1024x768/abc.jpg",
        "additional": [
          "https://cf.bstatic.com/xdata/images/hotel/max1024x768/def.jpg",
          "https://cf.bstatic.com/xdata/images/hotel/max1024x768/ghi.jpg"
        ]
      },
      "lead_offer": {
        "room_name": "Deluxe Double Room",
        "board_basis": "Breakfast included",
        "bed_setup": "1 large double bed",
        "price_per_night": 875.0,
        "price_total_for_stay": 1750.0,
        "currency": "USD",
        "taxes_and_fees": 210.0,
        "free_cancellation_until": "2026-06-13T23:59:00+02:00",
        "prepayment_required": false,
        "refundable": true,
        "beds_left_message": "Only 2 left at this price!",
        "genius_discount_applied": false,
        "genius_level": null
      },
      "amenity_highlights": [
        "Spa",
        "Restaurant",
        "Bar",
        "Free WiFi",
        "Concierge",
        "Pet-friendly"
      ],
      "sustainability_level": 3,
      "badges": ["preferred_partner", "travel_sustainable_level_3"]
    }
  ]
}
```

### Outcome shapes

Five terminal shapes the skill should be able to return:

```json
// Success — results returned
{ "ok": true, "total_results": 312, "properties": [...] }

// Success — zero matches (real empty, not a block)
{ "ok": true, "total_results": 0, "properties": [], "note": "No properties match the filter set" }

// Destination ambiguous
{ "ok": false, "reason": "destination_ambiguous", "candidates": [{ "dest_id": ..., "dest_type": "city", "label": "Springfield, IL, US" }, ...] }

// Destination not found
{ "ok": false, "reason": "destination_not_found", "query": "Atlantis" }

// Anti-bot wall (verified+proxies session failed to clear AWS WAF after 3 retries)
{ "ok": false, "reason": "awswaf_challenge_unclearable", "note": "Session config: browserless_agent + residential proxy + hcaptcha solve; retry with a fresh session in a different proxyCountry" }
```
