# Screenshots

You're about to capture or just captured a screenshot. The image arrives as a vision content block — you'll see it directly, so don't worry about base64 plumbing. A few rules to follow.

## Snapshot vs. screenshot — pick the right tool

| Need | Use |
|---|---|
| Element identity, text, structure, interactability | `snapshot` (cheap, structured) |
| Visual layout, colors, rendered output, deliverable for the user | `screenshot` (vision input) |
| Extract text from the page | `snapshot` then read names, or `text { selector }` — **never** screenshot then OCR |
| Capture a chart, map, image-rendered formula | `screenshot` with a tight `selector` |
| Verify "does this look right?" | `screenshot` |

A snapshot is roughly free (one-liner per element). A screenshot costs ~1.5K vision tokens regardless of dimensions, but it's also the *only* way to see actual rendering. Use it when visual fidelity is the point, not as a substitute for inspecting the DOM.

## Scope: smallest region that answers the question

In order from cheapest/most-focused to most-expensive:

1. **`selector: "#chart"`** — element-only screenshot. Best when you know what you want to see.
2. **`clip: { x, y, width, height }`** — fixed pixel region. Useful when no clean selector exists.
3. **viewport (default)** — what's currently rendered. Good for "the thing the user sees right now."
4. **`fullPage: true`** — entire scrollable page. Use sparingly: tall pages produce huge images that downsample badly in the vision input.

If you only need to verify a single component (a button, a header, a price), use `selector`. Don't capture the whole page just because you can.

## Format and quality

- **PNG** (default) — sharp, lossless, supports transparency. Use for UI screenshots and anything with crisp edges (text, lines).
- **JPEG with `quality: 70-85`** — smaller payload for photographic or full-page screenshots. The vision model doesn't care about the last 10% of fidelity; you save bytes on the wire.
- **WebP** — same idea as JPEG with slightly better compression.
- **`omitBackground: true`** — only meaningful for selector/clip screenshots of elements with transparent backgrounds.

## Don't

- **Don't `evaluate` to read pixel data or run OCR** on your own screenshot. You already have the image as a vision input — just look at it.
- **Don't screenshot to extract structured data.** A snapshot or `evaluate` is faster, cheaper, and gives you machine-readable output. Screenshots are for what you literally need to see.
- **Don't take a full-page screenshot to "be safe."** Pick a scope. The default viewport is almost always enough.
- **Don't take multiple screenshots back-to-back of the same page state.** One image is enough; you can re-look at it. Re-screenshot only after the page has actually changed.

## Pattern: capture-after-action

For visual verification of something you just did, batch the action and the screenshot:

```json
{ "commands": [
  { "method": "click", "params": { "selector": "button#open-modal" } },
  { "method": "waitForSelector", "params": { "selector": "[role='dialog']", "timeout": 5000 } },
  { "method": "screenshot", "params": { "selector": "[role='dialog']" } }
]}
```

The `waitForSelector` ensures the modal has actually rendered before the camera fires — without it, you may capture an empty viewport.
