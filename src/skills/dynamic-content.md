# Waiting for Dynamic Content

A `wait*` call just timed out, or the page is loading content asynchronously and your last snapshot missed it. Choosing the right wait method matters — wait for the *signal that the work is done*, not for an arbitrary delay.

## Decision tree

| Situation | Use |
|---|---|
| You know the API endpoint that returns the data | `waitForResponse { url, statuses?: [200] }` |
| You know a CSS selector that will appear when ready | `waitForSelector { selector, timeout: 5000 }` |
| The page navigates after your click | `waitForNavigation { timeout }` |
| You know nothing specific, just need a beat | `waitForTimeout { time: 3000 }` (last resort) |

`waitForResponse` is the most reliable — it fires on the actual network event. Prefer it whenever you can identify the API URL pattern.

## Common patterns

**Search-then-results:**

```json
{ "commands": [
  { "method": "type", "params": { "selector": "input#q", "text": "browserless" } },
  { "method": "click", "params": { "selector": "button#search" } },
  { "method": "waitForResponse", "params": { "url": "*api/search*", "statuses": [200] } },
  { "method": "snapshot" }
]}
```

**Form submit with redirect:**

```json
{ "commands": [
  { "method": "click", "params": { "selector": "button#submit" } },
  { "method": "waitForNavigation", "params": { "timeout": 10000 } },
  { "method": "snapshot" }
]}
```

**Click that opens a modal lazily:**

```json
{ "commands": [
  { "method": "click", "params": { "selector": "button#open-settings" } },
  { "method": "waitForSelector", "params": { "selector": "[role='dialog']", "timeout": 5000 } },
  { "method": "snapshot" }
]}
```

## When a wait method times out

If you got here because `waitForSelector`/`waitForResponse`/etc. timed out:

1. **Check whether the trigger actually fired** — re-snapshot. The page may have already rendered the content (your wait condition was wrong, not the page).
2. **Widen the URL/selector pattern** — `*api/search*` matches more than `https://example.com/api/search/v2`. Use globs liberally.
3. **Switch wait type** — if `waitForResponse` for an API call fails, the API might be cached or websocket-based; switch to `waitForSelector` for the rendered output.
4. **Last resort: `waitForTimeout { time: 3000 }`** — coarse but always works. Only when the other methods can't lock onto a real signal.

## Don't

- **Don't use `evaluate` with `setTimeout` / `await new Promise(...)`** to wait. The `evaluate` call returns immediately; the timer runs in the page after your code already reported done. Use the dedicated `wait*` methods instead.
- **Don't pile up `waitForTimeout` calls** to "be safe." Three 3-second timeouts is 9 wasted seconds vs. one `waitForResponse` that finishes the moment the request lands.
- **Don't skip the wait entirely** and re-snapshot in a tight loop. You burn tokens on each empty snapshot, and the page can race you.
