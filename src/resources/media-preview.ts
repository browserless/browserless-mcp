import type { FastMCP } from 'fastmcp';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { replayViews, type ViewStore } from '../lib/view-store.js';

export function byteRange(
  value: string | undefined,
  length: number,
): [number, number] | null {
  if (!value || value.includes(',')) return [0, length - 1];
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = Number(match[1]),
    last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  const start = match[1] ? first : Math.max(0, length - last);
  const end = match[1] && match[2] ? Math.min(length - 1, last) : length - 1;
  return start <= end && start < length ? [start, end] : null;
}

/** Bearer capabilities grant repeatable access to one immutable artifact until expiry. */
export function registerMediaPreviewRoute(
  server: FastMCP,
  store: ViewStore = replayViews,
) {
  server.getApp().on(['GET', 'HEAD'], '/preview/:capability', async (c) => {
    const capability = c.req.param('capability');
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) return c.body(null, 404);
    const asset = store.preview(capability);
    if (!asset) return c.body(null, 404);
    const headers: Record<string, string> = {
      'Content-Type': asset.mimeType,
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    };
    if (c.req.query('download') === '1')
      headers['Content-Disposition'] =
        `attachment; filename="capture-${asset.commandIndex}.${{ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/webm': 'webm' }[asset.mimeType]}"`;
    const head = c.req.method === 'HEAD';
    const requested = head ? undefined : c.req.header('Range');
    const range = byteRange(requested, asset.bytes);
    if (!range)
      return c.body(null, 416, {
        ...headers,
        'Content-Range': `bytes */${asset.bytes}`,
      });
    const [start, end] = range;
    const partial = !!requested && !requested.includes(',');
    headers['Content-Length'] = String(end - start + 1);
    if (partial)
      headers['Content-Range'] = `bytes ${start}-${end}/${asset.bytes}`;
    let file: FileHandle | undefined;
    try {
      file = await open(asset.path, 'r');
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size !== asset.bytes ||
        !store.preview(capability)
      ) {
        await file.close();
        return c.body(null, 404);
      }
      if (head) {
        await file.close();
        return c.body(null, 200, headers);
      }
      const stream = file.createReadStream({ start, end, autoClose: true });
      const expiry = setTimeout(
        () => stream.destroy(),
        Math.max(0, asset.expires - Date.now()),
      );
      expiry.unref();
      stream.once('close', () => clearTimeout(expiry));
      return new Response(
        Readable.toWeb(stream) as ReadableStream<Uint8Array>,
        { status: partial ? 206 : 200, headers },
      );
    } catch {
      await file?.close().catch(() => {});
      return c.body(null, 404);
    }
  });
}
