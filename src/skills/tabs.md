# Working with Tabs

Page spawned (or you opened) multiple tabs, or tab-related error occurred. Tab management has sharp edges — read before issuing tab commands.

## Snapshots include tab state

Every `snapshot` response includes `tabs[]` (`targetId`, `url`, `title`, `active`) and `activeTargetId`. After action that spawns tab — `target="_blank"` click, `window.open`, OAuth popup — next snapshot's `tabs` list includes new tab. **No need to call `getTabs` unless you want fresh list without snapshot.**

## Commands

| Command                                     | Use                                          |
| ------------------------------------------- | -------------------------------------------- |
| `getTabs`                                   | Refresh tab list without snapshot            |
| `switchTab { targetId }`                    | Make another tab active                      |
| `createTab { url?, activate?, waitUntil? }` | Open new tab — defaults to `activate: true`  |
| `closeTab { targetId }`                     | Close tab                                    |
| `snapshot { targetId }`                     | Peek at non-active tab **without switching** |

## Patterns

**Following `target="_blank"` link:**

```json
{
  "commands": [
    { "method": "click", "params": { "selector": "a#docs-link" } },
    { "method": "snapshot" }
  ]
}
```

New tab appears in snapshot's `tabs` list. If click activated it (most do), `activeTargetId` points at new tab — keep working there. If not, `switchTab` to it.

**Comparing two pages without losing place:**

```json
{
  "commands": [
    { "method": "snapshot", "params": { "targetId": "<other-tab-target-id>" } }
  ]
}
```

`snapshot { targetId }` returns other tab's elements but **doesn't switch** — active tab unchanged. Useful for checking popup/sibling tab before committing.

**Background tab (don't lose focus):**

```json
{
  "method": "createTab",
  "params": {
    "url": "https://example.com/reference",
    "activate": false
  }
}
```

New tab opens, current stays active. Pair with `snapshot { targetId }` later to read without switching.

## Closing tabs

`closeTab` on **active** tab auto-switches focus to newest remaining tab. Check response's `activeTargetId`:

- New id → now active tab
- `null` → no tabs remain. `createTab` to continue or `close` to end session

## Error codes

- **`TAB_NOT_FOUND`** — `targetId` stale. Call `getTabs` to refresh, retry with new id. Don't loop on same id
- **`TAB_CLOSED`** — tab disappeared mid-operation (OAuth flows). Call `getTabs`, retry against remaining tabs
- **`TAB_LIMIT_EXCEEDED`** — too many tabs open. Close unused one before creating another. Identify by url/title in snapshot's `tabs` list

## Don't

- Call `getTabs` between commands. Snapshots already carry list. `getTabs` for cases without snapshot
- `switchTab` when only reading. Use `snapshot { targetId }` instead — cheaper, doesn't disturb focus
- Close tabs you didn't open unless user requested. Background tabs may belong to user's larger flow
