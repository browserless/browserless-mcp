# File Uploads & Downloads

Transferring files to/from the browser. Two methods: `uploadFile` (attach files to an `<input type="file">`) and `getDownloads` (retrieve files Chrome downloaded).

**Do not `curl`/`wget`/`fetch` a file yourself to download it.** That only works for a public, static, directly-addressable URL — the easy case. The general case (files behind login/cookies, generated server-side on demand, or served by a click via `Content-Disposition` headers) has **no URL you can fetch**, and a direct fetch silently returns the wrong bytes, an HTML page, or a 403. **Drive the browser** (click/goto), and the file is captured for you. A direct fetch is only correct when this flow _hands you_ a URL (the single-use `/download/<id>` URL, or an over-cap `sourceUrl`).

**Key idea — never move bytes through this conversation.** Large files as base64 blow up the context. So downloads come back as a _handle_ (a path or a `browserless-download://` URI), and uploads take that handle (or a local path) instead of base64. The MCP server reads/writes the actual bytes on disk; you only pass small references. Only fall back to base64 `content` when you genuinely have raw bytes and no handle.

## Downloading

Just trigger the download in the agent — navigate to the file URL, or click a download link/button:

```json
{
  "commands": [
    { "method": "goto", "params": { "url": "https://example.com/report.csv" } }
  ]
}
```

- Captured downloads **auto-surface**: every agent response carries the current download ledger — **never the bytes**. You don't need to call anything to see it.
- A short, size-scaled grace wait lets quick downloads land on the **same** call. A slower one shows up as **in-progress with a byte count** ("downloading 2.0MB / 10MB") — just keep using the browser; it'll appear completed on a later response. As long as you keep touching the browser, the download state stays fresh.
- Files **larger than the cap** aren't transferred: you get a `FileTooLarge` note with the **source URL** — fetch it directly (e.g. `curl`) if you have network access.
- You decide whether to save each file. (`getDownloads` still exists for an explicit poll, but it's rarely needed.)

**Local (stdio) mode:** the file is already on the local disk (`BROWSERLESS_DOWNLOAD_DIR`, default a temp dir). The response lists the saved **path** — use/move it, or hand it straight back to `uploadFile { path }`. Nothing more to fetch.

**Remote (HTTP) mode:** the server can't write to your disk, so each file comes with a **single-use** GET URL. Fetch it with `curl` to save locally — works **once**:

```bash
curl -s "<MCP_BASE_URL>/download/<id>?token=<YOUR_BROWSERLESS_TOKEN>" -o "report.csv"
```

The exact command (with id + token + URL) is in the `getDownloads` response. Alternatively, reuse the handle as `uploadFile { files: [{ handle: "browserless-download://<id>" }] }` to re-upload it elsewhere without ever fetching the bytes. A file is dropped after one GET, after 15 minutes, or when the session ends — whichever comes first.

## Uploading

```json
{
  "method": "uploadFile",
  "params": {
    "selector": "input[type=file]",
    "files": [
      { "handle": "browserless-download://abc-1", "name": "report.pdf" }
    ]
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
{
  "method": "uploadFile",
  "params": {
    "selector": "input[type=file]",
    "files": [{ "handle": "browserless-download://abc-1" }]
  }
}
```

Staged files share the download store (15-minute TTL). **Never** base64 a file into `content` by hand — that's what staging avoids.

Other params:

- `selector` — the file input. If hidden behind a styled button, the input still exists in the DOM; target it directly (use a deep selector — prefix `<` followed by a space — for shadow DOM).
- `name` / `mimeType` — optional; default from the handle/path, mimeType inferred from the extension.
- Triggers native `input`/`change` events, so frameworks (React, etc.) see the file.
- Returns `{ "ok": true }`, or `{ "ok": false, "error": "SelectorNotFound" | "InvalidTarget" | "FileTooLarge" }`.

## Size limits

Uploads and downloads are capped (server default 10MB, hard max 50MB). Oversized downloads report `error: "FileTooLarge"` (metadata, no data); oversized uploads return `ok: false, error: "FileTooLarge"`.
