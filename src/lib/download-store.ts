import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// A captured download (or staged upload) persisted to the server's filesystem;
// bytes stay on disk (never in context). Dropped on TTL, session end, or fetch.
export interface StoredDownload {
  id: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  sessionId?: string;
}

interface StoreEntry extends StoredDownload {
  timer?: ReturnType<typeof setTimeout>;
}

export const DOWNLOAD_URI_SCHEME = 'browserless-download';

const TTL_MS = 15 * 60 * 1000;

// Hard ceiling on a single file transfer (mirrors the enterprise cap).
export const FILE_TRANSFER_MAX_BYTES = 50 * 1024 * 1024;

const store = new Map<string, StoreEntry>();
let counter = 0;

// Where captured files land on the MCP server. Defaults to a temp dir; override
// with BROWSERLESS_DOWNLOAD_DIR (e.g. a stable folder in local/stdio setups).
const downloadsDir = (): string =>
  process.env.BROWSERLESS_DOWNLOAD_DIR ||
  join(tmpdir(), 'browserless-mcp-downloads');

/** Build the handle URI for a stored download id. */
export const downloadUri = (id: string): string =>
  `${DOWNLOAD_URI_SCHEME}://${id}`;

const idFromHandle = (handle: string): string =>
  handle.startsWith(`${DOWNLOAD_URI_SCHEME}://`)
    ? handle.slice(`${DOWNLOAD_URI_SCHEME}://`.length)
    : handle;

// Strip the internal timer handle before handing an entry to callers.
const toRecord = (entry: StoreEntry): StoredDownload => {
  const { timer: _timer, ...record } = entry;
  return record;
};

const dropEntry = (entry: StoreEntry): void => {
  if (entry.timer) clearTimeout(entry.timer);
  store.delete(entry.id);
  void rm(entry.path, { force: true }).catch(() => {});
};

// Persist bytes to disk under a fresh handle. `sessionId` ties the file to an
// MCP session for cleanup on session end (no session → TTL only).
export const storeDownload = async (
  filename: string,
  mimeType: string,
  data: Buffer,
  sessionId?: string,
): Promise<StoredDownload> => {
  const dir = downloadsDir();
  await mkdir(dir, { recursive: true });
  counter += 1;
  const id = `${Date.now().toString(36)}-${counter}`;
  const safe = basename(filename) || 'download';
  // Prefix with the id so files that share a name don't collide.
  const path = join(dir, `${id}-${safe}`);
  await writeFile(path, data);

  const timer = setTimeout(() => {
    store.delete(id);
    void rm(path, { force: true }).catch(() => {});
  }, TTL_MS);
  timer.unref?.();

  const entry: StoreEntry = {
    id,
    path,
    filename: safe,
    mimeType,
    size: data.byteLength,
    sessionId,
    timer,
  };
  store.set(id, entry);
  return toRecord(entry);
};

// Resolve a handle (id, URI, or stored path) WITHOUT removing it. Used by
// uploadFile, which may reference the same file more than once.
export const getDownload = (handle: string): StoredDownload | undefined => {
  const entry =
    store.get(idFromHandle(handle)) ??
    [...store.values()].find((r) => r.path === handle);
  return entry && toRecord(entry);
};

// Resolve a handle and remove it (single-use): entry, TTL timer, and bytes.
// Backs `GET /download/:id` so a download can only be fetched once.
export const consumeDownload = (handle: string): StoredDownload | undefined => {
  const entry = store.get(idFromHandle(handle));
  if (!entry) return undefined;
  if (entry.timer) clearTimeout(entry.timer);
  store.delete(entry.id);
  return toRecord(entry);
};

/** Drop every file owned by an MCP session (called when the session ends). */
export const clearSession = (sessionId: string | undefined): void => {
  if (!sessionId) return;
  for (const entry of [...store.values()]) {
    if (entry.sessionId === sessionId) dropEntry(entry);
  }
};
