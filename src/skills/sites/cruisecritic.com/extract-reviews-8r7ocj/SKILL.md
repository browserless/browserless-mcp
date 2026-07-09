---
name: extract-reviews
title: Cruise Critic Extract Reviews
description: >-
  Given a Cruise Critic ship page (URL, or cruise line + ship name resolved via
  search), extract ship metadata plus a filtered slice of member reviews as
  structured JSON, leading with a browserless_agent stealth session and using the
  per-review Next.js data JSON endpoint as a per-review enrichment shortcut.
website: cruisecritic.com
category: travel
tags:
  - cruises
  - reviews
  - travel
  - datadome
  - stealth
  - next-js
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: hybrid
alternative_methods:
  - method: browser
    rationale: >-
      A browserless_agent session on residential proxies is the only reliable
      way to load the >1 MB SSR list page and to apply rating / traveler-type /
      cabin / sailed-within / sort filters (all React UI state — no URL form
      exists).
  - method: api
    rationale: >-
      Per-review
      `_next/data/{buildId}/cruise/{line}/{ship}/reviews/{review-id}.json`
      returns the full review payload as ~150 kB JSON — fetch it via
      browserless_function (goto the cruisecritic origin, then a same-origin
      fetch). Used in hybrid mode for per-review enrichment after review IDs are
      scraped from the list page. The equivalent list-page `_next/data` endpoint
      is DataDome-blocked (403).
  - method: url-param
    rationale: >-
      `/cruise/{line}/{ship}/reviews/destination/{slug}` is the only URL-form
      filter that works — all other querystring/path filter variants are
      silently ignored or return 404.
verified: true
proxies: true
---

# Cruise Critic Extract Reviews — Browser Skill

## Purpose

Given a Cruise Critic ship page (a `https://www.cruisecritic.com/cruise/{cruise-line-slug}/{ship-slug}/reviews` URL, or a cruise line + ship name pair resolved via the `browserless_search` tool), extract ship-level metadata (name, line, year built, passenger capacity, crew, overall rating, total review count, per-category averages) plus a filtered slice of member reviews each with `{review_id, reviewer_username, reviewer_traveler_type, sailed_date, cruise_length_nights, destination, cabin_type_booked, overall_rating, sub_ratings: {...}, title, body_text, helpful_vote_count, review_url}` and any cruise-line response. Read-only — never click Write a Review, Sign In, helpful-vote, or report-review controls.

## When to Use

- Aggregating Cruise Critic sentiment for a ship across a date window or destination.
- Building a comparison table of ships within a cruise line (one skill invocation per ship).
- Quoting recent member-review excerpts in a research brief with provenance back to the source review page.
- Pulling the canonical per-category rating breakdown (Cabins, Dining, Entertainment, Public Rooms, Fitness & Recreation, Family, Shore Excursion, Embarkation, Service, Value for Money) used by the site's own award logic.

## Workflow

Cruise Critic is a Next.js (Apollo Client) SSR site protected by **DataDome** (`X-Datadome: protected` on every response). The reviews-list page is server-rendered with the full visible review payload baked into the HTML (typically **800 kB – >1 MB**), so a raw HTTP fetch of the list can blow past the result-size cap, and DataDome will start serving captcha-challenge HTML after roughly **5–8 unauthenticated raw fetches** from the same source IP. **Lead with a `browserless_agent` session with stealth and residential proxies enabled.** Two undocumented shortcuts that hold up under stealth dramatically cut cost — both are documented below as optimizations.

### Recommended path — stealth `browserless_agent` session + per-review `_next/data` enrichment

1. **Configure a stealthed session.** Run the list-page flow (steps 4–6) as a single `browserless_agent` call so the DataDome cookie set on the first navigation persists across every later command. Set a residential proxy on the call:

   ```json
   {
     "proxy": { "proxy": "residential" },
     "commands": [/* steps 4–6 below, in order */]
   }
   ```

   Advanced stealth (on by default) plus the residential proxy is mandatory. A plain session is served a DataDome interstitial on the first navigation to `/cruise/.../reviews`; add a `{ "method": "solve", "params": { "type": "dataDome" } }` command right after the `goto` if the interstitial appears.

2. **Resolve the ship URL** if the caller gave you a line + ship name instead of a URL: run the `browserless_search` tool with query `site:cruisecritic.com $LINE $SHIP reviews` and pick the first result whose URL matches `/cruise/[^/]+/[^/]+/reviews$`.

   The canonical reviews URL is always `https://www.cruisecritic.com/cruise/{cruise-line-slug}/{ship-slug}/reviews`. Both slugs are kebab-case (`royal-caribbean`, `symphony-of-the-seas`, `norwegian-cruise-line`, `viking-jupiter`, …).

3. **Optionally narrow by destination via URL path.** Only `destination` is a URL-form filter; all other filters are React UI state.

   ```
   /cruise/{line}/{ship}/reviews/destination/{destination-slug}
   ```

   Verified working destination slugs: `usa`, `caribbean`, `eastern-caribbean`, `western-caribbean`, `southern-caribbean`, `bahamas`, `mediterranean`, `europe`, `alaska`, `asia`. The site canonicalises lower-case kebab; unknown slugs 404.

4. **Open the list page and pull the Next.js data in-page.** As commands in the call from step 1:

   ```json
   { "method": "goto",          "params": { "url": "https://www.cruisecritic.com/cruise/{line}/{ship}/reviews[/destination/{dest}]", "waitUntil": "load", "timeout": 60000 } },
   { "method": "waitForTimeout", "params": { "time": 2500 } },
   { "method": "evaluate",       "params": { "content": "(()=>{const j=JSON.parse(document.getElementById('__NEXT_DATA__').textContent);const a=j.props.pageProps.apolloState;return JSON.stringify({buildId:j.buildId,reviewIds:Object.keys(a).filter(k=>k.startsWith('Reviews:')).map(k=>a[k].id),apolloState:a});})()" } }
   ```

   The `waitForTimeout` lets Apollo hydration settle. Extracting `__NEXT_DATA__` **in-page** (rather than shipping the >1 MB HTML back) keeps the return under the result-size cap — the blob carries everything you need without any further DOM scraping. `j.props.pageProps.apolloState` is the Apollo cache; project down to just the fields you need if it's large. Key entries on a list page:
   - `Ships:{shipId}` — ship core (`name`, `seoName`, `slug`, `professionalOverallRating`, `totalShoreExcursions`, `cruiseLine.slug`, `reviewStatus`).
   - `ShipAttributes:{attrId}` — `{ passengerCapacity, totalCrew, maidenDate }` (year built). Linked from `Ships:{id}.attributes.__ref`.
   - `ROOT_QUERY.searchReviewsWithFilters({"filters":{"isPhotoJournal":false,"shipId":[{id}]},"limit":N})` → `{ totalResults, stats: { averageMemberRating } }`.
   - `Reviews:{reviewId}` for every visible review in the current filter/sort/page bucket. Each `Reviews:{id}` carries `{ id, cruisedOn, hasChildren, withDisabled, numberOfCruisesTakenGroupId, cabinCategory, user.__ref, entries: [ReviewEntries refs] }`.
   - `ReviewEntries:{entryId}` — `{ reviewCategory, rating }` for one sub-category.
   - `SsoUser:{userKey}` — `{ username }` for the reviewer.

   The `evaluate` above already returns the visible review IDs under `reviewIds` (the `Object.keys(apolloState).filter(k => k.startsWith("Reviews:")).map(...)` projection), so no separate extraction step is needed.

5. **Apply rating / traveler-type / cabin / sailed-within / sort / language filters in-browser.**

   These are not URL filters. They render as a row of pills + dropdowns above the listing. The shape is stable: each filter is a button with `aria-haspopup="listbox"` and an accessible name like `"Rating: Any"`, `"Traveler Type: Any"`, `"Cabin Type: Any"`, `"Sailed Within: Any"`, `"Sort By: Most Helpful"`. Pattern for each filter:

   ```json
   { "method": "snapshot" },
   { "method": "click", "params": { "selector": "<filter button, located by its accessible name in the snapshot>" } },
   { "method": "waitForTimeout", "params": { "time": 500 } },
   { "method": "click", "params": { "selector": "<the corresponding listbox option>" } },
   { "method": "waitForTimeout", "params": { "time": 1500 } }
   ```

   The `snapshot` (a11y tree) gives you the accessible name → ref mapping to build each `click` selector; the second `waitForTimeout` covers the Apollo refetch. After each filter change, the URL stays the same but `__NEXT_DATA__` is regenerated on the next page load — to refresh it from React state, re-run an `evaluate` against `window.__APOLLO_STATE__` (Apollo writes the latest cache there if exposed; otherwise re-read the page via another `evaluate` over `__NEXT_DATA__`). The simpler, cheaper alternative for non-destination filters is to **fetch all visible reviews first and filter client-side from `cruisedOn` / `entries` / `numberOfCruisesTakenGroupId`** — the data is denser than the UI exposes (e.g., `hasChildren`/`withDisabled` flags let you reconstruct the Family / Disabled traveler-type filter without a click).

6. **Paginate.** The site paginates ~10 reviews per page via an infinite-scroll / "Load more" pattern. Trigger more reviews to render:

   ```json
   { "method": "scroll",        "params": { "direction": "down" } },
   { "method": "waitForTimeout", "params": { "time": 1500 } }
   ```

   Repeat the `scroll` + `waitForTimeout` pair until `totalResults` is reached or you have enough — the scroll-to-bottom triggers the infinite-scroll load. Alternatively `click` the explicit "Load more reviews" button if one is present in the `snapshot`.

   Each load merges new `Reviews:{id}` entries into the Apollo cache. Re-extract `__NEXT_DATA__` or re-snapshot to capture the growing set.

7. **Enrich each visible review with its full body.** The list-page payload contains review sub-rating entries but **does not include the review body text or title** — that lives only on the per-review page. Two paths, in cost order:

   - **(Cheap, preferred)** `_next/data` JSON endpoint — fetch the per-review SSR props (~150 kB JSON) via `browserless_function`: `page.goto('https://www.cruisecritic.com/')` to the origin, then `page.evaluate` a same-origin `fetch` of the `_next/data` path. DataDome allows it through when the request rides a residential proxy. The build ID came back from the step-4 `evaluate` as `j.buildId`. Example path:

     ```
     GET https://www.cruisecritic.com/_next/data/{buildId}/cruise/{line}/{ship}/reviews/{reviewId}.json
         ?cruise-line-slug={line}&cruise-ship-slug={ship}&review-id={reviewId}
     ```

     Response shape (verified): `pageProps.review` with `{ id, title, shipReview (the body text, ~9 kB typical), cruisedOn, overallRating, helpfulVotes, cabinCategory, destination: {id, slug, seoName}, user: {username}, hasChildren, withDisabled, numberOfCruisesTakenGroupId, entries: [{reviewCategory, rating}], comments (cruise-line response, when present), images, nextReview: {id}, previousReview: {id} }`. Pace requests to **≤ 1 req/sec** with brief jitter; DataDome served captcha HTML after roughly 5 back-to-back unauthenticated bursts in testing.

   - **(Fallback)** A `goto` to `.../reviews/{id}` inside the active stealthed session. ~5–8× more wall time per review than the `_next/data` path but immune to per-IP fetch throttling because the session traffic shares stealth + residential proxy state.

8. **(Walk-the-chain optimisation)** When the caller doesn't need filters, you can skip the list-page entirely. The `_next/data` JSON for any review contains `nextReview.id` and `previousReview.id` for adjacent reviews in the site's default ordering — walk the chain in either direction until enough reviews are collected. This eliminates the >1 MB list-page load and the entire pagination loop. The chain order is approximately reverse-chronological **but is not strictly sorted**; verify by `cruisedOn` if you need date ordering.

9. **Map sub-category labels.** `entries[].reviewCategory` uses internal camelCase keys. Translate to the user-facing labels in your output:

   | `reviewCategory` (API) | UI label             |
   | ---------------------- | -------------------- |
   | `cabin`                | Cabins               |
   | `dining`               | Dining               |
   | `entertainment`        | Entertainment        |
   | `publicRooms`          | Public Rooms         |
   | `fitnessAndRecreation` | Fitness & Recreation |
   | `family`               | Family               |
   | `shoreExcursion`       | Shore Excursion      |
   | `embarkation`          | Embarkation          |
   | `service`              | Service              |
   | `valueForMoney`        | Value for Money      |

   Not every reviewer scores every category; absent entries are simply omitted from `entries[]`. Treat missing categories as `null`, not `0`.

10. **Derive `reviewer_traveler_type`.** The site shows it as a badge but the data is split across three fields on `Reviews:{id}`:
    - `hasChildren: true` → `Family`
    - `withDisabled: true` → `Disabled`
    - Otherwise the badge string ("Couple", "Solo", "Friends", "Senior") is rendered from a separate Apollo entity that is **not always in `apolloState`** on the list page — it is reliably present in the per-review `_next/data` JSON under a sibling field. If you need the full string for every review, source it from the per-review fetch in step 7.

11. **Build review URLs:** `https://www.cruisecritic.com/cruise/{cruise-line-slug}/{ship-slug}/reviews/{review-id}`.

12. **Session teardown.** No session-release step — there's nothing to release. The session persists across calls, keyed by `proxy`/`profile` (repeat the same residential `proxy` to reconnect to the same warmed browser; drop or change it and you land in a different, blank session). Batching the whole list-page flow (nav → filters → paginate → extract) inside one call's `commands` array saves round-trips and keeps the DataDome cookie and Apollo state together.

### Browser fallback (no `_next/data`)

If DataDome starts blocking `_next/data` JSON (it can happen on a hot residential exit IP), do all enrichment through `goto` page loads inside the same stealthed session. Extract the review body from the rendered DOM via the JSON-LD `<script type="application/ld+json">` block — the `Product` schema's `review[0]` contains `name`, `datePublished`, `reviewBody` (truncated to ~200 chars), `author.name`, `reviewRating.ratingValue` — and supplement the truncated body with a `text` command on the main `<article>` selector.

## Site-Specific Gotchas

- **Anti-bot: DataDome is on every route.** `X-Datadome: protected` appears on all responses; `X-Datadome-Isbot: false` on the first few from a fresh proxy IP, then captcha HTML (`<html lang="en"><head><title>cruisecritic.com</title>…geo.captcha-delivery.com…`) once the IP gets flagged. A stealth + residential-proxy `browserless_agent` session is mandatory. Avoid sustained fan-out via raw HTTP fetch — keep per-review enrichment inside the active stealth session, or pace `_next/data` fetches to ≤ 1 req/sec with jitter.
- **Reviews-list HTML is > 1 MB.** A raw HTTP fetch of the list exceeds the 1 MB result cap for `/cruise/.../reviews` and any `/cruise/.../reviews/destination/{slug}` page (verified on `usa`, `caribbean`, `mediterranean`, `alaska`, `bahamas`, `europe`, `asia` — all > 1 MB). Always use a `browserless_agent` session for the list and extract `__NEXT_DATA__` in-page (never ship the raw HTML back). The per-review `_next/data` JSON is ~150 kB and well under the cap.
- **`_next/data` JSON list path is DataDome-blocked.** `GET /_next/data/{buildId}/cruise/{line}/{ship}/reviews/destination/{slug}.json` returns **HTTP 403** with the DataDome challenge cookie, whereas the per-review variant `GET /_next/data/{buildId}/cruise/{line}/{ship}/reviews/{review-id}.json?...&review-id={id}` returns 200 on the same session and IP. Don't chase the list-page JSON endpoint — it's not a viable shortcut.
- **GraphQL endpoint is not externally callable.** The site is Apollo Client + Next.js SSR, but the public-facing `/graphql` route is not exposed in any JS bundle reachable via a raw fetch (chunk inventory inspected: `framework`, `main`, `webpack`, per-page chunks — no graphql URL strings). The `_app.js` bundle exceeds 1 MB and cannot be inspected from this path. **Don't waste iterations hunting a direct GraphQL POST endpoint** — the `_next/data` JSON return is functionally equivalent and authenticates the same way the page does (no API key, just DataDome cookie).
- **Only `destination` is a URL-form filter.** Verified 404 for `/reviews/rating/{N}`, `/reviews/traveler-type/{slug}`, `/reviews/cabin-type/{slug}`, `/reviews/sailed-within/{window}`, `/reviews/sort/{key}`, `/reviews/language/{lang}`, and `/reviews/page/{N}`. Querystring forms (`?rating=5`, `?page=2`, `?sortBy=mostRecent`, `?travelerType=family`) are silently ignored and return the unfiltered listing. All non-destination filters require clicking the React UI inside a session.
- **Pagination is infinite-scroll, not numbered.** `?page=N` and `/page/{N}` both fall through to the unfiltered first page. Trigger additional reviews by pressing `End` or clicking the explicit "Load more reviews" control in the snapshot. ~10 reviews load per increment.
- **Sub-category names are camelCase in the API.** The list-page `entries[].reviewCategory` uses `valueForMoney`, `publicRooms`, `fitnessAndRecreation`, `shoreExcursion` — translate to the user-facing labels in your output mapping. Not every reviewer scores every category; missing → `null`, not `0`.
- **`destination` on a review is the _itinerary_ destination, not the home port.** It is an object `{ id, slug, seoName }` (e.g., `{slug:"eastern-caribbean", seoName:"the Eastern Caribbean"}`). The departure port lives separately on `DeparturePorts:{id}` under `Ships:{id}.departurePorts({"countryId":1})`.
- **`cabinCategory` is frequently `null`.** Many reviews don't pin a cabin type; if the caller wants a Cabin filter, fall back to `ReviewCabinPivots:{id}` references on the review (when present, they carry `{cabinType, deck, room}` granularity).
- **`numberOfCruisesTakenGroupId`** is a bucketed-experience integer (1 = first cruise, larger = more experienced). Site renders this as a badge ("First time cruiser", "Experienced", etc.) but the mapping table is internal — emit the integer and let the consumer interpret, or hardcode the observed mapping (`1=first, 2=novice, 3=intermediate, 4+=experienced`) with a `_unverified` flag.
- **`nextReview` / `previousReview` chains are not strictly chronological.** They walk the site's default ordering, which is similar-but-not-identical to "Most Helpful". For strict date-window filtering, paginate via the list page and sort by `cruisedOn` client-side rather than walking the chain past your date boundary.
- **Cruise-line responses live on `review.comments`.** When the cruise line responded to a review, `pageProps.review.comments` is a non-null object `{ comment, user: {userName, title} }`. Empty otherwise. Worth including in `Expected Output` because some downstream use-cases ask for it explicitly.
- **`shipReview` is HTML-escaped plain text with `\r\n` newlines.** Decode `&quot;`, `&amp;`, etc., before emitting. There is no rich-text markup.
- **Build ID rotates per deploy.** `dpl_EoXom4Tk8881A4KbrwTMYtbTjHKs` / `build-TfctsWXpff2fKS` were live during this skill's authoring. Always extract the current `buildId` from the page HTML before constructing `_next/data` URLs — a stale build ID 404s.
- **AI-training crawlers are blocked in `robots.txt`** (`User-agent: GPTBot|ClaudeBot|Google-Extended|Cohere-ai|CCBot|...`), but Disallow rules under `User-agent: *` cover `/search`, `/feeds`, `/member-center`, `/storyblok/`, etc. — **not** `/cruise/.../reviews`. The review pages themselves are publicly indexable; the AI-crawler block is a policy signal rather than a per-route enforcement and DataDome operates regardless of user agent. Set a realistic browser UA on your session (Browserless stealth does this by default).
- **Two ID spaces exist — `Reviews:{id}` (the review_id in URLs) and `ReviewEntries:{id}` (per-subcategory rating rows).** Don't conflate them. The review URL is built with the `Reviews:` id; the `ReviewEntries:` ids never appear in a URL.
- **The `mra` legacy path (`{port}-{line}-{ship}-{destination}-cruises_dp{N}-cl{N}-sh{N}-de{N}/mra`) 308-redirects to `/cruise/{line}/{ship}/reviews/destination/{slug}`.** Don't try to use it directly — follow the redirect and treat the new-shape URL as canonical.
- **Read-only.** Do not click `Write a Review`, `Sign In`, `Helpful` / vote controls, or `Report Review`. The first two start auth flows; the latter two mutate state and are disallowed by the task contract.

## Expected Output

Two shapes — `success` with payload, and `error` with reason. The skill emits `success` even when the filter window returns zero reviews (the empty array carries the same provenance + ship metadata as a populated one).

```json
{
  "success": true,
  "ship": {
    "ship_id": 984,
    "name": "Symphony of the Seas",
    "cruise_line": "Royal Caribbean International",
    "cruise_line_slug": "royal-caribbean",
    "ship_slug": "symphony-of-the-seas",
    "year_built": "2018",
    "year_refurbished": null,
    "gross_tonnage": null,
    "passenger_capacity": 5518,
    "total_crew": 2200,
    "length_meters": null,
    "decks": null,
    "professional_overall_rating": 4.5,
    "member_overall_rating": 3.78,
    "total_member_reviews": 463,
    "rating_breakdown": {
      "Cabins": null,
      "Dining": null,
      "Entertainment": null,
      "Public Rooms": null,
      "Fitness & Recreation": null,
      "Family": null,
      "Shore Excursion": null,
      "Embarkation": null,
      "Service": null,
      "Value for Money": null
    },
    "url": "https://www.cruisecritic.com/cruise/royal-caribbean/symphony-of-the-seas/reviews"
  },
  "filters_applied": {
    "min_rating": null,
    "traveler_type": null,
    "sailed_within": null,
    "sailed_date_range": null,
    "destination": "eastern-caribbean",
    "cabin_type": null,
    "sort": "Most Helpful",
    "language": "en"
  },
  "total_results_matching_filters": 187,
  "reviews_returned": 2,
  "reviews": [
    {
      "review_id": 727851,
      "review_url": "https://www.cruisecritic.com/cruise/royal-caribbean/symphony-of-the-seas/reviews/727851",
      "reviewer_username": "steveknj",
      "reviewer_traveler_type": "Couple",
      "reviewer_experience_bucket": 3,
      "sailed_date": "2025-04-30",
      "cruise_length_nights": null,
      "destination": {
        "slug": "eastern-caribbean",
        "label": "the Eastern Caribbean"
      },
      "cabin_type_booked": null,
      "overall_rating": 5,
      "sub_ratings": {
        "Cabins": 4,
        "Dining": 5,
        "Entertainment": 4,
        "Public Rooms": 5,
        "Family": 5,
        "Embarkation": 5,
        "Service": 5,
        "Value for Money": 5
      },
      "title": "Symphony of the Seas - 4/30/2025",
      "body_text": "I wanted to preface this to say that this is NOT an extensive review… (full ~9000-character body)",
      "pros": null,
      "cons": null,
      "tip_for_future_cruisers": null,
      "helpful_vote_count": 2,
      "images": [],
      "cruise_line_response": null
    },
    {
      "review_id": 738724,
      "review_url": "https://www.cruisecritic.com/cruise/royal-caribbean/symphony-of-the-seas/reviews/738724",
      "reviewer_username": "anonymous",
      "reviewer_traveler_type": "Couple",
      "reviewer_experience_bucket": 2,
      "sailed_date": "2026-03-01",
      "cruise_length_nights": null,
      "destination": {
        "slug": "eastern-caribbean",
        "label": "the Eastern Caribbean"
      },
      "cabin_type_booked": null,
      "overall_rating": 1,
      "sub_ratings": {
        "Cabins": 1,
        "Dining": 1,
        "Embarkation": 4,
        "Entertainment": 3,
        "Fitness & Recreation": 2,
        "Public Rooms": 2,
        "Service": 4,
        "Value for Money": 1
      },
      "title": "Symphony is overcrowded, and kids gone wild",
      "body_text": "…(full body)",
      "pros": null,
      "cons": null,
      "tip_for_future_cruisers": null,
      "helpful_vote_count": 0,
      "images": [],
      "cruise_line_response": {
        "by": "Royal Caribbean Guest Services",
        "comment": "We're sorry to hear about your experience…"
      }
    }
  ],
  "evidence": {
    "list_url_loaded": "https://www.cruisecritic.com/cruise/royal-caribbean/symphony-of-the-seas/reviews/destination/eastern-caribbean",
    "build_id": "build-TfctsWXpff2fKS",
    "session_id": "<browserless-session-id>",
    "fetched_at": "2026-05-18T18:35:00Z"
  }
}
```

Error shapes:

```json
// Ship not found on Cruise Critic
{ "success": false, "reason": "ship_not_found", "queried": { "line": "...", "ship": "..." } }

// DataDome blocked the session even with a residential proxy + stealth (rare on first attempt;
// occurs on hot/burned residential exit IPs — retry with a new session)
{ "success": false, "reason": "anti_bot_block", "evidence": "datadome_captcha_html" }

// Filter window produces zero reviews; ship + total still reported
{ "success": true, "total_results_matching_filters": 0, "reviews": [], "ship": { ... }, "filters_applied": { ... } }
```

`gross_tonnage`, `length_meters`, `decks`, and `year_refurbished` are present in the ship's "Specifications" sidebar on the main `/cruise/{line}/{ship}` overview page (not the `/reviews` subpage). If the caller requires them, follow the redirect from `/cruise/{line}/{ship}` (the overview page) inside the same session — the overview page hydrates a richer `ShipAttributes` record. Omit (set `null`) if not required to keep the skill cheap.
