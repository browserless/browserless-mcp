# File Uploads & Downloads

Transferring files to/from the browser. Two methods: `uploadFile` (attach files to an `<input type="file">`) and `getDownloads` (retrieve files Chrome downloaded).

**Key idea — never move bytes through this conversation.** Large files as base64 blow up the context. So downloads come back as a *handle* (a path or a `browserless-download://` URI), and uploads take that handle (or a local path) instead of base64. The MCP server reads/writes the actual bytes on disk; you only pass small references. Only fall back to base64 `content` when you genuinely have raw bytes and no handle.

## Downloading

Downloads are captured automatically once the session starts. Trigger the download (click a link/button), then drain the buffer with `getDownloads`:

```json
{
  "commands": [
    { "method": "click", "params": { "selector": "a#export-csv" } },
    { "method": "getDownloads" }
  ]
}
```

- Downloads complete asynchronously. If `getDownloads` returns nothing, the file isn't finished — `waitForTimeout` and call `getDownloads` again.
- `getDownloads` **drains** the buffer: each completed file is returned once, then cleared.

**Local (stdio) mode:** files are written to disk (`BROWSERLESS_DOWNLOAD_DIR`, default a temp dir). The response lists the saved **path** for each file — hand that path straight back to `uploadFile`. Bytes never enter your context.

**Remote (HTTP) mode:** each file comes back as a `resource_link` with a `browserless-download://<id>` URI. Read it on demand via the MCP resource (`resources/read`) to get the bytes, or pass the URI back as an upload `handle`. Still no base64 in context.

## Uploading

```json
{
  "method": "uploadFile",
  "params": {
    "selector": "input[type=file]",
    "files": [ { "handle": "browserless-download://abc-1", "name": "report.pdf" } ]
  }
}
```

Each file is resolved in this order — pick the first you have:

- **`handle`** — a handle from a previous `getDownloads`, or from staging a local file (below). The server reads the stored file. Works in **both** transports. This is how you re-upload a file you just downloaded — zero bytes through the conversation.
- **`path`** — a local filesystem path. **stdio only** (HTTP can't read your filesystem). The server reads and encodes it.
- **`content`** — base64 bytes. Last resort; avoid for large files.

### Uploading a NEW local file in HTTP mode

The server can't read your filesystem, so stage the file once over HTTP (bytes go via `curl`, never through the conversation), then use the returned handle:

```bash
curl -s -F file=@"/path/to/file.png" "<MCP_BASE_URL>/upload?token=<YOUR_BROWSERLESS_TOKEN>"
# → { "ok": true, "handle": "browserless-download://abc-1", "filename": "file.png", ... }
```

The `/upload` route requires your Browserless token (`?token=` or `Authorization: Bearer`). The `uploadFile` path-rejection error gives you the exact command with the token filled in.

```json
{ "method": "uploadFile", "params": { "selector": "input[type=file]", "files": [ { "handle": "browserless-download://abc-1" } ] } }
```

Staged files share the download store (15-minute TTL). **Never** base64 a file into `content` by hand — that's what staging avoids.

Other params:
- `selector` — the file input. If hidden behind a styled button, the input still exists in the DOM; target it directly (use a `< ` deep selector for shadow DOM).
- `name` / `mimeType` — optional; default from the handle/path, mimeType inferred from the extension.
- Triggers native `input`/`change` events, so frameworks (React, etc.) see the file.
- Returns `{ "ok": true }`, or `{ "ok": false, "error": "SelectorNotFound" | "InvalidTarget" | "FileTooLarge" }`.

## Size limits

Uploads and downloads are capped (server default 10MB, hard max 50MB). Oversized downloads report `error: "FileTooLarge"` (metadata, no data); oversized uploads return `ok: false, error: "FileTooLarge"`.
