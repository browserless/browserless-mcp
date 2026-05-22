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

- OCR via evaluate (you have vision input)
- Screenshotting for structured data (use snapshot/evaluate)
- Full-page screenshots by default (pick scope)
- Multiple screenshots of same state (one is enough)
