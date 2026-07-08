---
name: explore-jewelry-contact-concierge
title: Ada Diamonds Catalog Explorer & Concierge Contact
description: >-
  Browse and refine Ada Diamonds' lab-grown jewelry catalog (engagement rings,
  wedding bands, fine jewelry, loose diamonds) via URL query-string filters, and
  surface every channel for reaching their complimentary Diamond Concierge team
  (inquiry form, phone, NYC showroom, virtual consultation). Read-only — never
  submits the form or books an appointment.
website: adadiamonds.com
category: jewelry
tags:
  - jewelry
  - lab-diamonds
  - engagement-rings
  - concierge
  - read-only
  - catalog-search
source: 'browserbase: agent-runtime 2026-05-29'
updated: '2026-05-29'
recommended_method: browser
alternative_methods:
  - method: fetch
    rationale: >-
      Catalog pages are server-rendered enough that a plain HTTPS GET with the
      documented `?shapes=` / `?metals=` query params returns enough
      HTML/markdown to list products without a full browser. Useful when only
      the product list is needed and no live-search overlay or carat-slider is
      in scope. Default to browser-driven for richer extraction and to mirror
      the configuration that survived the host's anti-bot probe inconclusively.
  - method: api
    rationale: >-
      Not viable. No documented JSON or GraphQL endpoint exists for Ada's
      catalog; the Next.js app does not expose `/api/products` or similar.
      Confirmed by inspecting product listings, filter behavior, and detail
      pages — all server-rendered HTML. Don't waste time probing.
verified: true
proxies: true
---

# Ada Diamonds Catalog Explorer & Concierge Contact

## Purpose

Browse and refine Ada Diamonds' lab-grown jewelry catalog (engagement rings, wedding bands, fine jewelry, loose certified lab diamonds), summarize what's available for a given query, and surface the available channels for reaching the brand's complimentary Diamond Concierge team. Read-only — never submits the inquiry form, never adds to cart, never books a consultation. The skill returns a structured "what we found in the catalog" + "how to contact the concierge" payload that downstream agents can present to the user or use to draft a personalized inquiry.

## When to Use

- "Show me Ada Diamonds' oval engagement rings under $5k setting-only."
- "Does Ada Diamonds carry pear-cut lab diamonds around 1.5–2 ct?"
- "I want a Round Halo Pavé setting — what does it look like and how do I talk to a concierge about it?"
- "How do I get in touch with Ada's diamond concierge — phone, email, form, showroom?"
- Pre-purchase research / shortlist creation before handing off to a human concierge conversation.

## Workflow

The Ada Diamonds storefront is a Next.js application served from `https://www.adadiamonds.com/`. All catalog refinement happens via **URL query parameters** on plain category pages — no GraphQL, no JSON API, no auth or cookies needed for read-only browsing. Drive it like a documented site: hit the URL directly with filters baked into the query string, read the rendered DOM/markdown, and only fall back to clicking the on-page filter buttons if you need to validate that a combination actually returned products (the UI gracefully shows "Sorry, we couldn't find any results…" for empty combinations).

### 1. Start a session

Use `browserless_agent`. A bare session reads fine in spot checks, but Ada is CDN-fronted and the pre-run anti-bot probe was inconclusive, so default to a residential proxy as a defensive measure: pass `proxy: { proxy: "residential" }` on the call (repeat it on every call — the session persists across calls, keyed by `proxy`/`profile`, so a call that drops or changes the proxy lands in a different session). Downgrade to no proxy only if you confirm the site is clean for your egress.

### 2. Pick the right catalog root

| Intent                                   | URL                                                            |
| ---------------------------------------- | -------------------------------------------------------------- |
| All engagement-ring settings             | `https://www.adadiamonds.com/lab-diamond-engagement-rings-all` |
| All wedding bands                        | `https://www.adadiamonds.com/wedding-bands-all`                |
| Fine jewelry (overview/landing)          | `https://www.adadiamonds.com/fashion-jewelry-home`             |
| Earrings                                 | `https://www.adadiamonds.com/earrings`                         |
| Necklaces                                | `https://www.adadiamonds.com/necklaces`                        |
| Bracelets                                | `https://www.adadiamonds.com/bracelets`                        |
| Fashion rings                            | `https://www.adadiamonds.com/fashion-rings`                    |
| Loose certified lab diamonds             | `https://www.adadiamonds.com/buy-lab-diamonds`                 |
| Custom design (no inventory — info page) | `https://www.adadiamonds.com/custom`                           |

All host header references resolve to the `www.` apex; if you hit `adadiamonds.com/...` you'll silently land on `www.adadiamonds.com/...`.

### 3. Apply filters via URL query params

Every catalog page that lists products supports the same two refinement params, comma-separated for multi-select. Both work on engagement rings, wedding bands, jewelry category pages, AND `/buy-lab-diamonds`. The active filters render in an "Active filters" region just above the result grid, with a `Clear Filters` button — useful as a positive signal that the URL params were parsed.

```
?shapes=<Shape1>[,<Shape2>...]
?metals=<Metal1>[,<Metal2>...]
```

**Shapes (exact case-sensitive values):** `Round`, `Oval`, `Cushion`, `Pear`, `Emerald`, `Asscher`, `Radiant`, `Princess`, `Marquise`

**Metals (URL-encode the space):** `White%20Gold`, `Yellow%20Gold`, `Rose%20Gold`. Note the UI button labels the white-gold filter as `White Gold / Platinum` — pass just `White Gold` in the URL. White Gold/Platinum is the default for most "Setting Only" starting prices.

Example:

```
https://www.adadiamonds.com/lab-diamond-engagement-rings-all?shapes=Round,Oval&metals=White%20Gold
```

`/buy-lab-diamonds` additionally exposes a **Carat** range filter in the UI, but the carat range is set via UI sliders, not query params — if a carat constraint is essential, click `Filter & Sort` → drag the Carat sliders → re-read the result list. For most queries, the default carat range plus a `shapes=` URL filter is sufficient and ~30+ pre-rendered listings will already be visible.

### 4. Extract the result set

One `browserless_agent` call (keep `proxy` set): `goto` the filtered URL, let it settle, then `evaluate` a scrape of the product anchors — the catalog cards are `<a>` links whose href matches the product-URL shapes below, so pull them directly rather than parsing rendered markdown:

```jsonc
{
  "rationale": "Reading Ada catalog results",
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.adadiamonds.com/lab-diamond-engagement-rings-all?shapes=Round,Oval&metals=White%20Gold",
        "waitUntil": "load",
        "timeout": 45000,
      },
    },
    { "method": "waitForTimeout", "params": { "time": 2500 } },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>{const empty=document.body.innerText.includes(\"couldn't find any results\");const seen=new Set();const products=[...document.querySelectorAll('a[href*=\"/lab-diamond-engagement-rings/\"],a[href*=\"/jewelry/\"],a[href*=\"/diamond/\"]')].map(a=>({name:a.innerText.trim().replace(/\\s+/g,' '),url:a.href})).filter(p=>{if(!p.name||seen.has(p.url))return false;seen.add(p.url);return true;});return JSON.stringify({empty,count:products.length,products});})()",
      },
    },
  ],
}
```

(A `snapshot` also surfaces the links via the a11y tree, but `evaluate` gives cleaner name+href pairs and lets you dedupe by the design-code suffix in one shot.) Each product card on a catalog page corresponds to a link block of the form:

- **Engagement rings:** `[Round Petite Four Prong Solitaire](/lab-diamond-engagement-rings/round-petite-four-prong-solitaire-066)`
- **Fine jewelry / wedding bands / earrings:** `[U Pavé Eternity Band](/jewelry/u-pave-eternity-band-082)`
- **Loose diamonds:** `[1.00ct D VS1 Radiant](https://www.adadiamonds.com/diamond/1-00-carat-d-vs1-radiant-lab-diamond-01t4m000004na0iqae)`

The numeric/alphanumeric suffix on every product URL is the Ada design code (e.g. `066`, `082`, `004EM`); diamonds use a Salesforce-style 18-character ID. Use the suffix to dedupe and to construct stable canonical URLs.

When the URL filter combination yields zero results (e.g. `shapes=Cushion&metals=Rose%20Gold` on engagement rings), the page renders: _"Sorry, we couldn't find any results that match your search criteria. Please try broadening your search or resetting your filters."_ — return `success: true, results: [], reason: "no_matches_for_filters"` rather than retrying.

### 5. (Optional) Free-text search

For text queries that don't map cleanly to shape/metal (e.g. "halo", "trellis", "marquise jacket"), drive the **header Search overlay** in one `browserless_agent` call (keep `proxy`):

```jsonc
"commands": [
  { "method": "goto", "params": { "url": "https://www.adadiamonds.com/", "waitUntil": "load", "timeout": 45000 } },
  { "method": "click", "params": { "selector": "button[aria-label='Search'], header button[aria-label*='earch']" } },
  { "method": "type", "params": { "selector": "input[type='search'], input[placeholder*='earch']", "text": "halo" } },
  { "method": "waitForTimeout", "params": { "time": 1500 } },
  { "method": "evaluate", "params": { "content": "(()=>{const links=[...document.querySelectorAll('a[href*=\"/lab-diamond-engagement-rings/\"],a[href*=\"/jewelry/\"],a[href*=\"/diamond/\"]')].map(a=>({name:a.innerText.trim().replace(/\\s+/g,' '),url:a.href})).filter(p=>p.name);return JSON.stringify({count:links.length,results:links});})()" } }
]
```

The overlay is purely client-side — there's no `?q=` URL surface, so this browser-driven flow is the only way to use it. Confirm the exact `button`/`input` selectors from a `snapshot` if the guesses above miss.

The overlay is purely client-side — there's no `?q=` URL param surface for it. Each suggestion item is a direct link to the product detail page in the same `/lab-diamond-engagement-rings/...`, `/jewelry/...`, or `/diamond/...` shape as catalog cards. 26 results for "halo" was observed in testing.

### 6. (Optional) Drill into a product

A product detail page exposes:

- Title and breadcrumb category (e.g. _Engagement Rings > Solitaires_).
- A "Starting at $X,XXX (Setting Only)" price band — settings are priced separately from the center stone.
- Short description + customization notes ("band widths of 1.8–2.5mm").
- A `Center Stone Shape` and `Metal` selector pair plus a `Choose Your Diamond` CTA that sequences into the diamond picker.
- A `Talk with our diamond concierge` link — this is the same `/inquire` form scoped to that product.
- Ships in 2–3 Weeks · 30-Day Returns · Lifetime Trade-Ins · "Made to Order in NYC".

Loose-diamond detail pages additionally surface **Carat, Color, Clarity, Shape, IGI certification, and price in USD**. Ada only sells D–G color and IF/VVS1/VVS2/VS1/VS2 clarity.

### 7. Surface concierge-contact channels

Do **not** submit the inquiry form. Just return the available channels so the downstream user/agent can choose. All four channels are documented across `/inquire`, `/visit`, and `/diamond-concierge-process`:

| Channel                      | Where                                                                                 | Notes                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inquiry form (`/inquire`)    | Web                                                                                   | Required fields: First name, Last name, Email. `Inquiry Type` dropdown values: **Engagement Ring, Wedding Band, Fashion Jewelry, Loose Diamond, Customer Service**. Two submit CTAs: `Submit Inquiry` and `Book a Call`. Response promised within **one business day**. |
| Phone                        | `(212) 969-8505` (main, footer of `/inquire`) and `212-969-8595` (showroom, `/visit`) | Both numbers are publicly listed — the `8505` number is the default to surface.                                                                                                                                                                                         |
| In-person showroom           | `529 5th Avenue, 15th Floor, New York, NY 10019` (footer) / `10017` (visit page)      | **By appointment only — no walk-ins, no same-day**. Inquire at least 48 hours in advance. Each 45-minute appointment is private.                                                                                                                                        |
| Virtual diamond consultation | "Book Consultation" CTA on `/inquire`, `/visit`, `/diamond-concierge-process`         | Complimentary video call with a Diamond Concierge. The CTA links to the same scheduling/inquiry surface as the form.                                                                                                                                                    |

The concierge process is documented in six steps on `/diamond-concierge-process`: Private Consultation → Hand-Selected Diamonds → Custom Design → Jewelry Production → QC & Media → Happiness Delivered. Useful pricing anchors: engagement-ring center stones require a **$1,000 USD transferable deposit**; custom-design engagement rings start at **$4,000 USD**; custom wedding bands / fashion start at **$2,000 USD**. The concierge service itself is **complimentary** and available worldwide; Ada ships fully insured to 70+ countries.

## Site-Specific Gotchas

- **No JSON / GraphQL API surface for the catalog.** The site is a Next.js client app but does not expose a documented JSON endpoint for product listings. There's no `/api/products` or similar — don't waste cycles probing. Drive the rendered pages with `?shapes=` / `?metals=` URL params instead.
- **Filter param value matching is case- and space-sensitive.** `?shapes=round` does NOT match `?shapes=Round`. `?metals=white+gold` and `?metals=white%20gold` do not match `?metals=White%20Gold`. Use the exact title-case strings.
- **`Carat` slider on `/buy-lab-diamonds` is UI-only.** No `min_carat=` / `max_carat=` URL param was discovered. To carat-filter loose diamonds, you must open `Filter & Sort` and drag the slider — or filter client-side after extracting the list (each card surfaces `Carat X` in its text).
- **Empty filter combinations render a friendly empty state, not a 404.** `shapes=Round,Oval,Cushion&metals=Yellow Gold,Rose Gold` returns _"Sorry, we couldn't find any results…"_ with the active-filters chips still listed. Detect via `Sorry, we couldn't find any results` in the body, not via HTTP status.
- **Setting and stone are priced independently.** Engagement-ring catalog cards show "Setting Only" pricing (e.g. _Starting at $1,250_); the diamond is selected on the loose-diamonds tab and combined later. When the user says "how much is X," return both anchors: setting price + indicative loose-diamond price range from `/buy-lab-diamonds`.
- **Showroom address has two ZIPs in the wild.** The footer site-wide lists `NY 10019`; the `/visit` page body lists `NY 10017`. Building is `529 5th Avenue, 15th Floor` — either ZIP geocodes to the same Midtown Manhattan block.
- **Two showroom phone numbers exist** — `(212) 969-8505` (general / footer) vs. `212-969-8595` (showroom on `/visit`). Surface 8505 by default; only use 8595 if the user is specifically asking about the showroom visit.
- **The Inquiry form is the canonical way to reach the concierge.** Even the "Talk with our diamond concierge" link on every product page funnels back to `/inquire`. Don't promise email, live chat, or SMS — they are not exposed on the site.
- **Do not submit the form.** This skill is read-only. Stop at "form fields enumerated + CTAs identified." Submitting requires a real first/last/email and triggers an outreach commitment from Ada's team.
- **Search overlay has no URL surface.** The header magnifying-glass search renders typeahead results client-side. There is no `?q=…` or `/search?q=…` route — the only way to use it programmatically is the browser-driven flow in step 5.
- **`/diamond` URL has two distinct shapes.** Singular `/diamond/<slug>-<sf-id>` is a loose-diamond detail page; plural `/diamonds` is not a top-level page (the nav uses `/buy-lab-diamonds` for the loose-diamond catalog). Don't construct URLs against `/diamonds/...`.
- **No anti-bot wall observed during testing**, but the host's pre-run probe could not complete cleanly. Keep `proxy: { proxy: "residential" }` on the `browserless_agent` call as a defensive default; a bare session also worked in spot checks, so downgrade only if you confirm a clean path for your egress.

## Expected Output

```json
{
  "success": true,
  "query": {
    "category": "engagement-rings",
    "shapes": ["Round", "Oval"],
    "metals": ["White Gold"],
    "text_query": null
  },
  "catalog_url": "https://www.adadiamonds.com/lab-diamond-engagement-rings-all?shapes=Round,Oval&metals=White%20Gold",
  "results": [
    {
      "name": "Round Petite Four Prong Solitaire",
      "design_code": "066",
      "url": "https://www.adadiamonds.com/lab-diamond-engagement-rings/round-petite-four-prong-solitaire-066",
      "category": "Solitaires",
      "starting_price_usd": 1250,
      "price_basis": "setting_only",
      "shape": "Round",
      "available_metals": [
        "White Gold",
        "Platinum",
        "Yellow Gold",
        "Rose Gold"
      ],
      "description": "Romantic and delicate, this setting features petite prongs and a gallery wire for maximum light exposure. Customize with band widths of 1.8-2.5mm.",
      "lead_time": "2-3 Weeks"
    }
  ],
  "result_count": 28,
  "concierge_contact": {
    "inquiry_form": {
      "url": "https://www.adadiamonds.com/inquire",
      "inquiry_types": [
        "Engagement Ring",
        "Wedding Band",
        "Fashion Jewelry",
        "Loose Diamond",
        "Customer Service"
      ],
      "required_fields": ["first_name", "last_name", "email"],
      "submit_ctas": ["Submit Inquiry", "Book a Call"],
      "response_time": "within one business day"
    },
    "phone": {
      "main": "+1-212-969-8505",
      "showroom": "+1-212-969-8595"
    },
    "showroom": {
      "address": "529 5th Avenue, 15th Floor, New York, NY 10019",
      "appointment_only": true,
      "lead_time": "48 hours advance notice; no same-day or walk-in",
      "duration_minutes": 45,
      "info_url": "https://www.adadiamonds.com/visit"
    },
    "virtual_consultation": {
      "url": "https://www.adadiamonds.com/inquire",
      "cost": "complimentary",
      "process_info_url": "https://www.adadiamonds.com/diamond-concierge-process"
    }
  },
  "pricing_anchors": {
    "engagement_ring_setting_starts_at_usd": 1250,
    "loose_diamond_starts_at_usd": 1075,
    "center_stone_deposit_usd": 1000,
    "custom_engagement_ring_starts_at_usd": 4000,
    "custom_wedding_band_or_fashion_starts_at_usd": 2000,
    "deposit_is_transferable": true
  }
}
```

### Outcome shapes

| Shape                                                          | When                                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success: true, results: [...]`                                | Catalog read succeeded, ≥1 product matched.                                                                                                                                                 |
| `success: true, results: [], reason: "no_matches_for_filters"` | Filter combo legal but no products match (e.g. Cushion + Rose Gold on engagement rings). The page renders _"Sorry, we couldn't find any results…"_.                                         |
| `success: false, reason: "invalid_category"`                   | Caller passed a category that doesn't map to one of the catalog roots in step 2. Don't construct catalog URLs from inference; stick to the table.                                           |
| `success: false, reason: "anti_bot_block"`                     | Page returned CDN block / captcha. Not observed during testing; if encountered, ensure the call has `proxy: { proxy: "residential" }` set (and try `solve` for a captcha), then retry once. |

In every shape, the `concierge_contact` block is populated from the static info above — it does not depend on the catalog read and should always be returned so the user has a path forward regardless of search outcome.
