import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * A captured download (or staged upload) persisted to the MCP server's
 * filesystem. The base64 payload never re-enters the model's context:
 * getDownloads surfaces only metadata + a handle, and the bytes are read back
 * from disk only when actually fetched — by a single-use `GET /download/:id`
 * (HTTP), a stdio disk save, or an uploadFile that references the handle.
 *
 * Lifetime: dropped after a 15-minute TTL, when its owning MCP session ends, or
 * (for downloads) once it's been fetched once — whichever comes first.
 */
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

const dropEntry = (entry: StoreEntry): void => {
  if (entry.timer) clearTimeout(entry.timer);
  store.delete(entry.id);
  void rm(entry.path, { force: true }).catch(() => {});
};

/**
 * Persist bytes to disk and register them under a fresh handle. `sessionId`
 * ties the file to an MCP session so it can be cleaned up when that session
 * ends (staged uploads via the out-of-band route have no session → TTL only).
 */
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

  // Don't leak the internal timer handle to callers.
  const { timer: _timer, ...record } = entry;
  return record;
};

/**
 * Resolve a handle to a stored file WITHOUT removing it. Accepts a raw id, a
 * `browserless-download://<id>` URI, or the absolute path of a stored file.
 * Used by uploadFile, which may reference the same file more than once.
 */
export const getDownload = (handle: string): StoredDownload | undefined => {
  const byId = store.get(idFromHandle(handle));
  if (byId) return byId;
  return [...store.values()].find((r) => r.path === handle);
};

/**
 * Resolve a handle and remove it (single-use): clears the registry entry, the
 * TTL timer, and the bytes on disk. Backs the `GET /download/:id` route so a
 * download can only be fetched once.
 */
export const consumeDownload = (handle: string): StoredDownload | undefined => {
  const entry = store.get(idFromHandle(handle));
  if (!entry) return undefined;
  if (entry.timer) clearTimeout(entry.timer);
  store.delete(entry.id);
  const { timer: _timer, ...record } = entry;
  return record;
};

/** Drop every file owned by an MCP session (called when the session ends). */
export const clearSession = (sessionId: string | undefined): void => {
  if (!sessionId) return;
  for (const entry of [...store.values()]) {
    if (entry.sessionId === sessionId) dropEntry(entry);
  }
};
