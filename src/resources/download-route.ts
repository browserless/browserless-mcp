import type { FastMCP } from 'fastmcp';
import { readFile, rm } from 'node:fs/promises';
import { consumeDownload } from '../lib/download-store.js';
import { resolveBrowserlessAuth } from '../lib/http-auth.js';
import type { McpConfig } from '../@types/types.js';

/**
 * Registers `GET /download/:id` on the HTTP-stream server. getDownloads surfaces
 * a download as a notification (metadata only) plus this URL; the client fetches
 * the bytes out-of-band when it decides to save them — over plain HTTP, NOT
 * through the conversation:
 *
 *   curl -s "<mcpBaseUrl>/download/<id>?token=<token>" -o ./file
 *
 * Single use: the file is removed from the store and disk once served (or after
 * the 15-min TTL / session end, whichever comes first). Same token rules as the
 * MCP surface. Only meaningful for httpStream; in stdio the file is already on
 * the local disk at the path getDownloads reported.
 */
export function registerDownloadRoute(server: FastMCP, config: McpConfig): void {
  const app = server.getApp();

  app.get('/download/:id', async (c) => {
    try {
      await resolveBrowserlessAuth(
        {
          authHeader: c.req.header('authorization'),
          tokenQuery: c.req.query('token'),
          apiUrlHeader: c.req.header('x-browserless-api-url'),
          browserlessUrlQuery: c.req.query('browserlessUrl'),
        },
        config,
      );
    } catch {
      return c.json({ ok: false, error: 'Unauthorized' }, 401);
    }

    // Single-use: consume removes it from the registry so a second GET 404s.
    const record = consumeDownload(c.req.param('id'));
    if (!record) {
      return c.json(
        { ok: false, error: 'Not found (already fetched, expired, or unknown)' },
        404,
      );
    }

    try {
      const data = await readFile(record.path);
      c.header('Content-Type', record.mimeType);
      c.header(
        'Content-Disposition',
        `attachment; filename="${record.filename.replace(/"/g, '')}"`,
      );
      return c.body(data);
    } catch {
      return c.json({ ok: false, error: 'File no longer available' }, 410);
    } finally {
      // Drop the bytes once served (or on read failure) — single use.
      void rm(record.path, { force: true }).catch(() => {});
    }
  });
}
