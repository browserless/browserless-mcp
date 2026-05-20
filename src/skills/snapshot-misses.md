# When Snapshot Misses Content

The snapshot you just received is either at the element limit (likely truncated) or empty. Either way, what you need may not be in it.

## Why content goes missing

- **Truncation**: snapshots cap at 500 elements by default. Dense pages (long lists, search results, infinite scroll) overflow.
- **No accessible name**: images without `alt`, icon-only buttons, decorative links, and SVGs without ARIA labels are excluded from the accessibility tree.
- **Image-rendered content**: math, formulas, charts (WolframAlpha, LaTeX, Wikipedia formulas, Google image search) — the result is a single `<img>` whose meaning lives in the `alt` text, not the DOM.
- **Late-loading content**: the page is still hydrating. Wait for it (see the dynamic-content skill if a `wait*` call fails) and re-snapshot.

## Recipe

1. **If truncated, narrow the scope first.** Most tasks don't need every element on the page — re-snapshot with a higher `maxElements` only if the element you need is genuinely beyond 500:

   ```json
   { "method": "snapshot", "params": { "maxElements": 1000 } }
   ```

2. **If the element you need has no accessible name**, fall back to `evaluate` to read it directly:

   ```json
   {
     "method": "evaluate",
     "params": {
       "content": "(() => [...document.querySelectorAll('img[alt]')].map(i => i.alt))()"
     }
   }
   ```

   Or to get text from an icon-only button:

   ```json
   {
     "method": "evaluate",
     "params": {
       "content": "(() => document.querySelector('[data-testid=\"close\"]')?.getAttribute('aria-label'))()"
     }
   }
   ```

3. **For image-rendered results** (WolframAlpha, LaTeX renderers), the `alt` attribute usually carries the answer:

   ```json
   {
     "method": "evaluate",
     "params": {
       "content": "(() => [...document.querySelectorAll('img[alt]')].map(i => i.alt).filter(Boolean))()"
     }
   }
   ```

4. **For very long lists**, scroll and re-snapshot rather than blowing up `maxElements` — pagination of the snapshot is more reliable than one giant pull:

   ```json
   {
     "commands": [
       { "method": "scroll", "params": { "direction": "down" } },
       { "method": "snapshot" }
     ]
   }
   ```

## Don't

- Don't keep raising `maxElements` past ~2000 — past that, the model spends more on snapshot reading than the task gains. Scroll and paginate instead.
- Don't `evaluate` to crawl `document.body.innerHTML` for general extraction. The snapshot is structured; raw HTML floods context with markup. Use `evaluate` only for _specific_ attributes the snapshot can't surface.
