# When Snapshot Misses Content

Snapshot at element limit (truncated) or empty. What you need may not be in it.

## Why content goes missing

- **Truncation**: snapshots cap at 500 elements by default, and a long snapshot is returned in pages. Element order is not guaranteed to follow the page top to bottom, so a cut-off snapshot can be missing elements from anywhere on the page, not only its end
- **No accessible name**: images without `alt`, icon-only buttons, decorative links, SVGs without ARIA labels excluded from accessibility tree
- **Image-rendered content**: math, formulas, charts (WolframAlpha, LaTeX, Wikipedia formulas, Google image search) — result is single `<img>` with meaning in `alt` text, not DOM
- **Late-loading content**: page still hydrating. Wait (see dynamic-content skill if `wait*` call fails), re-snapshot

## Recipe

1. **If the snapshot was cut off, pick the cheapest way to what you need:**
   - Its last line names the next page: `{ "method": "snapshot", "params": { "from": N } }`. Use it when you need to act on an element that is not shown yet.
   - To read content, use `text` with no selector, or `text` / `html` on a container `ref=` the snapshot did show.
   - Raise `maxElements` only when the snapshot reports 500 elements in total and the element is still missing after paging.

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

4. **Scroll only for lists that load more as you scroll** (infinite feeds, lazy results). The snapshot covers the whole page, not the viewport, so scrolling a static page returns the same elements:

   ```json
   {
     "commands": [
       { "method": "scroll", "params": { "direction": "down" } },
       { "method": "waitForTimeout", "params": { "time": 1000 } },
       { "method": "snapshot" }
     ]
   }
   ```

## Don't

- Raise `maxElements` to read content — it multiplies the snapshot size. Read with `text`, or page with `from`
- Scroll a static page to reach more elements — it changes nothing

<!-- compliant-omit -->

- `evaluate` to crawl `document.body.innerHTML` for general extraction. Snapshot structured; raw HTML floods context with markup. Use `evaluate` only for _specific_ attributes snapshot can't surface

<!-- /compliant-omit -->
