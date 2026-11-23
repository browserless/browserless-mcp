# File Uploads & Downloads

Transferring files to/from the browser. Two methods: `uploadFile` (attach files to an `<input type="file">`) and `getDownloads` (retrieve files Chrome downloaded).

**Drive the browser first** (click/goto), then follow the captured artifact's delivery instructions. Login/cookie-gated or generated downloads often have no directly fetchable URL.

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
- Files **larger than the cap** aren't transferred. Native mode reports the limit without a source-URL fallback. Legacy mode may supply a source URL; use it only when permitted by your client's credential policy.
- You decide whether to save each file. (`getDownloads` still exists for an explicit poll, but it's rarely needed.)
- A **screenshot** can be captured straight to disk with `screenshot { toDisk: true }` instead of returned inline — it then behaves exactly like a download here (same handle/path/URL, same reuse). See the **screenshots** skill.

**Local (stdio) mode:** the file is already on the local disk (`BROWSERLESS_DOWNLOAD_DIR`, default a temp dir). The response lists the saved **path** — hand it straight back to `uploadFile { path }` while it remains in that directory. Local upload paths (including symlink targets) must stay inside the download directory or an additional directory explicitly allowed by the local operator through `BROWSERLESS_UPLOAD_DIRS` (colon-separated on macOS/Linux, semicolon-separated on Windows). Nothing more to fetch. Do not bypass a rejected path by reading its bytes into the conversation or moving the file yourself.

**Remote native delivery (`delivery: mcp-resource`):** use the returned `resourceUri` only through a client/tool/runtime verified to save blobs to disk without including payloads in model requests. Basic MCP resource support is insufficient. If that path is absent or unverified, report unsupported saving without reading the resource. Check the saved file's existence and byte count through filesystem metadata only, then copy to the user's destination with the required permission approval. Claude Code's `blobSavedTo` source is under its sensitive `~/.claude` directory. If approval is denied or unavailable, or copying fails, stop and report the limitation. Never use `Read`, `cat`, an image viewer or other content inspection of that file or its copy to complete a save, even after a blocked copy. Do not access local credentials, ask for a token in chat, or fall back to shell authentication, inline bytes or a source URL.

**Remote legacy delivery:** the artifact includes authenticated HTTP save instructions. Follow them only where the client permits local authentication. The URL itself never authorizes access.

Both hosted routes authenticate the owner and share single-use consumption. The handle can be reused with `uploadFile` before consumption. Retrieval, the 15-minute deadline or session cleanup invalidates it, whichever comes first. A failure after consumption does not authorize re-running browser actions or generating the artifact again automatically.

## Uploading

```json
{
  "method": "uploadFile",
  "params": {
    "selector": "input[type=file]",
    "files": [
      {
        "handle": "browserless-download://0123456789abcdef0123456789abcdef",
        "name": "report.pdf"
      }
    ]
  }
}
```

Each file is resolved in this order — pick the first you have:

- **`handle`** — a handle from a previous `getDownloads`, or from staging a local file (below). The server reads the stored file. Works in **both** transports. This is how you re-upload a file you just downloaded — zero bytes through the conversation.
- **`path`** — a local filesystem path inside the download directory or an operator-configured `BROWSERLESS_UPLOAD_DIRS` directory. **stdio only** (HTTP can't read your filesystem). Symlinks must resolve inside an allowed directory. The server reads and encodes it.
- **`content`** — base64 bytes. Last resort; avoid for large files.

### Uploading a NEW local file in HTTP mode

The server can't read your filesystem. Use a supported client staging path and pass its returned handle. If native staging is unavailable, report the limitation instead of reading local credentials. Legacy clients with permission for local authentication can follow the server's authenticated `/upload` instructions. Never move file bytes through the conversation to bypass unsupported staging.

```json
{
  "method": "uploadFile",
  "params": {
    "selector": "input[type=file]",
    "files": [
      { "handle": "browserless-download://0123456789abcdef0123456789abcdef" }
    ]
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
