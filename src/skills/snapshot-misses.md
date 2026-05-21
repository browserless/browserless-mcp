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
- `evaluate` to crawl `document.body.innerHTML` for general extraction. Snapshot structured; raw HTML floods context with markup. Use `evaluate` only for _specific_ attributes snapshot can't surface
