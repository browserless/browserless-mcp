import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * A captured download persisted to the MCP server's filesystem. The base64
 * payload never re-enters the model's context: getDownloads returns a handle
 * (a path in stdio mode, a `browserless-download://` URI in HTTP mode) and the
 * bytes are read back from disk only when actually needed — by a resource read
 * (HTTP) or an uploadFile that references the handle.
 */
export interface StoredDownload {
  id: string;
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

export const DOWNLOAD_URI_SCHEME = 'browserless-download';

// Temp files are short-lived: a stored file is dropped (registry entry + bytes
// on disk) after this idle window. Re-download/re-stage if it's needed later.
const TTL_MS = 15 * 60 * 1000;

const store = new Map<string, StoredDownload>();
let counter = 0;

// Where captured downloads land on the MCP server. Defaults to a temp dir;
// override with BROWSERLESS_DOWNLOAD_DIR (e.g. a stable downloads folder in
// local/stdio setups where the user wants to keep the files).
const downloadsDir = (): string =>
  process.env.BROWSERLESS_DOWNLOAD_DIR ||
  join(tmpdir(), 'browserless-mcp-downloads');

/** Build the resource URI for a stored download id. */
export const downloadUri = (id: string): string =>
  `${DOWNLOAD_URI_SCHEME}://${id}`;

/** Persist bytes to disk and register them under a fresh handle. */
export const storeDownload = async (
  filename: string,
  mimeType: string,
  data: Buffer,
): Promise<StoredDownload> => {
  const dir = downloadsDir();
  await mkdir(dir, { recursive: true });
  counter += 1;
  const id = `${Date.now().toString(36)}-${counter}`;
  const safe = basename(filename) || 'download';
  // Prefix with the id so downloads that share a filename don't collide.
  const path = join(dir, `${id}-${safe}`);
  await writeFile(path, data);
  const record: StoredDownload = {
    id,
    path,
    filename: safe,
    mimeType,
    size: data.byteLength,
  };
  store.set(id, record);

  // Expire after the TTL so temp files don't accumulate. unref() keeps the
  // timer from holding the process open.
  const timer = setTimeout(() => {
    store.delete(id);
    void rm(path, { force: true }).catch(() => {});
  }, TTL_MS);
  timer.unref?.();

  return record;
};

/**
 * Resolve a handle to a stored download. Accepts a raw id, a
 * `browserless-download://<id>` URI, or (for convenience) the absolute path of
 * a previously stored download.
 */
export const getDownload = (handle: string): StoredDownload | undefined => {
  if (handle.startsWith(`${DOWNLOAD_URI_SCHEME}://`)) {
    return store.get(handle.slice(`${DOWNLOAD_URI_SCHEME}://`.length));
  }
  const byId = store.get(handle);
  if (byId) return byId;
  return [...store.values()].find((r) => r.path === handle);
};
