# Working with Tabs

The page just spawned (or you just opened) more than one tab, or a tab-related error came back. Tab management has a few sharp edges — read this before issuing more tab commands.

## Snapshots already carry tab state

Every `snapshot` response includes `tabs[]` (with `targetId`, `url`, `title`, `active`) and `activeTargetId`. After any action that might spawn a tab — a `target="_blank"` click, `window.open`, an OAuth popup — the *next* snapshot's `tabs` list will already include the new one. **You do not need to call `getTabs` unless you want a fresh list without taking a snapshot.**

## Commands

| Command | Use |
|---|---|
| `getTabs` | Refresh the tab list without snapshotting |
| `switchTab { targetId }` | Make another tab the active one |
| `createTab { url?, activate?, waitUntil? }` | Open a new tab — defaults to `activate: true` |
| `closeTab { targetId }` | Close a tab |
| `snapshot { targetId }` | Peek at a non-active tab **without switching** |

## Patterns

**Following a `target="_blank"` link:**

```json
{ "commands": [
  { "method": "click", "params": { "selector": "a#docs-link" } },
  { "method": "snapshot" }
]}
```

The new tab appears in the snapshot's `tabs` list. If the click activated it (most do), `activeTargetId` already points at the new tab — keep working there. If not, `switchTab` to it.

**Comparing two pages without losing your place:**

```json
{ "commands": [
  { "method": "snapshot", "params": { "targetId": "<other-tab-target-id>" } }
]}
```

`snapshot { targetId }` returns the other tab's elements but **does not switch** — your active tab stays where it was. Useful for checking a popup or sibling tab before deciding whether to commit to it.

**Background tab (don't lose focus):**

```json
{ "method": "createTab", "params": {
  "url": "https://example.com/reference",
  "activate": false
}}
```

The new tab opens but the current one stays active. Pair with `snapshot { targetId }` later if you want to read it without switching.

## Closing tabs

`closeTab` on the **active** tab auto-switches focus to the newest remaining tab. Check the response's `activeTargetId`:
- A new id → that's now your active tab.
- `null` → no tabs remain. Either `createTab` to keep going, or `close` to end the session.

## Error codes you may see

- **`TAB_NOT_FOUND`** — the `targetId` you passed is stale. Call `getTabs` to refresh and retry with the new id. Don't loop on the same id.
- **`TAB_CLOSED`** — the tab went away mid-operation (OAuth flows often do this). Call `getTabs` and retry against whatever's left.
- **`TAB_LIMIT_EXCEEDED`** — too many tabs open. Close an unused one before creating another. Identify it by url/title in the snapshot's `tabs` list.

## Don't

- **Don't keep calling `getTabs` between commands.** Snapshots already carry the list. `getTabs` is for cases where you didn't want to snapshot.
- **Don't `switchTab` when you only need to read.** Use `snapshot { targetId }` instead — cheaper, doesn't disturb focus.
- **Don't close tabs you didn't open** unless the user asked. Background tabs may belong to the user's larger flow, not your task.
