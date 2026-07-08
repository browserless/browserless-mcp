---
name: search-listings
title: Cars.com Vehicle Search
description: >-
  Search Cars.com new + used + CPO inventory across the full Cars.com filter
  rail (make/model/trim, year/price/mileage ranges,
  body/fuel/transmission/drivetrain, color, features, vehicle history, seller
  type, location + radius, sort, pagination) and return active listings — with
  VIN, full title, price + MSRP + deal-rating delta, mileage, dealer name +
  rating + distance, photos, and canonical VDP URL — as structured JSON.
  Read-only.
website: cars.com
category: automotive
tags:
  - automotive
  - marketplace
  - listings
  - search
  - akamai
  - read-only
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: api
alternative_methods:
  - method: api
    rationale: >-
      The /shopping/results/?... SRP server-renders the entire listing payload
      as a single JSON blob inside <script type="application/json"
      id="CarsWeb.SearchController.index">. A browserless_agent goto behind a
      residential proxy + in-page evaluate that parses that script tag is ~10x
      cheaper than driving the full filter-rail UI and returns identical data —
      no follow-up GraphQL/XHR is needed. Cars.com has no documented public
      listing API; this internal SSR-JSON is the de facto one.
  - method: browser
    rationale: >-
      Required for (a) VDP-only lookups when the caller has a
      /vehicledetail/{listing_id}/ URL with no prior search context — VDP HTML
      is Akamai-blocked at the path level, so it must be rendered — and (b) wide
      SRP queries whose HTML body exceeds the text-return cap unless projected
      in-page. Residential proxy (proxy: { proxy: "residential" }) is
      mandatory; plain calls land on the Akamai 'Performing security
      verification' interstitial.
verified: true
proxies: true
---

# Cars.com Search Listings

## Purpose

Search Cars.com new + used + certified-pre-owned inventory and return active listings as structured JSON. Supports the **full Cars.com filter rail** — condition, make/model/trim, year/price/mileage/payment ranges, body style, fuel type, transmission, drivetrain, cylinder count, EV range, exterior + interior color, feature flags, vehicle history, seller type, dealer rating, delivery flags, location + radius, sort order, and pagination. Returns per-listing identity (listing_id, VIN, full title), pricing (raw + formatted + MSRP + monthly-payment estimate + price-drop badges), mileage, body/fuel/transmission/drivetrain, deal rating (`Great Deal | Good Deal | Fair Deal | High Price | No Price Analysis`) with the dollar delta vs market, dealer name + rating + location + distance, primary thumbnail + full gallery (up to ~30 image URLs), shippable / delivery / financing flags, vehicle-history affordances, canonical VDP URL, and total-result count + pagination cursor.

Also accepts a direct VDP URL (`/vehicledetail/{listing_id}/`) for single-listing lookups. **Read-only — never clicks Get Pre-Approved, Contact Dealer, Check Availability, Calculate Payment, Save, or Sign In.**

## When to Use

- "find me a used Honda Civic in Austin under $15k from 2018 or newer"
- Bulk inventory snapshots for a make/model across a radius or nationwide
- Comparison shopping with deal-rating context across multiple ZIPs / dealers
- Re-pricing alerts: re-run a saved-search URL and diff `analytics.fingerprint.updated_at` per listing
- VDP-level lookup when the caller already has a `listing_id` (or a `/vehicledetail/...` URL)

## Workflow

The cars.com SRP (search results page) at `/shopping/results/?...` **server-renders the entire listing payload as a single JSON blob** inside a `<script type="application/json" id="CarsWeb.SearchController.index">` tag. The page is React-driven but it is hydrated from this SSR JSON — no follow-up XHR / GraphQL POST is required to enumerate results. Lead with a **`browserless_agent` `goto` behind a residential proxy** (`proxy: { proxy: "residential" }`), then an in-page `evaluate` that parses the embedded JSON and returns a compact projection — never ship the raw ~1 MB HTML back. (Equivalently, a `browserless_function` that `page.goto`s the SRP and reads the embedded JSON in-page works; honor the function runtime constraint — browser page context, ~200k-char return cap — so project inside the eval.) Driving the full filter-rail UI works as a fallback but pays a ~10× cost premium for identical data.

### Recommended path — residential-proxy goto + embedded-JSON extraction

1. **Resolve the inputs to URL params**:
   - `stock_type` — comma-free single value: `new`, `used`, `cpo`. To request used + CPO together, pass `stock_type=used` and add the `cpo_listings_only=true` filter via the filter rail (server folds it in), or pass `stock_type=cpo` for certified-only. The condition is single-select in the URL even though the UI shows it as multi-select.
   - `makes[]=<slug>` — repeat for multi-select. Slug format: lowercased + hyphenated (`honda`, `bmw`, `mercedes-benz`, `land-rover`).
   - `models[]=<slug>` — repeat for multi-select. Slug format: `<make>-<model>` with underscores for spaces in the model name (`honda-civic`, `tesla-model_y`, `ford-f-150`, `chevrolet-corvette`).
   - `trims[]=<slug>` — cascading from model. Slug format: `<make>-<model>-<trim>` (`honda-civic-lx`).
   - `year_min=<YYYY>`, `year_max=<YYYY>` — inclusive bounds.
   - `list_price=<min>`, `list_price_max=<max>` — USD integer. (`list_price` is the min input despite the name.)
   - `mileage_max=<int>` — odometer ceiling in miles. No `mileage_min` is exposed.
   - `monthly_payment=<int>` — when shopping by payment. Pairs with `down_payment_amount`, `loan_term_in_months` (36/48/60/72/84), `interest_rate_percent` — surfaced as UI sliders but accepted as URL params.
   - `body_style_slugs[]=<slug>` — `sedan`, `suv`, `truck`, `hatchback`, `coupe`, `convertible`, `wagon`, `van`, `minivan`.
   - `fuel_slugs[]=<slug>` — `gasoline`, `diesel`, `hybrid`, `plug_in_hybrid`, `electric`, `flex_fuel`, `hydrogen`.
   - `transmission_slugs[]=<slug>` — `automatic`, `manual`, `cvt`, `dual_clutch`.
   - `drivetrain_slugs[]=<slug>` — `fwd`, `rwd`, `awd`, `four_wheel_drive`.
   - `cylinder_counts[]=<n>` — `3`, `4`, `5`, `6`, `8`, `10`, `12`.
   - `door_counts[]=<n>` — `2`, `3`, `4`, `5`.
   - `cab_type_slugs[]=<slug>` — pickup cab type: `crew_cab`, `extended_cab`, `regular_cab`.
   - `size_slugs[]=<slug>` — vehicle size class: `compact`, `midsize`, `fullsize`, `subcompact`, etc.
   - `exterior_color_slugs[]=<slug>` / `interior_color_slugs[]=<slug>` — palette: `black`, `white`, `silver`, `gray`, `red`, `blue`, `green`, `brown`, `gold`, `beige`, `yellow`, `orange`, `purple`.
   - `electric_total_range_miles_min=<int>` — for EV searches.
   - `hours_to_charge_240v_max=<float>` — for EV searches.
   - `convenience_features[]=`, `entertainment_features[]=`, `exterior_features[]=`, `safety_features[]=`, `seating_features[]=` — multi-select on the feature catalog. Examples: `apple_carplay`, `android_auto`, `adaptive_cruise_control`, `lane_keep_assist`, `blind_spot_monitor`, `heated_seats`, `cooled_seats`, `sunroof_moonroof`, `third_row_seating`, `leather_seats`, `navigation_system`, `tow_hitch`, `backup_camera`, `parking_sensors`, `premium_audio`.
   - `vehicle_history_group[]=<slug>` — `single_owner`, `no_accidents`, `personal_use`, `clean_title`.
   - `seller_type[]=<slug>` — `dealer`, `private_seller`, `marketplace` (Cars.com Marketplace).
   - `deal_ratings[]=<slug>` — `great-deal`, `good-deal`, `fair-deal`. (`high-price` and `no-price-analysis` are valid badge variants but not exposed as filter values.)
   - `award_slugs[]=` — IIHS / NHTSA / KBB award filters. **Do not** also pass an `award_link=…` query param — that's robots-disallowed and triggers Akamai 403 (see gotchas).
   - `lifestyle_slugs[]=` — `family_friendly`, `off_road`, `luxury`, `fuel_efficient`, etc.
   - `keyword=<urlenc>` — free-text search inside listing descriptions.
   - `only_with_photos=true` — equivalent of "Show only cars with photos".
   - `zip=<5-digit ZIP>` + `maximum_distance=<10|25|50|75|100|200|500>` — location + radius. **Do NOT pass `maximum_distance=all`** (Akamai-blocked); for "nationwide" use `maximum_distance=500` plus `include_shippable=true`.
   - `include_shippable=true|false` — when true, the SRP injects out-of-radius listings whose dealer offers shipping. Default behavior includes them; pass `include_shippable=false` for strict radius-only results.
   - `dealer_id=<uuid>` — optional, restricts to a single dealer (the customerId surfaced in each listing's `seller.customerId`).
   - `sort=<value>` — `best_match_desc` (default), `list_price` (low→high), `list_price_desc` (high→low), `mileage` (low→high), `mileage_desc` (high→low), `distance` (nearest), `year_desc` (newest), `year` (oldest), `listed_at_desc` (newest listed), `listed_at` (oldest listed). **Do NOT pass `sort=best_deal`** even though the UI offers it — `*sort=best_deal*` is in the robots-disallow list and triggers Akamai 403 even on a residential-proxy browser load; sort client-side by parsing the deal-rating badge instead.
   - `page=<int>` — 1-indexed pagination. **Do NOT pass `page_size`** — `*page_size*` is robots-disallowed and triggers 403. Page size is fixed at 24 listings/page server-side.

2. **Load the SRP through a residential proxy** — bare egress from cloud IPs is Akamai-challenged. Always pass `proxy: { proxy: "residential" }` on the call; a real browser follows the 301-through-`Set-Cookie` interstitial natively (no explicit redirect flag needed):

   ```json
   {
     "method": "goto",
     "params": {
       "url": "https://www.cars.com/shopping/results/?stock_type=used&makes%5B%5D=honda&models%5B%5D=honda-civic&zip=78701&maximum_distance=50&list_price_max=18000&year_min=2018&sort=list_price&page=1",
       "waitUntil": "load",
       "timeout": 45000
     }
   }
   ```

   Encode `[` and `]` as `%5B` / `%5D` in the URL you pass to `goto` — keep it RFC-3986 valid; raw brackets can be rejected. Typical SRP HTML is 600 KB – 1.5 MB. Don't return the raw HTML — the text-return cap (~200k chars) will truncate it. **Do the extraction in-page** (next step) so only the compact projection crosses the boundary. If a query is so wide it can't be projected under the cap, tighten filters (add a `list_price_max`, narrow `year_min/max` or `maximum_distance`).

3. **Extract the embedded JSON state in-page** with an `evaluate` command — parse the SSR'd script tag, project, and `JSON.stringify` the result (returned under `.value`). Single regex against the script tag:

   ```js
   const re =
     /<script type="application\/json" id="CarsWeb\.SearchController\.index">([\s\S]*?)<\/script>/;
   const state = JSON.parse(document.documentElement.innerHTML.match(re)[1]);
   // state.srp_results.metadata.total_listings    — authoritative result count
   // state.srp_results.metadata.page              — current page (echoed back)
   // state.srp_results.metadata.page_size         — fixed at 24
   // state.srp_results.metadata.sort              — echoed-back sort param
   // state.srp_results.metadata.selected_search_filters[] — list of every applied filter
   // state.srp_results.results[]                  — listings on this page
   // state.srp_results.search_title               — human-readable summary, e.g. "Used 2018-2019 Honda Civic for sale under $15,000 near Austin, TX"
   // state.srp_filters                            — filter rail enum (use to validate slugs)
   ```

   The metadata's `total_pages` is unreliable — observed `total_pages: 1` with `total_listings: 19` even after a page=2 fetch returned 14 more cards. Compute `total_pages = ceil(total_listings / 24)` yourself; trust `total_listings` as the authoritative count.

4. **Decode each listing in `state.srp_results.results[i]`**. The listing record carries three redundant payload shapes — pick whichever is convenient:
   - **Core fields**: parse the entity-encoded JSON in `result.analytics.context` (same shape as the page's `<fuse-card data-listing-id ... data-vehicle-details="...">` attribute). Keys: `vin`, `year`, `make`, `model`, `trim`, `mileage`, `price`, `msrp`, `bodyStyle`, `fuelType`, `stockType`, `cpoIndicator`, `seller.zip`, `seller.customerId`, `deliveryType`, `financingType`, `primaryThumbnail`, `isaContext`, `shipPrice`. Entity decode: `&quot;`→`"`, `&amp;`→`&`, `&#39;`→`'`.
   - **Layout tree** (`result.body.items[]`, `result.footer.items[]`) — typed nodes: `Text` (with `text_snippets[].text_style`: `xlarge_bold` = price, `medium_bold` = title `"Used 2019 Honda Civic EX"`, `small` + `grey_70` = dealer name), `DatumIcon` (`name`/`value` pairs: `Mileage: 170,614 mi.`, `Review rating: 4.4`, `Listing location: Austin, TX (5 mi)`, `Price drop: $540`, `Days on Cars.com: 14`, `Free CARFAX Report` / `AutoCheck`), `Badge` (deal rating — see next bullet).
   - **Deal rating Badge** at the first `Badge` node in `result.body.items[].items[]`: `value: "Great Deal"`, `variant: "great-deal"` (also `good-deal`, `fair-deal`, `high-price`, `no-price-analysis`), `description: "Based on the dealership's total vehicle list price, this vehicle may present a great buying opportunity at $317 below the average market price of similar vehicles in the same geographic area at $12,207."` — parse the `$NNN below|above` substring for the signed dollar delta vs market.
   - **Gallery** (`result.gallery`) — `images[]` with full-resolution URLs on `platform.cstatic-images.com/large/...` plus `image_count` (the true count; `images[]` is typically truncated to the first ~6 in SRP context — see gotcha for full-gallery retrieval).
   - **VDP URL**: `https://www.cars.com/vehicledetail/{result.listing_id}/` (deterministic — don't bother extracting from the layout tree's `on_click_interactions[].destination`).
   - **Fingerprint**: `result.analytics.fingerprint` is `"id:<listing_id> updated_at:<YYYY-MM-DD HH:MM:SS>"` — use the timestamp as a cache key for change-detection.

5. **Filter shippable-expansion noise** (critical when the user wants radius-only results). The SRP injects "STANDARD_SHIPPABLE" listings from outside the requested radius unless `include_shippable=false` was passed. These cards have `isaContext === "STANDARD_SHIPPABLE"` and `deliveryType === "shippable"` in their `analytics.context` payload, AND a non-null `shipPrice`. They do **not** count toward `metadata.total_listings`. Decide explicitly: emit them as a separate `shippable_expansions: [...]` array or drop them.

6. **Paginate** (only when `total_listings > 24`):

   ```
   GET /shopping/results/?<same-params>&page=2
   GET /shopping/results/?<same-params>&page=3
   ...
   ```

   Stop at `ceil(total_listings / 24)`. Each page is a fresh `goto` + in-page `evaluate` — the embedded JSON shape is identical, just with a new `metadata.page` and a fresh `results[]` slice. Keep the pages inside one `browserless_agent` call's `commands` array so the residential-proxy session and Akamai cookies persist across page fetches.

7. **Direct-VDP shape** — when the caller's input is a `/vehicledetail/{listing_id}/` URL with no search context: **the VDP is Akamai-blocked** (`/vehicle/` and `/vehicledetail/` are robots-disallowed → 403 to a bare cross-origin fetch or bare-IP curl). Render it with `browserless_agent` (residential proxy, `goto` + `evaluate`), then read `<script type="application/json" id="CarsWeb.VehicleDetailController.index">` in-page (same SSR-JSON pattern as SRP). If the listing is present in _any_ SRP search you've already done, the per-card JSON already carries 95% of VDP fields — only `vehicleHistoryReport`, `daysOnMarket`, `dealer.fullAddress`, and the rest of `gallery.images[]` beyond the first ~6 require the actual VDP.

### Browser fallback (when a wide SRP can't be projected under the cap, or when loading a VDP)

Same `browserless_agent` shape as the recommended path — just add a settle wait before the extract. One call, residential proxy, `commands`:

```json
{
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.cars.com/shopping/results/?...",
        "waitUntil": "load",
        "timeout": 45000
      }
    },
    { "method": "waitForTimeout", "params": { "time": 2500 } },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{ /* same regex extract + projection as step 3 */ })()"
      }
    }
  ]
}
```

The residential `proxy` is required; a plain call lands on the "Performing security verification" Akamai interstitial. No session-release step — there's nothing to release; the session persists across calls, keyed by `proxy`/`profile`, so repeat the same residential `proxy` on every call to reconnect to the same warmed session (dropping or changing it lands you in a different, blank one). Do not `type`/`click` the filter rail — the URL-param path produces identical results and skips ~5 turns of UI driving per query.

## Site-Specific Gotchas

- **READ-ONLY.** Never click `Get Pre-Approved`, `Contact Dealer`, `Check Availability`, `Calculate Payment` (when it surfaces the lead form), `Save`, `Sign In`, `Schedule Test Drive`, `Apply for Financing`. Never submit any form. The skill returns inventory, not actions.
- **Akamai uses cars.com's `robots.txt` as a 403-trigger pattern list.** Any URL whose query string matches a `Disallow: *...*` pattern from <https://www.cars.com/robots.txt> returns a Cloudflare/Akamai challenge HTML (status 403, ~6 KB body titled "Performing security verification") even through residential proxies. The hot landmines, all from the live robots.txt:
  - `*maximum_distance=all*` → use `maximum_distance=500` + `include_shippable=true` for nationwide.
  - `*page_size*` → don't pass; server-side fixed at 24/page.
  - `*sort_by*` → use `sort=` not `sort_by=`.
  - `*sort=best_deal*` → don't pass even though the UI offers "Best deal"; sort client-side by parsing each card's deal-rating `variant`.
  - `*ni=1*`, `*ni=2*`, `*ni=3*` → an internal no-index pagination sentinel; don't include.
  - `*award_link*`, `*ev_report_url*`, `*href_to_vdp*` → internal-affordance tracking params; never echo them back into a request URL.
    Also explicitly blocked at the path level: `/shopping/` (bare landing), `/shopping/certified-preowned/`, `/vehicle/`, `/vehicledetail/`. The actual SRP `/shopping/results/?...` is in the robots disallow as well (`Disallow: /shopping/results/`) but is reachable via a residential-proxy browser load — the bot-block lookup is _string-match against the query-string disallows above_, not a global block on the path.
- **The text return is capped (~200k chars), so never return the raw SRP HTML.** Wide queries (e.g. `stock_type=used` + a popular make + 25-mile radius) produce 600 KB – 1.5 MB of HTML because each SRP card carries gallery URLs + analysis blurbs — far over the cap. Always parse and project in the in-page `evaluate` so only the compact JSON crosses the boundary; if even the projection is too large, tighten filters (price ceiling, narrower year range, smaller radius). Pagination does **not** reduce the per-page HTML size.
- **Residential proxy is mandatory.** Without `proxy: { proxy: "residential" }`, even valid SRP URLs land on the Akamai "Just a moment..." challenge page. The residential proxy is what gets a clean 200; a real browser follows the `Set-Cookie` 301 interstitial on its own.
- **Listing slugs use underscores, not spaces, for spaces in model/trim names**: `tesla-model_y`, `ford-f-150` (the F-150 is a hyphen in the model name but not encoded as an underscore — verify against `state.srp_filters` enum), `chevrolet-corvette`, `mercedes-benz-c_class`. When in doubt, navigate the filter rail once with the browser fallback and read the slug off the `listing_search_filter.options[].value` field in `state.srp_filters`.
- **`stock_type` is single-select in the URL.** The UI checkbox lets you select new + used + CPO simultaneously, but the URL encodes only one value. To union `used` and `cpo`, run two queries and dedupe on `listing_id`.
- **`metadata.total_pages` is unreliable** — observed `total_pages: 1` on a result set with `total_listings: 19` that paginates to page 2 with 14 more cards. Always compute `total_pages = ceil(total_listings / 24)` client-side. Trust `total_listings`; ignore `total_pages`.
- **Shippable expansion inflates `results[].length` above `total_listings`.** When `include_shippable` is unset (default), the SRP appends out-of-radius listings whose dealer ships nationwide. These have `analytics.context.isaContext === "STANDARD_SHIPPABLE"` and `analytics.context.shipPrice` set (an integer dollar shipping fee). They are **not** counted by `total_listings`. The caller must decide whether to keep them (and surface them under a separate key) or drop them. Pass `include_shippable=false` for strict radius-only.
- **VDP is 403-blocked at the path level**, including to a bare cross-origin fetch. Rendering it with `browserless_agent` (residential proxy, `goto` + in-page `evaluate`) is the only way to load a VDP. **However**, the SRP card already carries the bulk of VDP data — `vin`, full title, price, mileage, dealer name, dealer rating, dealer ZIP, distance, deal-rating badge with description text, primary photo, and ~6 gallery URLs. The fields that require the actual VDP load are: full gallery (all ~30 images), `vehicleHistoryReport` (CarFax / AutoCheck full report URLs), `daysOnMarket`, dealer full address, dealer phone, and the "Features & Specs" feature checklist.
- **Days-on-Cars.com (`daysOnMarket`) is not in the SRP-side JSON** for every card — it appears as a `DatumIcon` named `Days on Cars.com` only on listings that have crossed the platform's surfaceable threshold (typically ≥ 7 days). Treat its absence as "<7 days" rather than as a missing field.
- **`MSRP` is present only on new + CPO listings** and frequently rendered as `"0"` (string) on used listings even when MSRP would be undefined. Coerce `msrp === "0"` to `null` before emitting.
- **`price` may be a string** (`"11350"`) in `analytics.context`, but is rendered as `"$11,350"` in the layout tree. Don't trust the formatted version to be a number; the integer is in `analytics.context.price` (string of digits → `parseInt`).
- **"Price drop" is a delta indicator, not an absolute**: the `Price drop: $540` DatumIcon means the listing dropped $540 from its previous listed price — not the current price. Surface it as a separate `price_drop_amount` field, not a primary price.
- **Deal rating absence is meaningful.** `result.body.items[]` may contain _no_ `Badge` node when the listing has insufficient comps for analysis. Emit that as `deal_rating: "No Price Analysis"` (matching the variant `no-price-analysis`), not `null` — the caller's downstream filters expect the explicit label.
- **Dealer rating may be absent** for private sellers and Marketplace listings. Check `seller_type` (when present in `state.srp_results.metadata.selected_search_filters[]` or inferred from the dealer-name block being missing or "Private Seller"). For private listings, the dealer-related fields collapse to a single `seller_zip`.
- **Listing freshness**: `analytics.fingerprint` carries an `updated_at` ISO-ish timestamp. Use it for change-detection across runs; cars.com refreshes inventory continuously and individual `listing_id`s may flip between active and sold without a slug change.
- **`include_shippable` and `dealer_id` are the only filters that interact with the location filter.** When `dealer_id=<uuid>` is supplied, `zip` + `maximum_distance` are ignored server-side. When `include_shippable=true`, `maximum_distance` is honored for the "within radius" portion of results and shippable cards are appended after.
- **`goto` URL strictness**: encode brackets in the URL you pass to `goto` — `[` and `]` as `%5B` and `%5D` — and keep it RFC-3986 valid. Raw brackets can be rejected as a malformed URI.
- **Anti-bot LLM-user list**: cars.com's robots.txt explicitly lists `ChatGPT-User`, `Claude-User`, `Perplexity-User` with the same disallow rules. The `browserless_agent` browser path does not advertise a `User-Agent` matching these — but if you ever set `User-Agent: Claude-User` explicitly, expect immediate 403s on `/shopping/results/`.

## Expected Output

Three distinct response shapes — the result envelope is the same; only the contents differ.

```jsonc
// 1) Search returned listings
{
  "success": true,
  "query": {
    "search_url": "https://www.cars.com/shopping/results/?stock_type=used&makes%5B%5D=honda&models%5B%5D=honda-civic&zip=78701&maximum_distance=50&list_price_max=15000&year_min=2018&year_max=2019",
    "stock_type": "used",
    "makes": ["honda"],
    "models": ["honda-civic"],
    "zip": "78701",
    "maximum_distance": 50,
    "list_price_max": 15000,
    "year_min": 2018,
    "year_max": 2019,
    "sort": "best_match_desc",
    "page": 1
  },
  "search_title": "Used 2018-2019 Honda Civic for sale under $15,000 near Austin, TX",
  "total_listings": 1,
  "total_pages": 1,
  "page": 1,
  "page_size": 24,
  "listings": [
    {
      "listing_id": "63cbc79f-54c1-480f-927b-567915f5767d",
      "vin": "19XFC1F37KE202871",
      "title": "Used 2019 Honda Civic EX",
      "year": 2019,
      "make": "Honda",
      "model": "Civic",
      "trim": "EX",
      "stock_type": "Used",
      "cpo": false,
      "body_style": "Sedan",
      "fuel_type": "Gasoline",
      "transmission": null,
      "drivetrain": null,
      "mpg_city": null,
      "mpg_highway": null,
      "mpg_combined": null,
      "price": { "raw": 11350, "formatted": "$11,350", "currency": "USD" },
      "msrp": null,
      "monthly_payment_estimate": null,
      "price_drop_amount": 540,
      "mileage": { "raw": 170614, "formatted": "170,614 mi." },
      "exterior_color": null,
      "interior_color": null,
      "deal_rating": {
        "label": "Great Deal",
        "variant": "great-deal",
        "delta_vs_market": -317,
        "market_average": 12207,
        "analysis": "Based on the dealership's total vehicle list price, this vehicle may present a great buying opportunity at $317 below the average market price of similar vehicles in the same geographic area at $12,207."
      },
      "dealer": {
        "name": "Mercedes-Benz of Austin",
        "rating": 4.4,
        "zip": "78752",
        "customer_id": "09a5c033-11f3-5000-be0c-9a52c2e9b9c8",
        "location_label": "Austin, TX",
        "distance_miles": 5,
        "seller_type": "dealer"
      },
      "vehicle_history": {
        "carfax_report_available": false,
        "autocheck_report_available": false,
        "single_owner": null,
        "no_accidents_reported": null,
        "clean_title": null
      },
      "delivery": {
        "is_shippable_expansion": false,
        "isa_context": "STANDARD",
        "delivery_type": null,
        "ship_price": null
      },
      "financing_type": "unavailable",
      "primary_photo_url": "https://platform.cstatic-images.com/in/v2/09a5c033-11f3-5000-be0c-9a52c2e9b9c8/d7824ea5-c2db-408a-b174-f479b45cb77e/bx7fSJL9E2KIgUYlN-9ySk5WND4.jpg",
      "photo_urls": ["https://platform.cstatic-images.com/large/in/v2/.../bx7fSJL9E2KIgUYlN-9ySk5WND4.jpg", "..."],
      "photo_count": 29,
      "days_on_market": null,
      "listing_url": "https://www.cars.com/vehicledetail/63cbc79f-54c1-480f-927b-567915f5767d/",
      "fingerprint_updated_at": "2026-05-18 16:28:08"
    }
  ],
  "shippable_expansions": [
    /* same shape as `listings[]`, only with delivery.is_shippable_expansion: true */
  ]
}

// 2) Search ran but matched zero listings
{
  "success": true,
  "query": { /* ... */ },
  "search_title": "Used 2024-2024 Land Rover Defender for sale under $5,000 near 99501",
  "total_listings": 0,
  "total_pages": 0,
  "page": 1,
  "page_size": 24,
  "listings": [],
  "shippable_expansions": []
}

// 3) Search-URL or filter validation failed (Akamai 403 / robots-disallowed param / invalid slug)
{
  "success": false,
  "reason": "akamai_blocked" | "invalid_filter_slug" | "response_too_large" | "vdp_blocked",
  "url_attempted": "https://www.cars.com/shopping/results/?...&sort=best_deal",
  "status_code": 403,
  "hint": "sort=best_deal is robots-disallowed and Akamai-blocked. Use sort=best_match_desc and parse deal_rating client-side, or retry with the browser fallback."
}
```
