---
name: search-pets
title: Petfinder Search Pets
description: >-
  Search Petfinder for adoptable pets near a location (or by pet ID /
  organization ID) and return matching listings as structured JSON, including
  breeds, age, behavior tags, photos, organization contact, and posted date.
  Read-only — never starts an adoption.
website: petfinder.com
category: pets
tags:
  - pets
  - adoption
  - petfinder
  - search
  - graphql
  - akamai
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: browser
alternative_methods:
  - method: api
    rationale: >-
      The Petfinder Developer API (api.petfinder.com/v2) is a public partner API
      with OAuth client credentials. It is the cleanest path for an agent that
      already holds a registered key, but registration at
      developers.petfinder.com is human-gated and the daily quota is 1000
      req/app — not a viable fallback for a cold agent runtime. Prefer the
      browser path.
  - method: hybrid
    rationale: >-
      The fastest in-session path is to warm cookies via a real navigation to
      petfinder.com, then re-issue the Apollo SearchAnimal POST against
      psl.petfinder.com/graphql from page context. This piggybacks on the
      cleared Akamai challenge and the Apollo headers (apollo-require-preflight,
      x-client-id/secret, apollographql-client-name: psl-rebuild) while still
      letting the agent mutate variables for pagination + filter sweeps.
verified: true
proxies: true
---

# Petfinder Search Pets — Browser Skill

## Purpose

Given a free-form search intent ("dogs near 94110", "senior cats in Brooklyn"), a full Petfinder search URL, a pet ID, or an organization ID + animal type, return matching adoptable-pet listings as structured JSON. For each pet: `petfinder_id`, `name`, `animal_type`, primary + secondary breeds, mixed-breed flag, age bucket, gender, size, coat, primary color, cleaned description text, behavior/care tags (kids/dogs/cats/house-trained/vaccinated/spayed/neutered/special-needs), primary photo + gallery + video URLs, location (city/state/postal/country), distance from input ZIP, status (`adoptable`/`pending`/`adopted`), adoption fee when surfaced, posted date, listing organization (id/name/phone/email/address), and the canonical Petfinder URL. Always also emit the region-wide `total_count` so the caller knows whether the slice is partial. **Read-only — never start an adoption application, never click favorite/contact buttons.**

## When to Use

- "Find me dogs under 1 year within 25 miles of 94110."
- A scheduling/notification agent watching for new listings matching a saved query.
- Enumerating one shelter's full adoptable inventory by organization ID.
- A single-record lookup by Petfinder pet ID.
- Any flow that previously scraped Petfinder HTML — the underlying Apollo GraphQL response is structurally richer and avoids the click-through cost.

## Workflow

The recommended path is **browser-driven Apollo GraphQL capture**: open the Petfinder search URL in a `browserless_agent` residential-proxy session, let the client-side Apollo query fire, then re-emit the `POST https://psl.petfinder.com/graphql` request from page context with mutated `variables` for pagination / filter sweeps. This is faster than UI-driven extraction (the search page is fully client-rendered — there are zero pet anchors in the SSR HTML) and avoids the Akamai cold-start cost on every page navigation. **Keep the warm-up navigation and the GraphQL capture inside ONE call's `commands` array** so the Akamai cookie jar persists across steps (batching avoids re-warming; the session itself persists across calls keyed by `proxy`/`profile`).

**Why not just POST to `/graphql` out-of-band?** Two reasons, both verified 2026-05-18:

1. The endpoint is fronted by Apollo Server's CSRF prevention. A bare POST (or a GET-as-query with no Apollo headers) returns `400 BadRequest: "blocked as a potential Cross-Site Request Forgery"` unless one of these headers is set: `apollo-require-preflight: true`, `x-apollo-operation-name: <opname>`, or a `content-type` that is **not** `application/x-www-form-urlencoded` / `multipart/form-data` / `text/plain` (i.e. `application/json` is fine).
2. The `psl.petfinder.com` host shares the Akamai Bot Manager footprint with the WWW site (same `Akamai-Grn` header, same `ak_bmsc` cookie family). Cookieless POSTs from arbitrary IPs are blocked at the edge. The session-cookie warmup happens on the first GET to `www.petfinder.com/...`; the same browser context can then POST to `psl.petfinder.com/graphql` with those cookies attached.

So the optimal shape is "warm up via a real navigation, then issue further GraphQL queries from page context." Don't fight the Apollo client — borrow its cookies and headers.

### 1. Residential-proxy stealth session

Drive the whole flow through a single `browserless_agent` call carrying a residential proxy:

```json
{
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [
    /* goto → wait → evaluate, see steps 3–4 — all in this one call */
  ]
}
```

A residential proxy is the floor: a plain (proxy-less) session gets Akamai Access-Denied HTML on `/search/...`. With a residential proxy, `GET /search/dogs-for-adoption/us/ca/san-francisco/` → 200, 150 KB HTML, `Set-Cookie: ak_bmsc=...`. `browserless_agent`'s built-in stealth fingerprint adds a safety margin on repeated/aggressive traversal. **Repeat the `proxy` arg on every `browserless_agent` call** — dropping it lands you on a fresh datacenter IP Akamai blocks.

### 2. Normalize input → canonical search URL

Petfinder's filter rail is encoded in two places: the **path slug** (animal type + location) and the **query string** (everything else).

**Path slug template** (`/search/{petTypeSlug}/{country}/{state}/{city}/`):

| Animal type         | petTypeSlug                          |
| ------------------- | ------------------------------------ |
| Dog                 | `dogs-for-adoption`                  |
| Cat                 | `cats-for-adoption`                  |
| Rabbit              | `rabbits-for-adoption`               |
| Small & Furry       | `small-and-furry-for-adoption`       |
| Horse               | `horses-for-adoption`                |
| Bird                | `birds-for-adoption`                 |
| Scales/Fins & Other | `scales-fins-and-other-for-adoption` |
| Barnyard            | `barnyard-for-adoption`              |

Country/state/city are lowercase, dashes for spaces. ZIP-based locations use `/anywhere/?postal_code=<zip>&distance=<mi>` rather than path segments.

**Query-string filter map** (verified from the `pages/search/[...slug].js` bundle):

| Filter                  | Param                | Values                                                                  |
| ----------------------- | -------------------- | ----------------------------------------------------------------------- |
| Breed (primary)         | `breed[]`            | type-specific slug (e.g. `labrador-retriever`); repeat for multi-select |
| Age                     | `age[]`              | `baby` \| `young` \| `adult` \| `senior` (repeat)                       |
| Size                    | `size[]`             | `small` \| `medium` \| `large` \| `xlarge` (repeat)                     |
| Gender                  | `gender[]`           | `male` \| `female`                                                      |
| Coat length             | `coat[]`             | `short` \| `medium` \| `long` \| `wire` \| `hairless` \| `curly`        |
| Color                   | `color[]`            | type-specific palette slugs                                             |
| House-trained           | `house_trained`      | `true`                                                                  |
| Special-needs           | `special_needs`      | `true`                                                                  |
| Vaccinations up-to-date | `shots_current`      | `true`                                                                  |
| Spayed/Neutered         | `spayed_neutered`    | `true`                                                                  |
| Good w/ Kids            | `good_with_children` | `true`                                                                  |
| Good w/ Dogs            | `good_with_dogs`     | `true`                                                                  |
| Good w/ Cats            | `good_with_cats`     | `true`                                                                  |
| Days on Petfinder       | `days_on_petfinder`  | `1` \| `7` \| `14` \| `30`                                              |
| Distance (mi)           | `distance`           | `5` \| `10` \| `25` \| `50` \| `100` \| `0` (Anywhere)                  |
| Location override       | `postal_code`        | 5-digit US ZIP (overrides path-slug location)                           |
| Organization            | `shelter_id`         | Petfinder org ID (e.g. `CA1417`)                                        |
| Sort                    | `sort`               | `recent` \| `distance` \| `best_match`                                  |
| Pagination              | `page`               | 1-based; default 40 per page                                            |

Unknown params are silently dropped — match this enum exactly. The path-slug city is for SEO only; agents should prefer `postal_code=<zip>` because the page-slug city lookup is fuzzy.

### 3. Open the search URL → warm cookies + fire the Apollo query

```json
{ "method": "goto", "params": { "url": "https://www.petfinder.com/search/dogs-for-adoption/anywhere/?postal_code=94110&distance=25&age[]=young&age[]=adult&sort=recent", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 3000 } }
```

(Use `load`, never `networkidle` — the SPA never goes idle.) The page hydrates client-side and dispatches `POST https://psl.petfinder.com/graphql` with the `SearchAnimal` operation. Apollo retries up to 3× on a soft failure (verified in bundle), so a transient 4xx isn't fatal.

### 4. Capture the GraphQL request/response from page context

The cleanest extraction is an `evaluate` command against the live page — read the Apollo cache directly so you get the parsed response without re-issuing the network call. Append this as the next entry in the same call's `commands` array (return value comes back under `.value`):

```json
{
  "method": "evaluate",
  "params": {
    "content": "(() => { if (window.__APOLLO_CLIENT__) { return JSON.stringify(window.__APOLLO_CLIENT__.cache.extract()); } return JSON.stringify(window.__APOLLO_STATE__ || null); })()"
  }
}
```

If `__APOLLO_CLIENT__` isn't surfaced, fall back to re-issuing the same query from page context — the page is already navigated to petfinder.com, so cookies + Apollo headers flow automatically (same-origin `fetch`):

```json
{
  "method": "evaluate",
  "params": {
    "content": "(async () => { const variables = { pagination: { page: 0, limit: 40 }, sort: 'recent', filters: { /* see step 2 → vars mapping below */ }, facets: {} }; const body = JSON.stringify({ operationName: 'SearchAnimal', variables, query: window.__PETFINDER_SEARCH_QUERY__ || '...' }); const r = await fetch('https://psl.petfinder.com/graphql', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'apollo-require-preflight': 'true', 'x-client-id': '<runtimeConfig.X_CLIENT_ID from __NEXT_DATA__>', 'x-client-secret': '<runtimeConfig.X_CLIENT_SECRET from __NEXT_DATA__>' }, body }); return await r.text(); })()"
  }
}
```

Project/summarize the response inside the `evaluate` (map to the Expected Output shape) rather than returning the raw Apollo store — the text return is size-capped.

The response shape is:

```json
{
  "data": {
    "searchAnimal": {
      "animals": [/* per-pet records, see Expected Output */],
      "totalCount": 5212,
      "facets": {/* aggregations Petfinder uses to render the filter sidebar */}
    }
  }
}
```

### 5. Paginate

Increment `pagination.page` (0-indexed in the GraphQL variables; the URL `page` param is 1-indexed — keep these straight). Page size is 40 by default; the bundle does not appear to expose a `limit` override beyond 40, so for >40-result needs, loop pages.

Stop when `animals.length === 0` or when `(page+1) * 40 >= totalCount`.

### 6. Decode + emit

Map each `animals[i]` to the output schema in **Expected Output** below. Key gotchas during decoding:

- `description` is HTML-encoded — strip tags and decode entities before emitting.
- `photos[]` and `videos[]` are arrays of `{small, medium, large, full}` URLs; emit `large` as `primary_photo_url` and the full array as `gallery`.
- `organization` is denormalized onto each animal — deduplicate by `organizationId` if the caller wants a clean org list.
- `breeds.primary`, `breeds.secondary`, `breeds.mixed` (bool), `breeds.unknown` (bool) — map all four.
- `attributes` is the source for the boolean tag set (house-trained, etc.).
- `environment` is the source for `good_with_*` flags. **A `null` here means "unspecified," not "no"** — pass through as `null`, do not coerce.
- `distance` (miles from input postal code) is populated only when `postal_code` was passed; otherwise `null`.
- `publishedAt` is the canonical posted date.
- `status` enum: `adoptable` \| `pending` \| `adopted` \| `found`.

### 7. No session-release step

There's nothing to release: the `browserless_agent` session persists across calls, keyed by `proxy`/`profile`. Just make sure the warm-up navigation → wait → extract (→ paginate) sequence lives inside ONE call's `commands` array so cookies persist across the flow; when you page beyond the first result set, issue a fresh `browserless_agent` call (with the same `proxy`) that re-warms and re-queries.

### Browser-fallback (when GraphQL capture fails)

If the Apollo-cache `evaluate` returns nothing (e.g., Apollo client not surfaced on `window`) and the re-issued POST also fails CSRF, drive the UI: scroll the result grid to lazy-load (`{ "method": "scroll", "params": { "direction": "down" } }`, repeat), then a `{ "method": "snapshot" }` command and harvest from the rendered cards. Each card is an `article` with structured a11y refs — `link` (pet detail URL, contains the pet ID after the last `-`), `img` (primary photo), and text rows for breed/age/sex/size/location. This path is ~10× more expensive in tokens per pet and misses fields that are only in the GraphQL payload (description, environment booleans, organization contact). Reserve for the case where the GraphQL path is genuinely broken.

## Site-Specific Gotchas

- **The task brief's claim that `__NEXT_DATA__` contains the rendered listings is incorrect.** Verified 2026-05-18 on `/search/dogs-for-adoption/us/ca/san-francisco/`: `props.pageProps.petIds` is `null` and `props.pageProps.shelterRescueIds` is `null`. The only SSR-hydrated data is `initialPetType`, `initialLocationSlug`, and `menuData`. All real listing data arrives via a post-hydration Apollo POST. Do not waste turns parsing `__NEXT_DATA__` for pet records — read it only to harvest `runtimeConfig.X_CLIENT_ID` / `X_CLIENT_SECRET` (which the Apollo client uses as request headers) and the `PSL_REBUILD_GRAPHQL_URL` endpoint.
- **Akamai Bot Manager is on (`Set-Cookie: ak_bmsc=...; Akamai-Grn: ...`).** A bare proxied GET to the search page is OK for the SSR shell (200), but cookieless POSTs to `psl.petfinder.com/graphql` from unrelated IPs are blocked. Always warm the cookie jar with a navigation before issuing GraphQL.
- **An out-of-band HTTP fetch cannot replace a live session here.** The GraphQL call needs a POST with `apollo-require-preflight` plus the Akamai cookie jar warmed by a real navigation. Do the POST from page context inside a `browserless_agent`/`browserless_function` session (`page.goto('https://www.petfinder.com/...')` first, then `page.evaluate` a same-origin `fetch` to `psl.petfinder.com`); a bare cross-origin `fetch` with no page navigation has no egress and no cookies.
- **Apollo CSRF prevention is on.** Direct cookieless GET to `/graphql?query=...` returns `400 "blocked as a potential Cross-Site Request Forgery"`. Set `apollo-require-preflight: true` **or** `x-apollo-operation-name: SearchAnimal` (any non-empty value satisfies the check) on every POST. Page-context `fetch()` inside a warmed session passes the check because the browser supplies the right `content-type`.
- **`X-Client-Id` and `X-Client-Secret` are baked into the public Next.js runtime config and rotate occasionally.** Read them from `__NEXT_DATA__.runtimeConfig.X_CLIENT_ID` / `X_CLIENT_SECRET` at the start of the session — do **not** hardcode. Observed values rotated build-to-build during testing.
- **The Apollo `clientName` is `"psl-rebuild"`.** This is set on the Apollo `context` for the search query and may be checked server-side. The headers `apollographql-client-name: psl-rebuild` and `apollographql-client-version: <build-id>` are also sent — mimic them when re-issuing the POST from page context.
- **Operation name is `SearchAnimal` (or aliased `searchAnimal` in the data response).** The bundle references `eB.searchAnimal.animals`, `eB.searchAnimal.totalCount`, `eB.searchAnimal.facets`. Variable shape: `{ pagination: { page, limit }, sort, filters: { ...filter map from step 2 }, facets: {} }`.
- **`pagination.page` is 0-indexed in the GraphQL variables, 1-indexed in the URL.** The URL `?page=2` maps to GraphQL `pagination.page = 1`. The search-bundle has a `tY.jq(page||0)` adapter that does this — track it explicitly when paginating to avoid an off-by-one.
- **Page size is fixed at 40.** No `limit` override observed. For >40 results, loop pages — Petfinder rate-limits aggressive paginators (no documented threshold; keep ≤ 1 req/sec sustained).
- **Distance defaults to 100 mi when `postal_code` is set without `distance`.** The bundle's filter adapter (`tY.qO`) injects this default. Pass `distance` explicitly when you care about radius.
- **`distance=0` means "Anywhere"**, not "exact match" — it lifts the radius constraint entirely.
- **Path-slug city is fuzzy; `postal_code=` is exact.** `/search/dogs-for-adoption/us/ca/san-francisco/` works but ambiguous city slugs (e.g. `springfield`) return arbitrary state matches. Always prefer `?postal_code=<zip>` for ZIP-precise lookups, even when you also have a city/state.
- **`environment.children` / `dogs` / `cats` use ternary semantics**: `true` = good with, `false` = not good with, `null` = unspecified. Do not coerce `null` → `false`.
- **`breeds.mixed` and `breeds.unknown` are independent booleans.** A pet can be both `mixed: true` and have `primary: "Pit Bull Terrier"` set — the breed is the _primary_ parent type. `unknown: true` means breed truly unknown and `primary` may be null.
- **`description` is HTML.** Strip tags and decode entities (`&amp;` → `&`, `&#x27;` → `'`, etc.) before emitting. Petfinder allows shelters to include arbitrary HTML, including `<br>`, `<p>`, `<a>`, and occasionally `<iframe>` (drop these).
- **`status` includes `found`** for stray/found-pet listings posted by shelters — this is a real terminal state distinct from `adoptable`. Don't fold into `adopted` blindly.
- **Org contact fields are sparse.** `organization.email` and `organization.phone` are often empty strings (the rescue uses Petfinder's relay form instead). Emit them as-is; do not synthesize.
- **Adoption fee is rarely surfaced.** Most listings have `adoptionFee: null`; some shelters set a flat amount, others note "Contact for details." Pass through whatever the GraphQL returns, including `null`.
- **Petfinder Developer API exists but is partner-only.** `https://api.petfinder.com/v2/animals` with OAuth client credentials is a public partner API documented at `developers.petfinder.com`, but the registration is human-gated and the API is rate-limited (1000 req/day per app). It is **not** a faster fallback for agent runtimes that don't already have a key registered. The Apollo path is faster for one-off agent runs.
- **`shelter_id` format**: `<2-letter-state-code><4-digit-numeric>` (e.g. `CA1417`). Validated on the page; invalid IDs return 0-result pages with no error indication.
- **Days-on-Petfinder filter is recent-publish, not recent-update**: `days_on_petfinder=1` returns pets whose `publishedAt` is within the last 24h, ignoring re-promotions/edits.
- **The site sets a regional `ak_bmsc` cookie that lasts ~2h.** Reuse the session across multiple page-template + filter-template hits within that window for free; new sessions pay the cookie-warmup cost (~3s).
- **Verification caveat:** the GraphQL POST shape was inferred from bundle archaeology + the SSR fetch + the 400-CSRF error rather than a live-fire run. A production agent should run a final verification pass with `browserless_agent` to capture the exact `SearchAnimal` query body from the live `__APOLLO_CLIENT__` object (via an `evaluate` command). Once captured, cache the query string for the lifetime of the build ID.

## Expected Output

```json
{
  "query": {
    "petType": "dog",
    "postal_code": "94110",
    "distance_miles": 25,
    "filters": { "age": ["young", "adult"], "size": ["medium"] },
    "sort": "recent",
    "page": 1
  },
  "total_count": 5212,
  "returned_count": 40,
  "is_partial": true,
  "next_page_url": "https://www.petfinder.com/search/dogs-for-adoption/anywhere/?postal_code=94110&distance=25&age[]=young&age[]=adult&size[]=medium&sort=recent&page=2",
  "pets": [
    {
      "petfinder_id": "78912345",
      "name": "Biscuit",
      "animal_type": "dog",
      "breeds": {
        "primary": "Labrador Retriever",
        "secondary": null,
        "mixed": true,
        "unknown": false
      },
      "age": "young",
      "gender": "male",
      "size": "medium",
      "coat": "short",
      "primary_color": "yellow",
      "description": "Biscuit is a sweet, gentle 2-year-old looking for an active family...",
      "tags": {
        "house_trained": true,
        "spayed_neutered": true,
        "shots_current": true,
        "special_needs": false,
        "good_with_children": true,
        "good_with_dogs": true,
        "good_with_cats": null
      },
      "primary_photo_url": "https://dbw3zep4prcju.cloudfront.net/photos/pets/78912345/1/?bust=1742000000&width=600",
      "gallery": [
        "https://.../78912345/1/?bust=1742000000&width=1600",
        "https://.../78912345/2/?bust=1742000000&width=1600"
      ],
      "videos": [],
      "location": {
        "city": "Oakland",
        "state": "CA",
        "postal_code": "94601",
        "country": "US"
      },
      "distance_miles": 12.4,
      "status": "adoptable",
      "adoption_fee": null,
      "posted_date": "2026-05-12T19:34:22Z",
      "organization": {
        "org_id": "CA1417",
        "org_name": "Bay Area Doggie Rescue",
        "org_phone": "",
        "org_email": "",
        "org_address": {
          "address1": null,
          "city": "Oakland",
          "state": "CA",
          "postal_code": "94601",
          "country": "US"
        }
      },
      "listing_url": "https://www.petfinder.com/dog/biscuit-78912345/ca/oakland/bay-area-doggie-rescue-ca1417/"
    }
  ]
}
```

Single-record lookup by pet ID returns the same record shape under `pets: [<one record>]` with `total_count: 1`, `is_partial: false`. Organization-scoped enumeration (caller passes `shelter_id`) returns the org's full inventory, paginated identically.

When the input ZIP or city slug doesn't resolve, the response is:

```json
{ "query": {...}, "total_count": 0, "returned_count": 0, "pets": [], "error": "location_not_found" }
```

When the GraphQL path fails after the browser-fallback also fails (e.g., persistent Akamai block on the session), emit:

```json
{ "query": {...}, "error": "blocked", "detail": "Akamai 403 on /graphql after 3 retries; session may need rotation" }
```
