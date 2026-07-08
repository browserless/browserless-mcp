---
name: get-school-rating
title: Realtor.com School Rating Lookup
description: >-
  Given a school name + city/state, a Realtor.com school detail URL, or a
  property address, return the school's GreatSchools rating, parent-reviews
  summary, grades served, enrollment, student-teacher ratio, district, address,
  NCES code, and canonical URL. For property addresses, returns the list of
  assigned elementary / middle / high schools with each school's rating.
website: realtor.com
category: real-estate
tags:
  - real-estate
  - schools
  - ratings
  - great-schools
  - realtor
  - read-only
  - kasada
source: 'browserless: agent-runtime 2026-05-16'
updated: '2026-05-16'
recommended_method: api
alternative_methods: []
verified: false
proxies: false
---

# Realtor.com School Rating Lookup

## Purpose

Return Realtor.com's school-detail payload for a given school — GreatSchools rating (1–10), parent-reviews summary (count + average), grades served, total enrollment, student-teacher ratio, district name + id, address, NCES code, GreatSchools id, catchment polygon (when present), and the canonical Realtor.com school-detail URL. Accepts three input shapes: a direct Realtor.com school URL, a school name + city/state, or a property address (which is resolved to its assigned elementary / middle / high schools). Read-only.

## When to Use

- A property-search agent needs school ratings to score listings.
- A relocation agent comparing assigned-school quality across candidate addresses.
- Bulk extraction of school metadata + catchment polygons across a metro.
- Anywhere you'd otherwise scrape Realtor.com's school-detail HTML — the embedded `__NEXT_DATA__` JSON is faster, structurally stable, and renders without JS.

## Workflow

Realtor.com's school-detail pages ship a fully populated `<script id="__NEXT_DATA__" type="application/json">` hydration blob inline in the HTML. **No bot challenge fires on the school-detail surface** — a single **no-proxy** `browserless_agent` call (`goto` + `evaluate` to pull and parse the blob in-page) is sufficient (~250–430 KB page, one round-trip). All required fields (`rating`, `parent_rating`, `review_count`, `student_count`, `student_teacher_ratio`, `grades[]`, `education_levels[]`, `nces_code`, `greatschools_id`, `district.{id,name}`, `location.{...}`, `boundary` GeoJSON catchment) live under `props.pageProps.school` in that blob. **Lead with that plain goto+evaluate** — the residential-proxy browser path is only needed for the property-address input, because property-detail pages sit behind Kasada Bot Defense (see Gotchas).

### Step 1 — Normalize the input to a canonical school-detail URL

The canonical URL pattern is:

```
https://www.realtor.com/local/schools/{slug_id}
```

where `{slug_id}` = `{Name-With-Dashes}-{schoolId}` — e.g. `Sylvia-Mendez-Elementary-078571861`, `Poway-High-School-078657741`. `schoolId` is Realtor.com's internal id (9–10 digit numeric string, **not** the NCES id and **not** the GreatSchools id).

**Input shape (a): direct school-detail URL** → skip to Step 2.

**Input shape (b): school name + city/state** → resolve via the public autocomplete API (no auth, no anti-bot, no proxy):

```
GET https://parser-external.geo.moveaws.com/suggest
    ?input=<urlenc "<name> <city> <state>">
    &client_id=rdc-search-default
    &area_types=school
    &limit=10
```

These `parser-external.geo.moveaws.com/suggest` calls are plain HTTPS GETs — run them from any client. Only under restricted egress, route each through `browserless_function`: `page.goto('https://parser-external.geo.moveaws.com/')` first, then `page.evaluate(async () => fetch('/suggest?...').then(r => r.json()))` (the function runtime is a browser page context with no network egress until the page navigates to the origin).

Take the highest-scoring `autocomplete[i]` whose `area_type === "school"`. The result includes `slug_id`, `school_id`, `school`, `line` (address), `city`, `postal_code`, `state_code`, `centroid.{lat,lon}`, and `has_catchment` (boolean — whether the school has a GeoJSON catchment polygon attached). Construct the URL as `https://www.realtor.com/local/schools/{autocomplete[0].slug_id}`.

If `autocomplete` is empty, retry once with `area_types` omitted (some out-of-database schools surface only when the type filter is dropped). If still empty, emit `{success: false, reason: "school_not_found"}`.

**Input shape (c): property address** → see "Property-address flow" below.

### Step 2 — Open the school-detail page and pull the blob in-page

One `browserless_agent` call, no proxy, `goto` + `evaluate`:

```json
{
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.realtor.com/local/schools/{slug_id}",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ const el = document.getElementById('__NEXT_DATA__'); if (!el) return JSON.stringify({ error: 'no_next_data' }); const school = JSON.parse(el.textContent).props.pageProps.school; return JSON.stringify(school); })()"
      }
    }
  ]
}
```

School-detail pages render the full hydration JSON without any proxy or anti-bot handling. The `evaluate` returns the parsed `school` object under `.value` (project it further in-page if it approaches the ~200k-char result cap — the `boundary` polygon can be large). If the `goto` lands on a Kasada interstitial instead (`document.title` / body would contain `KPSDK` / "reference ID"), retry once; if it recurs, fall back to a residential-proxy session (see Step 5).

### Step 3 — Read the fields off the parsed blob

The `evaluate` above already returns `props.pageProps.school`. All fields live under `school` (see "Field map" below). The page also exposes `props.pageProps.district` (often `null` — district data is denormalized into `school.district`) and `props.pageProps.nearbySchools` (which despite the name is **nearby cities/areas metadata, not nearby schools** — do not use this for assigned-schools).

### Step 4 — Emit the consolidated output

Map the parsed fields per the schemas in **Expected Output**. Critical mappings:

| Output field             | Source path in `__NEXT_DATA__`                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `great_schools_rating`   | `school.rating` (int 1–10, or `null` for private schools)                                                                                            |
| `parent_reviews.average` | `school.parent_rating` (int 1–5, or `null` if `review_count === 0`)                                                                                  |
| `parent_reviews.count`   | `school.review_count`                                                                                                                                |
| `grades_served`          | `school.grades` (array of strings like `["K","1",...,"5"]` — format for display as `"K-5"` if first=`"K"` and last=`numeric`, else join with commas) |
| `education_levels`       | `school.education_levels` (array, e.g. `["elementary"]` or `["elementary","middle","high"]` for K-12)                                                |
| `enrollment`             | `school.student_count` (int)                                                                                                                         |
| `student_teacher_ratio`  | `school.student_teacher_ratio` (float like `16.3`, **or `null` for private schools** — see gotcha)                                                   |
| `district`               | `school.district.name` (string) — note `school.district.id` is a 11-char internal id, not the NCES district id                                       |
| `address`                | concatenate `school.location.{street, city, state, postal_code}`                                                                                     |
| `nces_id`                | `school.nces_code` (string — sometimes 12 digits, sometimes 8 for older entries)                                                                     |
| `great_schools_id`       | `school.greatschools_id`                                                                                                                             |
| `funding_type`           | `school.funding_type` ∈ `"public"`, `"private"`, `"charter"`                                                                                         |
| `url`                    | `https://www.realtor.com/local/schools/{school.slug_id}`                                                                                             |
| `catchment_polygon`      | `school.boundary` (GeoJSON `MultiPolygon` — present only for public schools with `has_catchment: true`)                                              |

### Step 5 — Browser fallback (only on Kasada wall)

If the plain no-proxy `goto` ever lands on a Kasada interstitial (a < 2 KB body containing `KPSDK` and "reference ID") on a school-detail URL — **uncommon, but observed under aggressive batched requests** — re-issue the same call with a residential proxy:

```json
{
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.realtor.com/local/schools/{slug_id}",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ const el = document.getElementById('__NEXT_DATA__'); return el ? el.textContent : null; })()"
      }
    }
  ]
}
```

The `__NEXT_DATA__` blob renders identically here as on the plain path — parse it the same way. There's no release step — the session persists across calls keyed by `proxy`, so nothing needs tearing down.

### Property-address flow (input shape c)

The Realtor.com property-detail page (`/realestateandhomes-detail/...`) is **Kasada Bot Defense-protected** and a proxy-less `browserless_agent` `goto` always lands on the interstitial. Two viable paths:

**Path A — Catchment point-in-polygon (preferred; no property-detail page).** Use this when the address has a known lat/lon and you only need elementary / middle / high assigned schools.

1. Resolve the address with the suggest API:
   ```
   GET https://parser-external.geo.moveaws.com/suggest
       ?input=<urlenc address>
       &client_id=rdc-search-default
       &area_types=address
       &limit=5
   ```
   Take the top result; record `centroid.{lat,lon}` and `mpr_id`.
2. Fetch the city's candidate schools via the suggest API (one call per education level you need):
   ```
   GET https://parser-external.geo.moveaws.com/suggest
       ?input=<urlenc "elementary <city>">
       &client_id=rdc-search-default
       &area_types=school
       &limit=20
   ```
   Filter results to those with `has_catchment: true` and same `state_code` as the address.
3. For each candidate, open its detail page with a no-proxy `browserless_agent` `goto` + `evaluate` (the Step 2 pattern) and read `school.boundary` (GeoJSON `MultiPolygon`) out of the returned blob. Run point-in-polygon (Shapely `Point(lon, lat).within(shape(boundary))` or `turf.booleanPointInPolygon`) against the address centroid. You can also fold the point-in-polygon test into the in-page `evaluate` and return just a boolean + the school payload to keep results small.
4. Repeat for `middle` and `high` (use `input=middle <city>` / `input=high <city>`).
5. Emit one record per level with the matched school's full payload.

This path costs ~5–10 school-detail `browserless_agent` calls per address and **completely avoids the property-detail page and Kasada**.

**Path B — Live browser to property page (fallback).** Use when point-in-polygon is ambiguous (no candidate boundary contains the address — happens at district edges or in non-CA states with non-residential zoning), or when you need the exact "assigned schools" panel as Realtor.com renders it.

```json
{
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.realtor.com/realestateandhomes-detail/{address-slug}_{property-id}",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    { "method": "waitForTimeout", "params": { "time": 3000 } },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ const el = document.getElementById('__NEXT_DATA__'); if (!el) return null; const s = JSON.parse(el.textContent).props.pageProps.propertyDetail.schools || []; return JSON.stringify(s.filter(x => x.assigned === true)); })()"
      }
    }
  ]
}
```

The property page also ships a `__NEXT_DATA__` blob — the `evaluate` reads `props.pageProps.propertyDetail.schools[]` (each item has `school_id`, `slug_id`, `assigned: true|false`, `funding_type`, `rating`, `grades`, `education_levels`, `distance_in_miles`) and filters on `assigned === true` for the catchment-assigned list. The assigned-schools panel is usually rendered without scrolling; if the array comes back empty, add a `{ "method": "scroll", "params": { "direction": "down" } }` before the `evaluate` to force the "Schools" section to hydrate. The residential `proxy` arg is **mandatory** on this call — a proxy-less agent call gets Kasada-blocked on the first page load (Kasada isn't a `solve`-able type; the real browser + residential proxy clears it). Batching the whole flow in this one call's `commands` array is convenient; the session persists across calls keyed by `proxy`, so there's no release step — just repeat the same `proxy` on any follow-up call.

## Site-Specific Gotchas

- **READ-ONLY.** Never click "Save", "Contact agent", or any property-action button — the skill exists to extract data, not to interact.
- **The anti-bot is Kasada, not PerimeterX or DataDome.** The interstitial fingerprints are `<script>window.KPSDK={}` and a request path of the form `/{uuid}/{uuid}/ips.js?KP_UIDz=…`. Don't waste time configuring DataDome cookie spoofing or PerimeterX header bypasses — they're the wrong vendor. A real browser driven through `browserless_agent` with a residential `proxy` (`proxy: { proxy: "residential", proxyCountry: "us" }`) is the only known consistent bypass for the protected surfaces — Kasada isn't a `solve`-able type, so it's the live JS runtime + residential IP that clears the challenge, not a captcha solver.
- **School-detail pages are NOT Kasada-protected** (verified across 7 schools across multiple states + funding types, 2026-05-16). A plain no-proxy `browserless_agent` `goto` + `evaluate` returns the full `__NEXT_DATA__` blob without any proxy or anti-bot handling — this is the canonical fast path for the school-detail and name-lookup input shapes. Treat a failure on a `/local/schools/...` URL as a transient hiccup, not a vendor change.
- **The `/local/schools/search?searchTerm=...` URL is a dead end.** It resolves to Realtor.com's internal `_error` page (page `/_error` in `__NEXT_DATA__`, query `{searchTerm, slugId: "search"}`). Don't use it. Use the `parser-external.geo.moveaws.com/suggest` API instead.
- **`props.pageProps.nearbySchools` is a misnomer** — its actual contents are nearby cities / neighborhoods / counties / zips metadata (`slug_id`, `geo_statistics`, `recommended_cities`, etc.), **not** other schools. Don't try to read assigned-schools from it.
- **Private schools have `null` ratings.** GreatSchools doesn't rate private schools. For `funding_type === "private"`, expect `rating: null`, `student_teacher_ratio: null`, `district.name: null` (but `district.id` is still populated with a synthetic state-prefix code like `"06151428551"`), and `boundary: null` (no catchment). Emit `great_schools_rating: null` + a `null_rating_reason: "private_school_not_rated"` flag rather than failing.
- **`school.assigned` is always `null` on the school-detail page.** That field exists in the schema but is only populated when the school is referenced from a property-detail-page context. Don't read it from the school page.
- **`school.boundary` is a GeoJSON `MultiPolygon`.** When present (public schools with `has_catchment: true`), it's a real catchment polygon usable for point-in-polygon assignment — see the Property-address Path A above. Polygons are sometimes 1000+ vertices; budget memory accordingly when iterating across a district.
- **`nces_code` length varies.** Newer / mainstream entries are 12 digits (e.g. `060474000447`); older charter / private entries are 8 (`02061017`). Both are valid — do not zero-pad or strip leading zeros.
- **Two different ids on the same school.** `school.id` (and `school.slug_id` trailing segment) is Realtor.com's internal id (9-10 digits, e.g. `078571861` or `0772862241`). `school.greatschools_id` is the upstream GreatSchools id (typically 7 digits, e.g. `0600034`). `school.nces_code` is the federal id. **The slug_id always uses `school.id`, not the GreatSchools id** — never construct URLs with the GreatSchools id.
- **`school.district.id` is NOT the federal NCES district id.** It's Realtor.com's internal id (11 chars, e.g. `06151428611`). There is no NCES district code surfaced in the payload. If your output schema requires the federal district id, look it up separately.
- **`school.grades` is an array of strings, not a range.** Public-school payloads use values like `["K", "1", "2", "3", "4", "5"]`; preK is `"PK"`. Render to `"K-5"` only when the array is contiguous; otherwise join with commas. Don't assume integer ordering — `"K"` and `"PK"` sort before `"1"` lexically only if you special-case them.
- **`school.student_teacher_ratio` is a float, not a colon string.** Realtor.com returns `16.3`; format to `"16.3:1"` only at the output layer.
- **`parser-external.geo.moveaws.com/suggest` query whitelist is strict.** Accepted params: `input`, `client_id`, `area_types`, `limit`, `include`. `postal_code`, `city`, `state`, `lat`, `lon`, `has_catchment` are all rejected with `whitelistValidation` 400s. Filter / scope results client-side after the call.
- **The suggest API is unauthenticated and not rate-limited at typical agent volumes** (tested at low double-digits RPS without throttling, 2026-05-16). It exposes school + address + city + street + county + zip area types. `client_id=rdc-search-default` is the Realtor.com web app's id; any non-empty value seems to work, but stick to `rdc-search-default` for forward-compat.
- **A raw (non-browser) HTTP fetch does not bypass Kasada, even through a residential proxy.** Kasada requires JS execution to clear the interstitial; a plain fetch doesn't run JS regardless of proxy. For property-detail pages you need the real browser — a `browserless_agent` `goto` with a residential `proxy` — so the page's JS challenge actually runs. Verified 2026-05-16 that both proxied and unproxied raw fetches on `/realestateandhomes-detail/...` return the same Kasada interstitial.
- **Confirmed dead ends — don't re-probe:**
  - `https://www.realtor.com/api/v1/schools/search` → 404 ("Cannot GET").
  - `https://www.realtor.com/api/v1/hulk` → 403.
  - `https://www.realtor.com/api/v1/rdc_search/schools` → 404.
  - `parser-external.geo.moveaws.com/schools`, `/schools_search`, `/locality`, `/reverse_geocode` → 404.
  - `m.realtor.com/...` → 301 to `www.realtor.com` (no separate mobile surface).

## Expected Output

### Input shape (a) / (b) — school detail URL or name+city/state

```json
{
  "success": true,
  "input_type": "school_detail_url",
  "school": {
    "name": "Sylvia Mendez Elementary",
    "school_id": "078571861",
    "slug_id": "Sylvia-Mendez-Elementary-078571861",
    "great_schools_id": "0600032",
    "nces_id": "060474000445",
    "funding_type": "public",
    "education_levels": ["elementary"],
    "grades_served": "K-5",
    "great_schools_rating": 7,
    "parent_reviews": { "count": 4, "average": 5 },
    "enrollment": 379,
    "student_teacher_ratio": "16.3:1",
    "district": {
      "name": "Berkeley Unified School District",
      "realtor_id": "06151428611"
    },
    "address": "2840 Ellsworth Street, Berkeley, CA 94705",
    "coordinate": { "lat": 37.857694, "lon": -122.262234 },
    "phone": "(510) 644-6290",
    "url": "https://www.realtor.com/local/schools/Sylvia-Mendez-Elementary-078571861",
    "has_catchment": true
  }
}
```

### Private school (null rating)

```json
{
  "success": true,
  "input_type": "school_name",
  "school": {
    "name": "Fairmont Private Schools - Historic Anaheim Campus",
    "school_id": "078696341",
    "funding_type": "private",
    "education_levels": ["elementary", "middle", "high"],
    "grades_served": "PK-12",
    "great_schools_rating": null,
    "null_rating_reason": "private_school_not_rated",
    "parent_reviews": { "count": 15, "average": 4 },
    "enrollment": 1835,
    "student_teacher_ratio": null,
    "district": { "name": null, "realtor_id": "06151428551" },
    "address": "...",
    "url": "https://www.realtor.com/local/schools/Fairmont-Private-Schools-Historic-Anaheim-Campus-078696341",
    "has_catchment": false
  }
}
```

### Input shape (c) — property address

```json
{
  "success": true,
  "input_type": "property_address",
  "property": {
    "address": "680 Grizzly Peak Blvd, Berkeley, CA 94708",
    "mpr_id": "1299668687",
    "coordinate": { "lat": 37.899275, "lon": -122.265644 },
    "url": "https://www.realtor.com/realestateandhomes-detail/680-Grizzly-Peak-Blvd_Berkeley_CA_94708_M12996-68687",
    "resolution_method": "catchment_point_in_polygon"
  },
  "assigned_schools": [
    {
      "level": "elementary",
      "name": "...",
      "school_id": "...",
      "great_schools_rating": 9,
      "grades_served": "K-5",
      "url": "..."
    },
    {
      "level": "middle",
      "name": "...",
      "school_id": "...",
      "great_schools_rating": 7,
      "grades_served": "6-8",
      "url": "..."
    },
    {
      "level": "high",
      "name": "...",
      "school_id": "...",
      "great_schools_rating": 8,
      "grades_served": "9-12",
      "url": "..."
    }
  ]
}
```

### Failure shapes

```json
// School name doesn't match anything in the suggest API
{ "success": false, "reason": "school_not_found", "input": "Foo Bar Academy Nowhere XX" }

// School-detail URL returned the Kasada interstitial AND browser fallback also failed
{ "success": false, "reason": "anti_bot_block", "vendor": "kasada", "evidence": "KPSDK present in 1.8KB response" }

// __NEXT_DATA__ block was missing or props.pageProps.school was empty
{ "success": false, "reason": "data_not_hydrated", "evidence": "no __NEXT_DATA__ script in response" }

// Property address: address resolves but no candidate school's boundary contains the point (district edge, non-residential parcel, or unincorporated area)
{ "success": false, "reason": "no_catchment_match", "address": "...", "candidates_checked": 12 }

// Property address: live-browser fallback blocked by Kasada despite Verified + proxies
{ "success": false, "reason": "anti_bot_block", "vendor": "kasada", "where": "property_detail_page" }
```
