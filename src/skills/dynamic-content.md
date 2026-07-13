# Waiting for Dynamic Content

`wait*` timed out or page loads async content. Wait for signal work is done, not arbitrary delay.

## Decision tree

| Situation                      | Use                                        |
| ------------------------------ | ------------------------------------------ |
| Know API endpoint              | `waitForResponse { url, statuses: [200] }` |
| Know CSS selector appears      | `waitForSelector { selector, timeout }`    |
| Page navigates                 | `waitForNavigation { timeout }`            |
| Nothing specific (last resort) | `waitForTimeout { time: 3000 }`            |

`waitForResponse` most reliable — fires on network event. Prefer when URL pattern known.

## Patterns

**Search results:**

```json
{
  "commands": [
    { "method": "type", "params": { "selector": "input#q", "text": "query" } },
    { "method": "click", "params": { "selector": "button#search" } },
    {
      "method": "waitForResponse",
      "params": { "url": "*api/search*", "statuses": [200] }
    },
    { "method": "snapshot" }
  ]
}
```

**Form with redirect:**

```json
{
  "commands": [
    { "method": "click", "params": { "selector": "button#submit" } },
    { "method": "waitForNavigation", "params": { "timeout": 10000 } },
    { "method": "snapshot" }
  ]
}
```

**Lazy modal:**

```json
{
  "commands": [
    { "method": "click", "params": { "selector": "button#open" } },
    {
      "method": "waitForSelector",
      "params": { "selector": "[role='dialog']", "timeout": 5000 }
    },
    { "method": "snapshot" }
  ]
}
```

## When timeout occurs

1. **Re-snapshot** — content may already be there (wrong wait condition)
2. **Widen pattern** — `*api/search*` matches more than exact URL
3. **Switch wait type** — if `waitForResponse` fails, try `waitForSelector` for rendered output
4. **Last resort:** `waitForTimeout { time: 3000 }`

## Avoid

<!-- compliant-omit -->

- `evaluate` with setTimeout/Promise (returns before timer completes)
<!-- /compliant-omit -->
- Multiple `waitForTimeout` stacked (use specific wait methods)
- Tight snapshot loop without wait (burns tokens, races page)
