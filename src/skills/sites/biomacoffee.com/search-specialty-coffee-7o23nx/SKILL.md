---
name: search-specialty-coffee
title: Bioma Coffee Specialty Coffee Search
description: >-
  Enumerate Bioma Coffee Roasters' (Chile) specialty-coffee catalog and filter
  by origin or tasting-note query. Returns title, origin, notes, starting price
  (CLP), available variants, SCA score, rating, and product URL. Read-only.
website: biomacoffee.com
category: ecommerce
tags:
  - coffee
  - specialty-coffee
  - shopify
  - hydrogen
  - chile
  - ecommerce
  - catalog
source: 'browserbase: agent-runtime 2026-05-19'
updated: '2026-05-19'
recommended_method: browser
alternative_methods: []
verified: true
proxies: true
---

# Bioma Coffee — Search Specialty Coffee

## Purpose

Given an origin name (e.g. "Etiopia"), tasting-note keyword (e.g. "chocolate", "floral"), or "all", return every matching specialty-coffee product from Bioma Coffee Roasters' Chilean storefront — title, origin, tasting notes, starting price (CLP), product URL, available variants (weight + grind), SCA score when available, review rating, and a "FAVORITO" badge flag. Read-only — never adds to cart, never proceeds to checkout. The site has no real search bar; the skill enumerates the small catalog (~10 SKUs) and filters client-side.

## When to Use

- "Find a Bioma coffee with chocolate notes" / "what Ethiopian coffees does Bioma sell?" / "cheapest 250gr bag at Bioma right now?"
- Daily price/stock monitoring of the Bioma catalog (it's small enough to enumerate fully on every poll).
- Recommender front-ends that need the structured catalog (origins, notes, SCA scores) in JSON.
- Anywhere a user asks "show me Chilean specialty coffee" — Bioma is one of the canonical local roasters.

## Workflow

`biomacoffee.com` is a **Shopify Hydrogen + Oxygen** storefront (Cloudflare-fronted, Remix-based). The catalog is fully **server-side rendered** into `/tienda` — no JS execution required. The site has **no functional search input** (the header search icon does nothing useful, and `/search?q=anything` HTTP-301-redirects to `/collections/cafe-en-grano-molido`). All legacy Shopify JSON endpoints (`/products.json`, `/products/{handle}.json`, `/products/{handle}.js`) return **404** because Hydrogen-Oxygen does not expose them. So "search" on this site = "fetch the catalog page and filter the JSON-in-HTML client-side."

A single navigation to `/tienda` returns everything needed: titles, handles (URL slugs), tasting notes (uppercase strapline above each card), starting prices in CLP, star ratings, review counts, and a "FAVORITO" badge on the editor's-pick SKU.

### 1. Fetch the catalog page

Two equivalent surfaces — pick by use case:

| Surface                 | URL                                                        | Use when                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full storefront landing | `https://biomacoffee.com/tienda`                           | Default. Shows all 10 SKUs (cafés + packs + special editions). Has filter tabs in the UI but they're decorative — see Gotchas.                                                                                                             |
| Coffee-only collection  | `https://biomacoffee.com/collections/cafe-en-grano-molido` | Slightly cleaner. Same 9–10 products today (packs are still included), but if Bioma ever ships non-coffee SKUs (vasos, accessories), this collection scopes them out. Has a "Load more ↓" pagination link at the bottom of the first page. |

Cloudflare is permissive (no JS challenge on these paths). A plain `browserless_agent` call (no proxy arg) works fine. Add a top-level `proxy: { proxy: "residential" }` only if you start seeing 1015 or 1020 rate-limit responses from a hot IP — there's no evidence of WAF challenges on Bioma today.

### 2. Extract the catalog

The recommended path is a single `browserless_agent` `{ "method": "goto", ... }` to `/tienda` followed by `{ "method": "snapshot" }` — the accessibility tree exposes every product card structurally. Each card emits the same 7-line shape:

```
[card link]: <full alt-text of product image>
  [optional FAVORITO badge]
  StaticText: <TASTING NOTES UPPERCASE • BULLET-SEPARATED>
  link → heading: <product title>
  image: Calificación: <stars> de 5 estrellas
  span: ( <review count> )
  StaticText: $<starting price in CLP, dot-thousands>
  button: Agregar … al carrito
  link: Ver detalles …
```

The link `href` is in the snapshot's `urlMap` and follows `/products/{handle}` (e.g. `/products/cafe-de-especialidad-etiopia-limu`). Some products have shorthand handles (`/products/cafe-brasil-isidro-pereira-minas-gerais`, `/products/cafe-costa-rica-colibri-tarrazu`) — don't assume `cafe-de-especialidad-{country}` as a slug template.

Alternative: a `browserless_agent` `goto https://biomacoffee.com/tienda` + `{ "method": "html", "params": { "selector": "body" } }` (or an `evaluate` that parses in-page) returns the same HTML (~114 KB). The product list is embedded as a Remix `__remixContext.state.loaderData[...]` JSON blob — pull it in-page with an `evaluate` command (`document.documentElement.innerHTML` → locate `__remixContext`, or read the inline `<script>` that assigns it) and return a compact projection. You can also regex-mine the response: each product card's JSON fragment contains `"handle":"…","title":"…"` and `"priceRange":{"minVariantPrice":{"amount":"<CLP>"}}`. Faster for batch polling (parse-in-page, no a11y tree) but more brittle on the HTML escaping than the snapshot path — pick this only for high-volume cron jobs.

### 3. Client-side filter

The query is matched case-insensitively against:

- the product title (substring),
- the tasting-notes strapline (the UPPERCASE • BULLET text above each card),
- common origin synonyms in English/Spanish — `etiopia`/`ethiopia`, `brasil`/`brazil`, `colombia`, `etc.` Build a small alias map if you support English input; the storefront is Spanish-first.

If the query is `"all"`, return every card. If the user asks for "beans only", drop products whose title starts with `Pack ` or whose tasting-note strapline reads `VARIEDAD DE ORÍGENES`/`NOTAS ÚNICAS` (packs + the personalized edition).

### 4. (Optional) Resolve variant pricing

When the user wants weight + grind options (e.g. "500gr ground for espresso"), navigate to the product detail page `/products/{handle}`. The variant URL pattern is:

```
/products/{handle}?Tama%C3%B1o={size}&Molido+o+Grano={grind}
```

- **Size** (`Tamaño`): `250gr`, `500gr`, `1kg` (1kg only on some SKUs)
- **Grind** (`Molido o Grano`): `Grano`, `Molido+Francesa`, `Molido+Drip+%28Americana%29`, `Molido+Italiana`, `Molido+Espresso`, `Molido+Turca`

The product detail page also exposes structured metadata: SCA score (`84 SCA` for Etiopía Limu, `Puntaje SCA 83+` for the storefront-wide claim), region (`Región de Limu - Oromia, Etiopía`), altitude (`1.500 – 1.800 m s.n.m.`), process (`Lavado completo`), drying (`Camas elevadas`), and tueste (roast level). Extract these from the "Detalles del café" table on the product page when present.

### 5. Return JSON, stop

Do **not** click "Agregar al carrito", do **not** open `/cart`, do **not** start checkout. Read-only.

### Browser fallback (when the plain call is being rate-limited)

If the plain in-page fetch/parse starts returning 1020 / Cloudflare-blocked responses (haven't observed it during normal use), add a top-level `proxy: { proxy: "residential" }` to the `browserless_agent` call and `goto https://biomacoffee.com/tienda`. The page is SSR — a `{ "method": "snapshot" }` immediately after the `goto` returns the full catalog with no waiting on JS hydration.

## Site-Specific Gotchas

- **No search input. `/search?q=` is a 301 redirect** to `/collections/cafe-en-grano-molido` for any query string. The site simply doesn't expose a search surface — the header magnifying-glass icon opens a modal that posts nowhere useful. Do not waste turns trying to "type into the search box."
- **The filter tabs on `/tienda` (`Cafés` / `Vasos` / `Packs café` / `Todos`) are non-functional client-side.** Clicking them does not change the URL, the visible product count (stays at "10 productos"), or the rendered cards. Treat them as decorative. Filter by parsing the catalog in your own code.
- **Shopify JSON endpoints all return 404.** Confirmed-dead: `/products.json`, `/products/{handle}.json`, `/products/{handle}.js`, `/collections/{handle}/products.json`. Bioma runs on Hydrogen + Oxygen and the legacy Shopify JSON routes are not implemented. Do not retry these.
- **Prices are in Chilean pesos (CLP)** rendered as `$9.990` (dot is the thousands separator, comma — if any — would be decimal; CLP has no minor units). Strip the `$` and dots before parsing as integer. Do NOT confuse with USD; a 250gr bag is ~~10,000 CLP (~~$10–12 USD at typical exchange rates).
- **Title-vs-tasting-notes-vs-strapline are three different fields.** The card shows: an UPPERCASE • BULLET line (the strapline, e.g. `CHOCOLATE • CARAMELO`), a long title (`Café de Especialidad Brasil - Chocolate y caramelo`), and on the detail page, a third "Perfil de sabor" bullet list (`cítricos, florales, té negro`). The strapline is the marketing-card teaser; the detail-page perfil is the canonical tasting-note list. Use the strapline for list views and the perfil for the per-product expansion.
- **Variant URL params use URL-encoded Spanish keys with `+` and `%28`/`%29` literal-percent encoding.** `Tama%C3%B1o` (`Tamaño`) and `Molido+o+Grano`. Don't normalize them to lowercase or ASCII — Hydrogen's option-resolver is strict and a wrong-case query yields the default variant silently.
- **The `Café Personalizado` SKU has a $33.000 listing price but is special-order / custom-roasted.** Treat it as not-a-stocking-SKU in availability summaries — the price isn't comparable to the regular 250gr bags ($9,990–$12,990).
- **One SKU has a `"-copia"` suffix in its handle (`pack-cafes-de-especialidad-3-cafes-de-250gr-copia`)** — looks like a duplicated-from-template draft that escaped to production. The product is real and orderable but the canonical handle is the ugly one.
- **The "FAVORITO" / "Producto favorito" badge** is editor-curated, not popularity-derived. It currently sits on the Brasil SKU. Carry it through your output as a boolean flag (`is_editor_pick`) so downstream UIs can render the badge.
- **Confirmed dead-end exploration paths** (so the next agent doesn't re-discover them): `/admin/api/*` (404 on the public origin — Hydrogen doesn't proxy it), `/api/2024-*/products.json` (404), `/cdn-cgi/*` (Cloudflare internals, irrelevant), `/sitemap.xml` (Hydrogen serves a sitemap but it's stale — has 11 product URLs only, missing 1kg variant URLs). The SSR'd `/tienda` is the canonical surface.
- **No anti-bot stealth required.** Across this iteration's plain `browserless_agent` calls (no proxy) and residential-proxy calls, every request returned 200 OK. Cloudflare is in low-friction mode (stealth is always on regardless). The `metadata.proxies: true` flag below records what the _converged_ session used; plain no-proxy calls also worked.

## Expected Output

```json
{
  "success": true,
  "query": "etiopia",
  "currency": "CLP",
  "result_count": 1,
  "results": [
    {
      "handle": "cafe-de-especialidad-etiopia-limu",
      "url": "https://biomacoffee.com/products/cafe-de-especialidad-etiopia-limu",
      "title": "Café de Especialidad Etiopía - Floral, cítrico y te negro",
      "origin_country": "Etiopía",
      "origin_region": "Limu, Oromia",
      "tasting_notes_strapline": "FLORAL • CÍTRICO",
      "tasting_notes_full": ["cítricos", "florales", "té negro"],
      "price_from_clp": 11990,
      "price_to_clp": 32990,
      "starting_variant": {
        "weight": "250gr",
        "grind": "Grano",
        "price_clp": 11990
      },
      "available_weights": ["250gr", "500gr", "1kg"],
      "available_grinds": [
        "Grano",
        "Molido Francesa",
        "Molido Drip (Americana)",
        "Molido Italiana",
        "Molido Espresso",
        "Molido Turca"
      ],
      "sca_score": 84,
      "process": "Lavado completo (fully washed)",
      "altitude_masl": [1500, 1800],
      "rating": 5.0,
      "review_count": 3,
      "is_editor_pick": false,
      "is_pack": false,
      "in_stock": true
    }
  ],
  "error_reasoning": null
}
```

### Outcome: query matches multiple SKUs (e.g. `"chocolate"`)

```json
{
  "success": true,
  "query": "chocolate",
  "currency": "CLP",
  "result_count": 3,
  "results": [
    {
      "handle": "cafe-brasil-isidro-pereira-minas-gerais",
      "title": "Café de Especialidad Brasil - Chocolate y caramelo",
      "origin_country": "Brasil",
      "tasting_notes_strapline": "CHOCOLATE • CARAMELO",
      "price_from_clp": 9990,
      "is_editor_pick": true,
      "is_pack": false,
      "in_stock": true,
      "url": "https://biomacoffee.com/products/cafe-brasil-isidro-pereira-minas-gerais"
    },
    {
      "handle": "cafe-costa-rica-colibri-tarrazu",
      "title": "Café de Especialidad Costa Rica - Cereza y chocolate",
      "origin_country": "Costa Rica",
      "tasting_notes_strapline": "CEREZA • CHOCOLATE",
      "price_from_clp": 10990,
      "is_editor_pick": false,
      "is_pack": false,
      "in_stock": true,
      "url": "https://biomacoffee.com/products/cafe-costa-rica-colibri-tarrazu"
    },
    {
      "handle": "cafe-de-especialidad-colombia-caldas",
      "title": "Café de Especialidad Colombia - chocolate dulce, caramelo y frutos secos",
      "origin_country": "Colombia",
      "tasting_notes_strapline": "CARAMELO • FRUTOS SECOS",
      "price_from_clp": 9990,
      "is_editor_pick": false,
      "is_pack": false,
      "in_stock": true,
      "url": "https://biomacoffee.com/products/cafe-de-especialidad-colombia-caldas"
    }
  ],
  "error_reasoning": null
}
```

### Outcome: query matches nothing

```json
{
  "success": true,
  "query": "kenya",
  "currency": "CLP",
  "result_count": 0,
  "results": [],
  "error_reasoning": null
}
```

Note: Bioma does not currently stock Kenya, Yemen, Indonesia, Vietnam, or Tanzania origins. Today's catalog is Brasil, Costa Rica, Guatemala, Colombia, Etiopía, Rwanda, plus packs and a personalized edition. If a query for a non-stocked origin should fall back to a recommendation instead of an empty list, that's a presentation-layer decision on top of this skill's raw output.

### Outcome: query is `"all"` — full catalog

```json
{
  "success": true,
  "query": "all",
  "currency": "CLP",
  "result_count": 10,
  "results": [
    /* all 10 cards: 6 single-origin coffees + 2 multi-pack bundles + 1 cafetera-pack + 1 personalized edition */
  ],
  "error_reasoning": null
}
```

### Outcome: page fetch failed / Cloudflare blocked

```json
{
  "success": false,
  "query": "etiopia",
  "results": [],
  "error_reasoning": "biomacoffee.com/tienda returned HTTP 1020 (Cloudflare WAF block) on 3 retries; add a residential proxy to the browserless_agent call per workflow step Browser fallback."
}
```
