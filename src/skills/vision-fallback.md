# Vision Fallback (click by coordinate)

Use this when the snapshot cannot surface the target — a `< ` deep selector was
already tried and still missed, or the target has no readable structure (a
`<canvas>` app, a WASM/applet surface, a map, an element buried in a shadow root
or nested iframe). Snapshot targeting is always the default; vision is the last
resort because coordinate grounding is less reliable than a selector.

## How the coordinate space works

Take a plain (non-`fullPage`) `screenshot` and read the pixel `(px, py)` of your
target in the image. Pass those **raw** pixels straight to `click` — the server
maps screenshot pixels to the page for you (it divides by the device pixel
ratio), so you do **no** arithmetic:

```json
{ "method": "click", "params": { "x": 512, "y": 305 } }
```

`click` x/y are viewport coordinates, so the shot must be the current viewport —
**not `fullPage`, and don't `clip`/crop** (a cropped image's pixels are offset
from the viewport and won't map).

## Recipe

1. **Clean the frame first.** Dismiss consent overlays and let the page settle;
   `scroll` the target into view so it sits inside the viewport.
2. **Screenshot the viewport.** A plain `screenshot` (no `fullPage`, no `clip`).
3. **Read the target's pixel and click it** with the raw `(px, py)`:
   `{ "method": "click", "params": { "x": 512, "y": 305 } }`.
4. **Re-snapshot and check.** After the click, `snapshot` to confirm the page
   changed. Nothing happened → re-screenshot, re-read the pixel, click again.
   Cap at ~3 attempts, then fall back (reload, a labeled element elsewhere, or
   report blocked).
5. **Hand back.** As soon as elements resolve in the snapshot again, return to
   selector-based clicking.

## Don't

- Don't reach for vision when the snapshot has usable elements — click by
  selector. Vision is slower and less accurate.
- Don't `fullPage` or `clip` for grounding — coordinates are viewport-relative;
  a full-page or cropped image's pixels won't map to a click.
- Don't guess coordinates without a fresh screenshot after the layout changes —
  every navigation or resize invalidates the previous coordinate space.
