# When Snapshot Misses Content

Snapshot at element limit (truncated) or empty. What you need may not be in it.

## Why content goes missing

- **Truncation**: snapshots cap at 500 elements by default. Dense pages (long lists, search results, infinite scroll) overflow
- **No accessible name**: images without `alt`, icon-only buttons, decorative links, SVGs without ARIA labels excluded from accessibility tree
- **Image-rendered content**: math, formulas, charts (WolframAlpha, LaTeX, Wikipedia formulas, Google image search) — result is single `<img>` with meaning in `alt` text, not DOM
- **Late-loading content**: page still hydrating. Wait (see dynamic-content skill if `wait*` call fails), re-snapshot

## Recipe

1. **If truncated, narrow scope first.** Most tasks don't need every element — re-snapshot with higher `maxElements` only if element genuinely beyond 500:

   ```json
   { "method": "snapshot", "params": { "maxElements": 1000 } }
   ```

<!-- compliant-omit -->

2. **If element has no accessible name**, use `evaluate` to read directly:

   ```json
   {
     "method": "evaluate",
     "params": {
       "content": "(() => [...document.querySelectorAll('img[alt]')].map(i => i.alt))()"
     }
   }
   ```

   Or get text from icon-only button:

   ```json
   {
     "method": "evaluate",
     "params": {
       "content": "(() => document.querySelector('[data-testid=\"close\"]')?.getAttribute('aria-label'))()"
     }
   }
   ```

3. **For image-rendered results** (WolframAlpha, LaTeX renderers), `alt` attribute usually carries answer:

   ```json
   {
     "method": "evaluate",
     "params": {
       "content": "(() => [...document.querySelectorAll('img[alt]')].map(i => i.alt).filter(Boolean))()"
     }
   }
   ```

   <!-- /compliant-omit -->

<!-- compliant-only -->

2. **If a control has no accessible name** (icon-only button, image without `alt`), `screenshot` to see it, then act via a nearby labeled element from the snapshot — or read a region with `html` / `text` on a container selector:

   ```json
   { "method": "html", "params": { "selector": "main" } }
   ```

3. **For image-rendered results** (WolframAlpha, LaTeX, charts, image search), `screenshot` and read the answer visually — the model has vision, so a single `<img>` whose meaning isn't in the DOM is still readable:

   ```json
   { "method": "screenshot" }
   ```

<!-- /compliant-only -->

4. **For very long lists**, scroll and re-snapshot rather than raising `maxElements` — snapshot pagination more reliable than one giant pull:

   ```json
   {
     "commands": [
       { "method": "scroll", "params": { "direction": "down" } },
       { "method": "snapshot" }
     ]
   }
   ```

## Don't

- Raise `maxElements` past ~2000 — model spends more on snapshot reading than task gains. Scroll and paginate instead
<!-- compliant-omit -->
- `evaluate` to crawl `document.body.innerHTML` for general extraction. Snapshot structured; raw HTML floods context with markup. Use `evaluate` only for _specific_ attributes snapshot can't surface
<!-- /compliant-omit -->
