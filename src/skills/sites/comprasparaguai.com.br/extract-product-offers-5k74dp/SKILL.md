---
name: extract-product-offers
title: Compras Paraguai Offer Extraction
description: >-
  Extract structured product offers from comprasparaguai.com.br: per-store price
  (USD+BRL), Código (store ref), external store URL, WhatsApp deep-link, variant
  URL, model URL, and follow-through validation against the source store for the
  cheapest 3-5 offers. Returns aggregated vs validated lowest prices, rejected
  offers with reasons, history series, and gaps.
website: comprasparaguai.com.br
category: marketplace
tags:
  - paraguay
  - marketplace
  - price-aggregator
  - offers
  - teciq
  - read-only
source: 'browserbase: agent-runtime 2026-05-19'
updated: '2026-05-19'
recommended_method: hybrid
alternative_methods:
  - method: browser
    rationale: >-
      Fallback when the plain residential-proxy navigation is blocked. Adding
      stealth + a Cloudflare solve clears the Turnstile interstitial but is
      ~100x more expensive per request; only use when the plain navigation is
      unreachable.
  - method: api
    rationale: >-
      No public/internal JSON API was discovered for offer extraction. The HTML
      pages embed all the structured data we need (offer cards, gtag advertiser
      names, embedded history canvas). Don't waste time scanning for /api or
      /graphql endpoints — confirmed absent on the rendered pages.
verified: true
proxies: true
---

# Compras Paraguai — Extract Product Offers (TecIQ)

## Purpose

Given a product term (e.g. `Redmi Buds 6 Play`), return a fully traceable, structured list of price offers from `comprasparaguai.com.br` — the Paraguay cross-border-shopping price aggregator. For each offer the skill emits: store name, exact aggregator title, USD/BRL price, store-side product code (`Código`), the external store URL, the WhatsApp deep-link, the offer's position in the aggregator listing, and a follow-through flag (the lowest 3–5 offers are re-fetched at the source store to confirm `200 OK + product term in title + not “Indisponível”`). Aggregator-only fields are clearly separated from store-validated fields so the caller can compute both the **lowest aggregated price** (what Compras Paraguai _advertises_) and the **lowest validated price** (what the store actually still sells). **Read-only — never WhatsApps, never opens a checkout, never submits a form.**

## When to Use

- Building a `pesquisar-produto` evidence bundle for any consumer-electronics-class item sold in the Ciudad del Este / Salto del Guaira / Pedro Juan Caballero retail corridor.
- Cross-region price intelligence where the BR-side wants the PY-side wholesale floor for Xiaomi/JBL/Samsung/Apple peripherals, perfumes, tablets, cameras, drones, audio gear, etc.
- Any pipeline that must distinguish between an aggregator's advertised "A partir de" headline and a live, in-stock store price — the two regularly disagree on this site.
- Anywhere you'd otherwise glob raw text from offer cards: this skill replaces noisy text with positional offer objects plus per-offer store follow-through.

## Workflow

The aggregator pages are server-rendered HTML behind a Cloudflare Turnstile interactive challenge. However **a `browserless_agent` `goto` on a residential proxy (`proxy: { proxy: "residential" }`) returns the fully-rendered HTML directly with 200 OK** (verified across `/`, `/busca/`, model and variant pages — Cloudflare's cookie-less path is permitted with a residential proxy on the egress side). Lead with a residential-proxy navigation for all aggregator HTTP and parse the HTML in-page (an `evaluate`, or an `html`/`text` command over the offer cards); the escalated browser path is a fallback used only when the plain navigation is blocked or when you need to confirm a JS-rendered widget. **Always route through Browserless with the residential proxy — no direct `fetch()`/`curl` to the site.** Repeat the `proxy` arg on every call (the session persists across calls, keyed by `proxy`/`profile`, so a call that drops or changes the proxy lands in a different session).

### 1. Issue the search

```
GET https://www.comprasparaguai.com.br/busca/?q=<URL-enc term>&page=<N>
        [&ordem=relevancia|menor-preco|maior-preco|produto-asc|produto-desc|novos]
```

- 20 result cards per page. Total result count appears as `(N Resultados)` in the H1 area.
- Pagination uses `&page=N` (1-indexed). `?p=` is _not_ the param.
- Default depth: **page 1 and page 2** only. Stop earlier when (a) page returns < 1 new model URL, (b) the result count fits on page 1 (`total ≤ cards.length`), or (c) the page returns a non-200 status. Record the stopping reason in `gaps[]`.
- Each result card sits inside `<div class="row resultados-busca"> … <div class="promocao-produtos-item col-sm-12">`. Extract:
  - **Model URL**: first `href="/<slug>_<numericId>/"` inside the card — note the **single underscore + numeric ID** (e.g. `_55496`) marks a _model aggregator_ page.
  - **Card title**: from the `title="…"` attribute of the inner image (the visible card text is also there but the image title is the cleanest).

### 2. False-positive filter (search-card level)

Before fetching the model page, reject any card whose title does **not** contain the required phrase as a contiguous substring (after lowercase + diacritic-strip + non-alnum→space normalisation). For `Redmi Buds 6 Play`:

| Card title example                                  | Decision  | Reason                                           |
| --------------------------------------------------- | --------- | ------------------------------------------------ |
| `Fone de Ouvido Xiaomi Redmi Buds 6 Play Bluetooth` | ✅ accept | contains phrase                                  |
| `Auricular Xiaomi Redmi Buds 6 Play M2420E1 Negro`  | ✅ accept | Spanish variant title, phrase intact             |
| `Fone Xiaomi Redmi Buds 6 Active Bluetooth`         | ❌ reject | "Buds 6 Active" — different SKU line             |
| `Fone Xiaomi Redmi Buds 6 Pro Bluetooth`            | ❌ reject | "Buds 6 Pro" — different SKU line                |
| `Fone Xiaomi Haylou Mori Plus Bluetooth`            | ❌ reject | unrelated model returned by partial-token search |
| `Fone Xiaomi Redmi Buds 8 Lite`                     | ❌ reject | "Buds 8 Lite"                                    |
| `Fone Redmi Buds 6 BHR…` (no "Play")                | ❌ reject | "Buds 6" without "Play"                          |

For each rejection, append `{stage: "search_card", url, candidate_title, reason}` to the run's `rejected[]` array — never silently drop.

### 3. Fetch the model aggregator with the menor-preco sort applied

```
GET https://www.comprasparaguai.com.br/<slug>_<id>/?ordem=menor-preco
```

`?ordem=menor-preco` sorts the offer list ascending by **USD** price. Without it the default order is **grouped by store** (not by price), so the first offer card is _not_ the lowest one. The `ordem` param is the same enum as the search-page sort. Re-fetching with this param costs a single extra HTTP call and is **how the skill maps "A partir de" → cheapest offer**.

The aggregator page contains:

- **`<h1>` Model title** — defense-in-depth: confirm the phrase is still present (the search-card title can be edited independently of the H1; check both).
- **Header strip** "A partir de: US$ X,XX  Até  US$ Y,YY" and "R$ Z,ZZ" → `starting_at_usd_min`, `starting_at_usd_max`, `starting_at_brl_min`. The min equals the lowest offer's USD when the page is sorted by `menor-preco`.
- **History canvas** `<canvas id="grafico-modelo" data-historico="[{'y': 7.0, 'x': '04/2026'}, …]">` — monthly USD lows for the last 12–24 months. Parse by replacing single quotes with double quotes before `JSON.parse`. The history may show prices _lower_ than the current `starting_at` (e.g. `5.00` in `11/2025` vs current `7.00`) — treat history as informational, **never** as a quotable current price.
- **Offer cards** — each `<div class="promocao-produtos-item-box">` wraps one (store × variant) offer.

### 4. Parse each offer card

Within each `promocao-produtos-item-box` chunk extract:

| Field                                     | Source pattern                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `variant_url`                             | first `href="/<slug>__<id>/"` — **double underscore + numeric ID** marks a _variant_ page (single store × single SKU)                                                                                                                                                                                                          |
| `variant_id`                              | trailing numeric in `__<id>/`                                                                                                                                                                                                                                                                                                  |
| `variant_title`                           | text inside that variant anchor (e.g. `Fone de Ouvido Xiaomi Mi Redmi Buds 6 Play M2420E1 Bluetooth - Rosa`)                                                                                                                                                                                                                   |
| `store_product_code` (aka `Ref`/`Código`) | `Código:\s*([\w.-]+)` — the store's own SKU                                                                                                                                                                                                                                                                                    |
| `external_url`                            | `<a class="btn btn-blue btn-store-redirect" href="…">` — the outbound store deep-link                                                                                                                                                                                                                                          |
| `store_name`                              | gtag inline event payload `'advertiser': '<store name>'` — e.g. `Atacado Connect`, `Shopping China`, `Nissei`, `Mega Eletrônicos`, `Cellshop`, `New Zone`, `Visãovip`, `Best Shop Paraguai`, `Topdek Informática`, `TecnoTienda`. (Image `alt` and the `/lojas/<slug>/` link further down the card are corroborating sources.) |
| `whatsapp_phone`                          | `api.whatsapp.com/send?phone=(\d+)` — store contact line (do NOT message)                                                                                                                                                                                                                                                      |
| `price_usd`, `price_brl`                  | the `US$ x,xx` and `R$ y,yy` strings inside `class="promocao-item-preco-oferta"`                                                                                                                                                                                                                                               |
| `order`                                   | 1-based index in the (sorted) listing as you encountered it                                                                                                                                                                                                                                                                    |

The aggregator emits the `btn-store-redirect` anchor **twice per card** (once in the inline button cluster, once in the expansive footer); deduplicate by `(variant_url, store_product_code)`.

### 5. False-positive filter (variant level)

Apply the same phrase-match check to `variant_title`. Examples from a real run for `Redmi Buds 6 Play`:

- ✅ `Fone de Ouvido Xiaomi Redmi Buds 6 Play M2420E1 Wireless - Azul`
- ✅ `Auricular Inalámbrico Redmi Buds 6 Play M2420E1 Rosa`
- ❌ `Auri Xiaomi Buds 6 Play BHR8776GL White` — dropped "Redmi"; aggregator linked it to this model but the user-facing title omits the brand, treat as rejected to be safe. Caller can soften the rule by switching to `matchesAny(["Redmi Buds 6 Play", "Buds 6 Play"])` if it wants brand-less variants in.

Record each variant rejection in `rejected[]` with `stage: "variant_offer"`.

### 6. Follow-through to the source store (lowest 3–5 offers only)

For the 3–5 cheapest _kept_ offers, re-fetch `external_url` through the same residential-proxy `browserless_agent` navigation and emit:

```json
{
  "url": "https://atacadoconnect.com/produto/.../1146400",
  "status": 200,
  "final_title": "Fone de Ouvido Xiaomi Redmi Buds 6 Play M2420E1 Wireless - Azul",
  "product_term_in_title": true,
  "appears_indisponivel": true,
  "confirmed": false
}
```

- `confirmed` is `true` only when `status == 200 AND product_term_in_title AND !appears_indisponivel`.
- `appears_indisponivel` is a substring match against the body for any of `Indisponível`, `Indisponible`, `Sin stock`, `Esgotado`, `Out of stock`, `Sold out`, `Error 404`.
- `lowest_validated` is the cheapest offer for which `confirmed == true`. **If no follow-through confirms, set `lowest_validated: null` and emit a `gaps[]` entry like `"aggregate_lowest_unverified"`.** Do _not_ propagate the aggregator's `starting_at` as a usable price in that case — pass it through as an _advertised_ number only.
- Stop at the listing/info page in the store. **Never** click "Comprar", "Adicionar ao carrinho", or any checkout/submit. Never message the WhatsApp deep-link.
- Some stores (e.g. `nissei.com`) gate their detail pages behind Cloudflare too; a 403 + `Just a moment...` title is a follow-through _gap_, not a rejection. Record it; do not retry hard.

### 7. Emit the structured envelope

See **Expected Output** for the full shape. Always include `provider`, `started_at`, `finished_at`, the full `visited[]` log (search pages, model pages, follow-through URLs with their statuses), the `rejected[]` with reasons, and the `gaps[]` of every blocked / unverified step. The output is what `pesquisar-produto` will consume.

### Browser fallback (when the plain residential-proxy navigation fails)

If a residential-proxy `goto` ever returns a non-200 or the "Just a moment…" interstitial on `/busca/` or a model URL — verified working as of 2026-05-19 but not contractually guaranteed — escalate the same `browserless_agent` call by adding an explicit Cloudflare solve. Keep the whole flow in one `commands` array so the Turnstile cookie persists across the navigation:

```json
{
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.comprasparaguai.com.br/busca/?q=<term>",
        "waitUntil": "load",
        "timeout": 60000
      }
    },
    { "method": "solve", "params": { "type": "cloudflare" } },
    { "method": "html", "params": { "selector": "body" } }
  ]
}
```

The Cloudflare Turnstile interstitial may persist for 8–20 s on first hit; the `solve` command clears it, and later commands in the same call reuse the cookie and load directly. Re-use the same regexes over the returned HTML. Costs ~100× the plain navigation (full Turnstile solve) — only use when the plain path is blocked.

## Site-Specific Gotchas

- **A residential-proxy `goto` is the cheap, working path; forcing the interactive challenge is expensive.** The aggregator is Cloudflare-fronted. A plain `browserless_agent` navigation on a residential proxy returns 200 with the same HTML the browser eventually shows after Turnstile clears — no explicit solve needed. Escalating to a Cloudflare `solve` costs a ~8–20 s challenge on first hit. Always prefer the plain navigation.
- **The aggregator's "A partir de" is NOT always backed by a live offer.** Verified live: for `Redmi Buds 6 Play` the headline `US$ 7,00 / R$ 36,05` came from Shopping China product `1047514`, whose store URL returned **404 Error 404 | Shopping China**. The next-cheapest "US$ 9,50" tier was 200 OK at Atacado Connect — but the page body showed **Indisponível**. Out of the three cheapest aggregated offers, **zero** were confirmable as live & in-stock at the store. Always follow-through; do not propagate `starting_at` as a quotable price without `lowest_validated` agreement.
- **Default offer order is grouped by store, not by price.** On a bare model URL the first offer card is whichever store the aggregator's editorial order puts first (Atacado Connect at the time of writing), NOT the cheapest. To map the headline to the cheapest offer, add `?ordem=menor-preco` to the model URL. Without that param `offers[0].price_usd` will overstate the floor by 30–50 %.
- **Single underscore vs. double underscore is a hard URL-pattern distinction.**
  - `/<slug>_<id>/` (single `_`) → **model aggregator** page (multi-store, multi-variant).
  - `/<slug>__<id>/` (double `__`) → **variant** page (one store, one SKU, with a "Veja todas as N ofertas" link back to the aggregator).
  - The aggregator references variants exclusively by the double-underscore URL; this is also where `variant_id` lives. Don't conflate them — confusing the two will produce wrong `external_url` joins.
- **63 "variants" for one model is normal.** One Redmi Buds 6 Play returned 61–63 offers spanning ~17 distinct stores × 4 colors × 3 SKU suffixes (`M2420E1`, `BHR8776GL`, `BHR8775GL`, `BHR9283GL`, `BHR8773GL`). Each combination is its own variant URL with its own `Código`. Do not assume one offer per store.
- **Currency**: the aggregator uses **USD** as the canonical price (Paraguay retail commonly quotes USD); BRL is shown as a converted display. The history canvas is also in **USD**. Always store both; never assume the BRL is a fixed multiplier of the USD — it tracks daily FX and the displayed BRL is the aggregator's quote, not a live rate.
- **Search returns padded carousels.** A search-results HTML page contains the result list **plus** the global homepage promotional carousel ("PRODUTOS RELACIONADOS", featured drones, etc.). Restrict the result extraction to the `<div class="row resultados-busca">` section — using a top-level regex over the whole page will pollute results with unrelated featured items (iPhones, Nintendo Switch, perfumes…).
- **Pagination param is `page=`, not `p=` or `pagina=`.** `?page=2`, `?page=3`, … Each page yields 20 cards; the link list shows the highest page number explicitly.
- **The H1 result counter shows the canonical total**: `<h1 class="content-title">…</h1> <span class="content-span">(N Resultados)</span>`. Use it for the loop stop test; if `N <= cards.length` you've already seen everything — don't fetch page 2.
- **Card duplication on a model page**: each store-redirect anchor is emitted twice per offer (button row + footer row). Deduplicate by `(variant_url, store_product_code)`.
- **Store name is reliably in the inline gtag payload** `'advertiser': 'Atacado Connect'`. Other corroborating sources are the image `alt`, the `/lojas/<slug>/` profile URL ("Shopping China" → `/lojas/shopping-china/`), and the store's external URL host. They all agree when present.
- **WhatsApp link is read-only signal — do NOT message.** `api.whatsapp.com/send?phone=…&text=Olá%21+Venho+através+do+Compras+Paraguai…+Ref%3A+<store_product_code>` is a contact-intent deep-link. Extract `phone` and decoded `Ref` (== `store_product_code`); never open it.
- **External-store follow-through is rate-limited downstream by the _destination_ store's WAF, not by Compras Paraguai.** Nissei (Cloudflare), Cellshop, Mega Eletrônicos may 403/challenge the proxied fetch. Treat as `confirmed: null` (unverifiable) and log into `gaps[]`. Do not retry aggressively.
- **History data is embedded JSON-ish with single quotes.** `<canvas data-historico="[{'y': 7.0, 'x': '04/2026'}, ...]">` — must replace `'` → `"` before `JSON.parse`. Latest data point is one of the last bars in the chart; the array order is chronological ascending.
- **Search ordering is also `ordem=…`** with the same enum as the model page (`menor-preco`, `maior-preco`, `relevancia`, `produto-asc`, `produto-desc`, `novos`). On a search results page the sort applies to model cards (by their starting-at USD), not to offer rows.
- **The variant page's `/lojas/<store>/` rating data is incidental**, not part of the offer; ignore for extraction.
- **Specification-only pages don't exist as a separate route.** The `#detalhes` anchor on a model URL holds spec text, but it's the same page as the aggregator. There is no `/spec/<id>/` route — if a model has no current offers (`Sem ofertas no momento`), you'll see only the H1 + spec block + history canvas + zero `promocao-produtos-item-box` cards. Emit the model with `offers: []` and add `"model_listed_but_no_active_offers"` to gaps.
- **Site language is `pt-BR`** but variant titles mix Portuguese (`Fone de Ouvido`), Spanish (`Auricular`), and English (`Wireless`, `Pink`) — the false-positive filter MUST normalise diacritics and be insensitive to language. The phrase `Redmi Buds 6 Play` is English/brand and is preserved across all observed languages.
- **Read-only invariants**: never click "Comprar agora" buttons (they exist on some variant pages and redirect to the store cart), never submit `Informar preço incorreto` forms, never call WhatsApp deep-links. The skill must remain side-effect-free.

## Expected Output

```json
{
  "schema": "comprasparaguai.com.br/extract-product-offers/v1",
  "provider": "browserless-agent+residential-proxy",
  "term": "Redmi Buds 6 Play",
  "started_at": "2026-05-19T17:34:11.882Z",
  "finished_at": "2026-05-19T17:34:38.501Z",

  "visited": [
    {
      "kind": "search",
      "page": 1,
      "url": "https://www.comprasparaguai.com.br/busca/?q=Redmi%20Buds%206%20Play&page=1",
      "status": 200
    },
    {
      "kind": "model_aggregator",
      "url": "https://www.comprasparaguai.com.br/fone-de-ouvido-xiaomi-redmi-buds-6-play-bluetooth_55496/?ordem=menor-preco",
      "status": 200
    },
    {
      "kind": "store_followthrough",
      "url": "https://www.shoppingchina.com.py/producto/1047514"
    }
  ],

  "models": [
    {
      "model_url": "https://www.comprasparaguai.com.br/fone-de-ouvido-xiaomi-redmi-buds-6-play-bluetooth_55496/",
      "model_title": "Fone de Ouvido Xiaomi Redmi Buds 6 Play Bluetooth",

      "starting_at_usd_min": "US$ 7,00",
      "starting_at_usd_max": "US$ 16,00",
      "starting_at_brl_min": "R$ 36,05",

      "history": [
        { "y": 7.0, "x": "04/2026" },
        { "y": 7.0, "x": "05/2026" }
      ],

      "offers": [
        {
          "order": 1,
          "variant_url": "https://www.comprasparaguai.com.br/auricular-inalambrico-redmi-buds-6-play-m2420e1-rosa__5239439/",
          "variant_id": "5239439",
          "variant_title": "Auricular Inalámbrico Redmi Buds 6 Play M2420E1 Rosa",
          "store_name": "Shopping China",
          "store_product_code": "1047514",
          "external_url": "https://www.shoppingchina.com.py/producto/1047514",
          "whatsapp_phone": "595981920902",
          "price_usd": "7,00",
          "price_brl": "36,05"
        }
      ],

      "followthrough": [
        {
          "offer_order": 1,
          "store_name": "Shopping China",
          "price_usd": "7,00",
          "url": "https://www.shoppingchina.com.py/producto/1047514",
          "status": 404,
          "final_title": "Error 404 | Shopping China",
          "product_term_in_title": false,
          "appears_indisponivel": true,
          "confirmed": false
        }
      ],

      "lowest_aggregate": {
        "price_usd": "7,00",
        "price_brl": "36,05",
        "store_name": "Shopping China",
        "external_url": "https://www.shoppingchina.com.py/producto/1047514"
      },

      "lowest_validated": null
    }
  ],

  "rejected": [
    {
      "stage": "search_card",
      "url": "https://www.comprasparaguai.com.br/fone-de-ouvido-xiaomi-redmi-buds-6-active-bluetooth_54591/",
      "candidate_title": "Fone de Ouvido Xiaomi Redmi Buds 6 Active Bluetooth",
      "reason": "title does not contain phrase \"Redmi Buds 6 Play\""
    },
    {
      "stage": "variant_offer",
      "url": "https://www.comprasparaguai.com.br/auri-xiaomi-buds-6-play-bhr8776gl-white__5224949/",
      "candidate_title": "Auri Xiaomi Buds 6 Play BHR8776GL White",
      "reason": "variant title does not contain \"Redmi Buds 6 Play\""
    }
  ],

  "gaps": [
    "aggregate_lowest_unverified: top-3 followthrough all returned 404 or Indisponível"
  ],

  "stopping": {
    "pages_planned": 2,
    "pages_visited": 1,
    "models_evaluated": 1,
    "models_with_offers": 1,
    "followthrough_per_model": 3,
    "reason": "page-1 result count (1) ≤ cards seen; no page-2 needed"
  }
}
```

### Page-type classifier (for the caller, when given an arbitrary `comprasparaguai.com.br` URL)

| URL pattern                                  | `page_type`                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/busca/?q=...`                              | `search`                                                                               |
| `/<slug>_<id>/` (single `_`)                 | `model_aggregator` (real-offer page if `offers.length > 0`, else `specification_only`) |
| `/<slug>__<id>/` (double `__`)               | `variant` (single store × single SKU)                                                  |
| `/lojas/<store-slug>/`                       | `store_profile` (not used by this skill)                                               |
| `/cidades/<city>/`                           | `city_landing` (not used by this skill)                                                |
| Anywhere with the inline `#historico` anchor | `historical_block` (sub-section of model_aggregator; not a standalone route)           |

### Test fixture — `Redmi Buds 6 Play` (live run 2026-05-19)

```
node extract_offers.mjs "Redmi Buds 6 Play" --max-pages 2 --follow 3
```

Observed run (raw output in `test_redmi_buds_6_play.json`):

- pages_visited: 1 (page-1 returned `(1 Resultado)` — page-2 skipped)
- models found: 1 (`/fone-de-ouvido-xiaomi-redmi-buds-6-play-bluetooth_55496/`)
- offers kept: **61** (out of 62 raw cards; one rejected: `Auri Xiaomi Buds 6 Play BHR8776GL White`)
- starting_at: `US$ 7,00 .. US$ 16,00` / `R$ 36,05`
- lowest_aggregate: Shopping China @ US$ 7,00 (`producto/1047514`)
- followthrough (3 cheapest):
  - Shopping China US$ 7,00 → **404 Error 404** → unconfirmed
  - Atacado Connect US$ 9,50 → 200 OK, title matches, but `Indisponível` → unconfirmed
  - Atacado Connect US$ 9,50 → 200 OK, title matches, but `Indisponível` → unconfirmed
- lowest_validated: **null** → emit `gaps: ["aggregate_lowest_unverified"]`
- rejected: 1 (variant title without `Redmi`)

This is the canonical regression case: it stresses the search-card filter, the menor-preco re-sort, the offer-card parser, and — critically — proves that the aggregator's headline price is NOT a trustworthy quote without per-store follow-through. The `lowest_validated: null` outcome must propagate into `pesquisar-produto` as an explicit unverified-floor signal, not as a real US$ 7,00 quote.
