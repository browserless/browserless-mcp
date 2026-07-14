# Screenshots

Screenshot arrives as vision content block — you'll see it directly.

## Snapshot vs. Screenshot

| Need                                 | Use                              |
| ------------------------------------ | -------------------------------- |
| Element identity, text, structure    | `snapshot`                       |
| Visual layout, colors, rendered look | `screenshot`                     |
| Extract text                         | `snapshot` or `text` — never OCR |
| Chart, map, rendered image           | `screenshot` with `selector`     |
| Verify "does this look right?"       | `screenshot`                     |

Snapshot is cheap, structured. Screenshot costs vision tokens — use when visual fidelity matters.

## Scope (smallest to largest)

1. **`selector: "#chart"`** — single element (best when target known)
2. **`clip: { x, y, width, height }`** — pixel region
3. **viewport** (default) — visible area
4. **`fullPage: true`** — entire page (use sparingly, huge tokens)

Capture smallest region that answers the question.

## Format

- **PNG** (default) — lossless, crisp text/UI
- **JPEG** `quality: 70-85` — smaller for photos/full-page
- **WebP** — better compression than JPEG
- **`omitBackground: true`** — for transparent elements

## Save to disk instead of seeing it

By default a screenshot comes back as an inline image you see right away — that
costs vision tokens and lives in context. If you only need the file _later_
(hand it to the user, or re-upload it elsewhere) and don't need to look at it
now, add **`toDisk: true`**:

```json
{ "method": "screenshot", "params": { "selector": "#invoice", "toDisk": true } }
```

You will **not** see the image. The response gives a reusable handle — a local
path (stdio) or a single-use GET URL (HTTP) — exactly like a download. Reuse it
with `uploadFile`, or hand the path/URL to the user. See the **file-transfers**
skill for the handle/path/URL rules and TTL. Note: to actually _look_ at a
disk-saved shot you'd have to load it back into context — so only use `toDisk`
when you don't need to view it.

## Pattern: capture-after-action

```json
{
  "commands": [
    { "method": "click", "params": { "selector": "button#open-modal" } },
    {
      "method": "waitForSelector",
      "params": { "selector": "[role='dialog']", "timeout": 5000 }
    },
    { "method": "screenshot", "params": { "selector": "[role='dialog']" } }
  ]
}
```

## Avoid

<!-- compliant-omit -->

- OCR via evaluate (you have vision input)
- Screenshotting for structured data (use snapshot/evaluate)

<!-- /compliant-omit -->

- Full-page screenshots by default (pick scope)
- Multiple screenshots of same state (one is enough)
