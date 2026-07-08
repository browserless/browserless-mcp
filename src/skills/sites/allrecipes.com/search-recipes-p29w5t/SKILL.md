---
name: search-recipes
title: Allrecipes Recipe Search
description: >-
  Search Allrecipes for recipes (keyword, ingredient list, category browse, or
  direct recipe URL) and return structured JSON with ratings, ingredients,
  instructions, nutrition, times, and full media — by parsing the SSR HTML
  search cards and each recipe page's schema.org LD+JSON Recipe block.
website: allrecipes.com
category: recipes
tags:
  - recipes
  - cooking
  - food
  - search
  - ld-json
  - schema-org
source: 'browserbase: agent-runtime 2026-05-18'
updated: '2026-05-18'
recommended_method: api
alternative_methods:
  - method: api
    rationale: >-
      Allrecipes serves complete data in static HTML — search results as SSR
      cards and recipe details as one schema.org application/ld+json Recipe
      block per page. No proxy/stealth/auth needed: 200 OK on every probe, no
      rate limit, no anti-bot across 14 fetches. Extract via browserless_agent
      goto + evaluate (parse LD+JSON in-page) or browserless_function
      page-context fetch of the raw HTML.
  - method: browser
    rationale: >-
      Fallback only if Allrecipes adds anti-bot in the future or starts
      hydrating from JS. Today, a remote browser session adds ~100x cost premium
      for zero parsing gain because all fields are already in the HTML response.
      Reserve for: (a) future captcha walls, (b) probing UI elements not in the
      SSR markup (e.g. interactive 'I made it' button state).
verified: false
proxies: false
---

# Allrecipes Recipe Search

## Purpose

Search Allrecipes for recipes matching a query (keyword, ingredient list, category browse, or direct recipe URL) and return structured JSON — per-recipe identifier, title, author + profile URL, hero image + gallery images, star rating + count, prep/cook/total time (ISO 8601 + minutes), servings, calories, full ingredient list, step-by-step instructions, full nutrition facts, category/cuisine/dietary tags, "Made it" count, and the canonical recipe URL. Read-only — never clicks Save, Add to Meal Plan, Print, Rate, Comment, or Sign In.

## When to Use

- "Find me chocolate-chip cookie recipes ranked best-first."
- "Give me five 30-minute vegan dinners using soy sauce."
- "Extract the recipe at allrecipes.com/recipe/10813/... into structured form."
- "Bulk-collect Italian dinner recipes from `/recipes/86/world-cuisine/european/italian/`."
- Building meal planners, ingredient-aware search, recipe databases, or dietary-filter UIs on top of Allrecipes' content.

## Workflow

Allrecipes is lightly walled — every probe in this skill's development (8 search-page fetches and 6 recipe-detail fetches) returned 200 with full SSR HTML. No proxy/stealth/auth/cookies required. Recipe detail pages ship one **schema.org `application/ld+json` Recipe block** with every field; search pages are server-rendered HTML cards (no `__NEXT_DATA__`, no XHR).

**Executing with Browserless.** Two options:

- **`browserless_agent` (recommended)** — `goto` the page (no proxy) and `evaluate` to parse in-page: for a recipe, pull the LD+JSON `Recipe` object directly; for search, scrape the `a.mntl-card-list-card` anchors. Returning parsed JSON beats shipping raw HTML and avoids any base64/binary handling.
- **`browserless_function`** — its sandbox is a browser page context, so `page.goto('https://www.allrecipes.com/')` then `page.evaluate(() => fetch('/search?q=...').then(r=>r.text()))` for same-origin HTML if you specifically want the raw markup.

The step recipes below give the extraction logic; run it inside `evaluate` rather than as offline regex where you can.

### 1. Branch on the input shape

| Input                                                          | Action                                                                                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct recipe URL (`/recipe/<id>/<slug>/`)                     | Skip to step 4 (single-recipe extraction).                                                                                                                       |
| Full Allrecipes search URL (`/search?q=…`)                     | Use as-is in step 2.                                                                                                                                             |
| Free-form query / ingredient list (`"chicken rice soy sauce"`) | Build `https://www.allrecipes.com/search?q=<URL-encoded query>`.                                                                                                 |
| Category-browse intent (e.g. "Desserts", "Italian", "Healthy") | Resolve to a **taxonomy hub URL** `/recipes/<id>/<slug>/` — see the "Honest filter mapping" gotcha below. There is **no `?category=` query param** on `/search`. |

### 2. Fetch the search results page

`browserless_agent`: `goto https://www.allrecipes.com/search?q=chocolate+chip+cookies` (`waitUntil:"load"`), then `evaluate` a card scrape (or `html` on `main` if you want to run the regex offline). For pages 2, 3, …: append `&offset=24`, `&offset=48`, … to the URL and re-`goto`.

```jsonc
"commands": [
  { "method": "goto", "params": { "url": "https://www.allrecipes.com/search?q=chocolate+chip+cookies", "waitUntil": "load", "timeout": 30000 } },
  { "method": "evaluate", "params": { "content": "(()=>{const cards=[...document.querySelectorAll('a.mntl-card-list-card')].map(a=>({url:a.href,recipe_id:(a.href.match(/\\/recipe\\/(\\d+)\\//)||[])[1],title:a.querySelector('.card__title-text')?.textContent.trim(),rating_count:a.querySelector('.rating-count-number')?.textContent.trim(),doc_id:a.getAttribute('data-doc-id')})).filter(c=>c.recipe_id);const noResults=!!document.querySelector('.mntl-search-results__no-results-header');return JSON.stringify({noResults,count:cards.length,cards});})()" } }
]
```

No proxy needed. Redirects: the browser follows them automatically on `goto`, so renamed `/recipe/<id>/<old-slug>/` URLs resolve without any flag (the old `redirect-following` concern is moot in a browser).

### 3. Parse search-result cards from SSR HTML

Each card is one `<a>` anchor with class `mntl-card-list-card`. Iterate them with:

```regex
<a[^>]*mntl-card-list-card[^>]*href="(https://www\.allrecipes\.com/recipe/(\d+)/[^"]+)"(.*?)</a>
```

Per-card fields (all stable across queries; verified on `chocolate chip cookies` and `vegan lasagna`):

| Field                  | Source                                                                                      | Notes                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `recipe_id`            | URL slug-id: `/recipe/(\d+)/`                                                               | Canonical numeric ID. Different from `doc_id` (don't confuse).                                                         |
| `url`                  | `href` attribute                                                                            | Canonical recipe URL.                                                                                                  |
| `title`                | `class="card__title-text">\s*([^<]+)`                                                       |                                                                                                                        |
| `thumbnail`            | `data-src="(https://www\.allrecipes\.com/thmb/[^"]+)"` (lazyload) or noscript `<img src=…>` | 282×188 webp.                                                                                                          |
| `doc_id`               | `data-doc-id="(\d+)"`                                                                       | Internal CMS ID. Useful for cross-product correlation; not the canonical recipe ID.                                    |
| `rating_count`         | `rating-count-number">\s*([0-9,]+)`                                                         | "19,427".                                                                                                              |
| `category_tag`         | `data-tag="([^"]+)"` on the card-content div                                                | Site's curated tag (e.g. "Chocolate Chip Cookie Recipes").                                                             |
| `star_rating` (approx) | Count `icon-star` vs `icon-star-half` `<svg>` siblings inside `mntl-recipe-star-rating`     | **Unreliable to half-star precision from card SVGs.** For exact decimal rating, fetch the recipe detail page (step 4). |

After parsing, emit cards from page 1, then continue to step 4 if the caller wants full recipe details, OR continue with step 5 to enumerate more pages.

### 4. Fetch + parse a single recipe detail page

`browserless_agent`: `goto` the recipe URL (browser follows any rename redirect), then `evaluate` to pull the `Recipe` LD+JSON object directly:

```jsonc
"commands": [
  { "method": "goto", "params": { "url": "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/", "waitUntil": "load", "timeout": 30000 } },
  { "method": "evaluate", "params": { "content": "(()=>{const blocks=[...document.querySelectorAll('script[type*=\"application/ld+json\"]')].map(s=>{try{return JSON.parse(s.textContent)}catch(e){return null}}).filter(Boolean).flatMap(x=>Array.isArray(x)?x:(x['@graph']||[x]));const rec=blocks.find(b=>{const t=b['@type'];return t==='Recipe'||(Array.isArray(t)&&t.includes('Recipe'))});const madeIt=document.querySelector('[data-made-it-count]')?.getAttribute('data-made-it-count');const authorUrl=[...document.querySelectorAll('a[href*=\"/cook/\"]')][0]?.href||null;return JSON.stringify({recipe:rec,made_it:madeIt,author_url:authorUrl});})()" } }
]
```

If you fetched raw HTML instead (`html`/`browserless_function`), the offline parse is:

```python
blocks = re.findall(r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>', html, re.DOTALL)
data = json.loads(blocks[0])
if isinstance(data, list): data = data[0]   # rare: top-level is a list
```

The `@type` is `["Recipe", "NewsArticle"]` (or just `["Recipe"]` for older entries). All the rich fields are at the top level of this single object:

| Output field                       | LD+JSON key                                                                                                                                         | Format                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                             | `name` (fallback `headline`)                                                                                                                        | string                                                                                                                                            |
| `description`                      | `description`                                                                                                                                       | string                                                                                                                                            |
| `author.name`                      | `author[0].name`                                                                                                                                    | "Person" object                                                                                                                                   |
| `primary_image`                    | `image.url`                                                                                                                                         | 1500-wide JPEG URL                                                                                                                                |
| `additional_images`                | `recipeInstructions[i].image[0].url`                                                                                                                | per-step photos; dedupe against `primary_image`                                                                                                   |
| `video`                            | `video.{contentUrl, thumbnailUrl, duration}`                                                                                                        | duration as `PT3M33S`                                                                                                                             |
| `rating.value`                     | `aggregateRating.ratingValue`                                                                                                                       | string-typed decimal, e.g. `"4.6"`                                                                                                                |
| `rating.count`                     | `aggregateRating.ratingCount`                                                                                                                       | string-typed integer                                                                                                                              |
| `times.prep_iso`                   | `prepTime`                                                                                                                                          | `PT20M`                                                                                                                                           |
| `times.cook_iso`                   | `cookTime`                                                                                                                                          | `PT10M`                                                                                                                                           |
| `times.total_iso`                  | `totalTime`                                                                                                                                         | `PT30M` (sometimes `null` for resting/marinating recipes — sum prep+cook as fallback)                                                             |
| `servings`                         | `recipeYield`                                                                                                                                       | array: `["48", "4 dozen cookies"]` (yield number + human label)                                                                                   |
| `ingredients`                      | `recipeIngredient`                                                                                                                                  | array of raw strings (`"1 cup butter, softened"`). Parse to `{quantity, unit, item}` only as a best-effort post-pass; many free-text forms exist. |
| `instructions`                     | `recipeInstructions[i].text`                                                                                                                        | array of step strings                                                                                                                             |
| `nutrition.*`                      | `nutrition.{calories,fatContent,saturatedFatContent,cholesterolContent,sodiumContent,carbohydrateContent,fiberContent,sugarContent,proteinContent}` | unit-suffixed strings: `"146 kcal"`, `"19 g"`, `"76 mg"`                                                                                          |
| `categories`                       | `recipeCategory`                                                                                                                                    | array, e.g. `["Dinner"]`, `["Dessert"]`                                                                                                           |
| `cuisines`                         | `recipeCuisine`                                                                                                                                     | array, e.g. `["American"]`, `["Italian Inspired"]`                                                                                                |
| `keywords`                         | `keywords`                                                                                                                                          | comma-separated string or array                                                                                                                   |
| `date_published` / `date_modified` | `datePublished` / `dateModified`                                                                                                                    | ISO 8601                                                                                                                                          |

**Three fields that are NOT in LD+JSON** — scrape from raw HTML:

```python
# Author profile URL (the LD+JSON has the name only, not the URL)
author_url_match = re.search(
    r'mntl-attribution__item-name[^>]*>([^<]+)</[^>]+>.*?href="(https?://[^"]*/cook/[^"]+)"',
    html, re.DOTALL
)
author_profile_url = author_url_match.group(2) if author_url_match else None

# "Made it" count (community engagement metric)
made_it = re.search(r'data-made-it-count[^>]*>\s*([0-9,]+)', html)
made_it_count = int(made_it.group(1).replace(',', '')) if made_it else None

# Internal CMS doc_id (also visible on search cards as data-doc-id)
doc_id = re.search(r'data-doc-id="(\d+)"', html)
```

### 5. Pagination

```
GET /search?q=<query>&offset=0    → up to 24 cards (page 1)
GET /search?q=<query>&offset=24   → up to 24 cards (page 2)
GET /search?q=<query>&offset=48   → page 3, …
```

**Stop conditions** (apply in order):

1. **Caller-imposed `limit`** — once you've accumulated `limit` cards, stop.
2. **Empty no-results header** — if `.mntl-search-results__no-results-header` is present with text `"0 results found for your search."`, the entire query has no matches.
3. **Card count < 24 on a page** — that's the de facto last page. The pagination footer is misleading (see gotcha) and you must NOT continue paginating past this point.
4. **Hard ceiling** — Allrecipes' search index appears to top out around ~120 results for most queries (5 pages × 24). Cap at offset=200 as a safety stop.

### 6. Apply client-side filters (because the server has none)

After steps 3 and 4, post-filter the result set to honor caller-specified dimensions that Allrecipes does NOT support server-side:

- **Time** — filter by `times.total_iso` parsed to minutes (`PT30M` → 30). Categories: "Under 15 min" → ≤15; "Under 30 min" → ≤30; "Under 1 hour" → ≤60; "1+ hours" → ≥60.
- **Rating** — filter by `rating.value`. `"4+"` → ≥4.0; `"4.5+"` → ≥4.5; `"5"` → ≥4.95.
- **Dietary** — match against `categories`, `cuisines`, and `keywords` (e.g. "vegan", "gluten-free"). Note: Allrecipes' dietary tagging is inconsistent — the most reliable signal is whether the query itself contained the dietary word ("vegan lasagna" yielded recipes whose `categories=['Dinner']` and `cuisines=['Italian Inspired']` without an explicit "Vegan" tag).
- **Must-include / must-exclude ingredients** — substring match against `ingredients[]` (raw strings, lowercased).
- **Occasion / difficulty** — not surfaced on Allrecipes at all; the skill cannot honor these dimensions and should explicitly say so in its response.

Always report in the output which filters were **applied server-side** (none, basically) vs. **applied client-side** so the caller knows the provenance.

### 7. Sort

Allrecipes search has **no sort parameter** (verified — see gotcha). The default ranking is the server's own (it surfaces `10813/best-chocolate-chip-cookies` as result #1 across multiple unrelated query variants, suggesting curated boosting). To honor a caller-specified sort, **sort client-side after extracting LD+JSON ratings/times for each card**:

- `Most Popular` (default) → use server order as-is.
- `Highest Rated` → sort by `rating.value` desc, tie-break by `rating.count` desc.
- `Most Reviewed` → sort by `rating.count` desc.
- `Newest` → sort by `date_published` desc.
- `Quickest` → sort by `times.total_iso` (parsed to minutes) asc.

Document that client-side sort requires fetching the LD+JSON detail page for each card (one extra HTTP request per card) — a non-trivial cost beyond ~10 cards.

## Site-Specific Gotchas

- **The `/search` form takes only `q`.** Sort, dietary, cuisine, meal-type, time, and rating filters that the prompt's intent suggests are simply **not URL-parameterized**. Verified: `&sort=rating`, `&sort=newest`, `&minrating=4` all returned the **same first 3 recipe IDs** (10813, 26237, 9827) as the unfiltered baseline — unrecognized params are silently dropped. Don't waste turns probing for hidden filter params.
- **There is no "X recipes found" count on the search page.** The pagination footer always shows up to 4 numbered page links (offsets 0/24/48/72) and a "Next" link — neither reflects the true total. To know how many results exist, you must page-walk until either (a) `.mntl-search-results__no-results-header` appears, or (b) a page returns < 24 cards.
- **Pagination past the actual results returns garbage, not "no results".** Verified on `vegan lasagna`: page 1 (offset=0) returned 5 cards; page 2 (offset=24) returned **0 cards but no no-results header**; page 3 (offset=48) returned **1 unrelated card** (a Caesar salad recipe). The pagination footer for the same query advertised offsets [0, 24, 48, 72] — completely misleading. **Trust card-count-per-page < 24 as your stop signal**, not the pagination footer and not the no-results selector.
- **The no-results header only fires for "0 results, period".** A query like `xyzqwertyzz` returns `<h2 class="mntl-search-results__no-results-header">0 results found for your search.</h2>`. But page-2-past-the-end of a small successful search returns an empty `.mntl-search-results__list` with **no** no-results header. Detect end-of-results by card count, not by the no-results header for incremental pagination.
- **Honest filter mapping** (because the server has none): meal-type/category → use the taxonomy hub URL `/recipes/<id>/<slug>/` (e.g. `/recipes/79/desserts/`, `/recipes/78/breakfast-and-brunch/`); cuisine → `/recipes/86/world-cuisine/<slug>/`; healthy/dietary → `/recipes/84/healthy-recipes/` subtree. Taxonomy hubs are curated mixed pages (subcategory tiles + featured recipe cards) — they do **not** support `?sort=` or filter chips either; they are static-content hubs, not faceted search.
- **Binary/image handling.** You don't need to fetch images to get recipe data — the image _URLs_ are in the LD+JSON (`image.url`, per-step `recipeInstructions[i].image[0].url`). If you must pull an image file, use `browserless_function` and return it with `type: "image/jpeg"` (comes back as a proper vision block, not base64 text), or hand the URL to the caller.
- **Renamed recipe URLs — the browser follows redirects.** `goto` in `browserless_agent` transparently follows a 301 from an old `/recipe/<id>/<old-slug>/` to the current slug, so no flag is needed. (The old raw-fetch `redirect-following` concern only applied to a headerless HTTP client.)
- **`recipe_id` (URL slug) vs `data-doc-id` are different identifiers.** The canonical recipe ID is the integer in `/recipe/<N>/` (e.g. `10813`). `data-doc-id` (e.g. `6649624`) is the internal CMS document ID and surfaces on both search cards and recipe detail pages, but it does not appear in any URL the public uses. Always use the URL-slug ID as the primary key; surface `doc_id` only as a secondary identifier.
- **The per-card star-rating SVG is hard to parse precisely.** Each card contains a mix of `icon-star` (filled), `icon-star-half`, and (implicitly) empty stars rendered via background. A regex like `icon-star\s` ALSO matches `icon-star-half`. To get the precise decimal rating, fetch the recipe detail page's LD+JSON `aggregateRating.ratingValue` (string-typed). Don't expose card-level star math as the authoritative rating.
- **`recipeYield` is always an array.** E.g. `["48", "4 dozen cookies"]` — the first element is the numeric servings count, the second is a human-readable label. Don't trust positional ordering for older recipes; the numeric form may not always be index 0. Match by `isdigit()` or regex.
- **Time fields are ISO 8601 PT format.** `PT30M` = 30 min, `PT1H30M` = 90 min, `PT3M33S` (video duration) = 3 min 33 sec. `totalTime` may be **absent or null** for recipes with overnight resting/marinating; fall back to `prepTime + cookTime` summed in that case.
- **Nutrition values are unit-suffixed strings**, not numbers. `"146 kcal"`, `"19 g"`, `"76 mg"`. Parse with a regex like `^([0-9.]+)\s*([a-zA-Z]+)$` if you need numerics.
- **Author profile URL is not in LD+JSON** — only the name is. Scrape from `.mntl-attribution__item-name` near the headline. The URL pattern is `/cook/<author-id>/`.
- **"Made it" count is not in LD+JSON** — scrape from `data-made-it-count` attribute on `.mm-recipes-made-it__count`. Stripped of commas: `"40,219"` → `40219`.
- **Search-card thumbnails are 282×188 webp; recipe-page hero is up to 1500×0 JPEG.** If the caller wants high-res imagery, fetch the recipe detail page and use `image.url` from LD+JSON; the search card's `data-src` is intentionally a lazy-load thumbnail.
- **No auth, no anti-bot, no rate-limit observed.** All 14 fetches across the iteration loop returned 200 with no captcha, no Akamai, no Cloudflare challenge. **Do not** set a `proxy` on the `browserless_agent`/`browserless_function` call unless you actually see a 403 — it adds latency for no gain on this site today.
- **Region matters for taxonomy URLs.** `/recipes/86/world-cuisine/italian/` exists; `/recipes/86/world-cuisine/cajun/` exists; but Allrecipes' cuisine taxonomy is US-centric and some niche cuisines may not have hub pages. When in doubt, fall back to `/search?q=<cuisine>+<dish>` and post-filter the LD+JSON `recipeCuisine` field.

## Expected Output

Five distinct outcome shapes. Always include the `filters_honored_server_side: []` and `filters_applied_client_side: [...]` fields so callers can see what the server did vs. what you did.

### 1. Multi-result search (the typical case)

```json
{
  "outcome": "multi_result_search",
  "query": "chocolate chip cookies",
  "source_url": "https://www.allrecipes.com/search?q=chocolate+chip+cookies",
  "page_size": 24,
  "pages_fetched": 1,
  "total_results_estimated": 24,
  "filters_honored_server_side": [],
  "filters_applied_client_side": [
    {
      "dimension": "min_rating",
      "value": 4.0,
      "matched": 18,
      "filtered_out": 6
    }
  ],
  "sort_applied_client_side": { "by": "rating.value", "order": "desc" },
  "results": [
    {
      "recipe_id": "10813",
      "doc_id": "6649624",
      "url": "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/",
      "title": "Best Chocolate Chip Cookies",
      "thumbnail": "https://www.allrecipes.com/thmb/ftTl3UM20In5I3dxLfqrcZqHq5A=/282x188/.../10813-best-chocolate-chip-cookies-mfs-step-7-148-52cdaefcd6e04707863288ded8451075.jpg",
      "rating": { "value": 4.6, "count": 19427 },
      "category_tag": "Chocolate Chip Cookie Recipes",
      "detail_fetched": false
    }
  ]
}
```

### 2. Multi-result with full detail expansion (one LD+JSON fetch per card)

```json
{
  "outcome": "multi_result_search",
  "query": "chocolate chip cookies",
  "results": [
    {
      "recipe_id": "10813",
      "doc_id": "6649624",
      "url": "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/",
      "title": "Best Chocolate Chip Cookies",
      "description": "This classic chocolate chip cookie recipe makes deliciously buttery cookies…",
      "author": {
        "name": "Dora",
        "profile_url": "https://www.allrecipes.com/cook/28183721/"
      },
      "primary_image": "https://www.allrecipes.com/thmb/8xwaWAHtl_QLij6D-G0Z4B1HDVA=/1500x0/.../10813-best-chocolate-chip-cookies-mfs-146-4x3-b108aceffa6043a1ac81c3c5a9b034c8.jpg",
      "additional_images": [
        "https://www.allrecipes.com/thmb/ikAh8YlzsTfWmVA6G6MRHlq7xtU=/1500x0/...step-01.jpg",
        "…"
      ],
      "video": {
        "url": "https://content.jwplatform.com/videos/qHQSNVCK-K3AjnAEN.mp4",
        "thumbnail": "https://cdn.jwplayer.com/v2/media/qHQSNVCK/thumbnails/tibAvzY8.jpg?width=1280",
        "duration_iso": "PT3M33S"
      },
      "rating": { "value": 4.6, "count": 19427 },
      "made_it_count": 40219,
      "times": {
        "prep_iso": "PT20M",
        "cook_iso": "PT10M",
        "total_iso": "PT30M",
        "total_minutes": 30
      },
      "servings": { "yield": 48, "label": "4 dozen cookies" },
      "ingredients": [
        "1 cup butter, softened",
        "1 cup white sugar",
        "1 cup packed brown sugar",
        "2 eggs",
        "2 teaspoons vanilla extract",
        "1 teaspoon baking soda",
        "2 teaspoons hot water",
        "0.5 teaspoon salt",
        "3 cups all-purpose flour",
        "2 cups semisweet chocolate chips",
        "1 cup chopped walnuts"
      ],
      "instructions": [
        "Gather your ingredients, making sure your butter is softened, and your eggs are room temperature.",
        "Preheat the oven to 350 degrees F (175 degrees C). Beat butter, white sugar, and brown sugar together in a large bowl with an electric mixer until smooth and creamy.",
        "Beat in eggs, one at a time, then stir in vanilla."
      ],
      "nutrition": {
        "calories": "146 kcal",
        "fat": "8 g",
        "saturated_fat": "4 g",
        "cholesterol": "10 mg",
        "carbs": "19 g",
        "fiber": "1 g",
        "sugar": null,
        "protein": "2 g",
        "sodium": "76 mg"
      },
      "categories": ["Dessert"],
      "cuisines": ["American"],
      "keywords": ["publisher-tested"],
      "date_published": "1998-04-18T16:10:32-04:00",
      "date_modified": "2026-03-23T19:52:45-04:00",
      "detail_fetched": true
    }
  ]
}
```

### 3. Zero-result search

```json
{
  "outcome": "no_results",
  "query": "xyzqwertyzz",
  "source_url": "https://www.allrecipes.com/search?q=xyzqwertyzz",
  "detection_selector": ".mntl-search-results__no-results-header",
  "site_message": "0 results found for your search.",
  "results": []
}
```

### 4. Direct recipe URL → single recipe extracted

```json
{
  "outcome": "single_recipe",
  "source_url": "https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/",
  "recipe": {/* same shape as `results[i]` in outcome #2 above */}
}
```

### 5. Category-browse intent → taxonomy hub

```json
{
  "outcome": "category_hub",
  "query": "Desserts",
  "resolved_url": "https://www.allrecipes.com/recipes/79/desserts/",
  "subcategories": [
    {
      "name": "Chocolate",
      "url": "https://www.allrecipes.com/recipes/1557/desserts/chocolate/"
    },
    {
      "name": "Cakes",
      "url": "https://www.allrecipes.com/recipes/276/desserts/cakes/"
    },
    {
      "name": "Cobblers",
      "url": "https://www.allrecipes.com/recipes/361/desserts/cobbler/"
    }
  ],
  "featured_recipes": [{/* card-shaped objects as in outcome #1 */}],
  "note": "Taxonomy hubs are curated mixed pages — they do not support sort or filter chips. Use them as entry points, then narrow with /search?q= for fine-grained matches."
}
```
