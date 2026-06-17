import type { FastMCP } from 'fastmcp';
import { downloadUri, storeDownload } from '../lib/download-store.js';
import { resolveBrowserlessAuth } from '../lib/http-auth.js';
import type { McpConfig } from '../@types/types.js';

// Hard ceiling on a single staged upload (mirrors the transfer cap).
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Registers `POST /upload` on the HTTP-stream server. Clients (e.g. an LLM with
 * shell access) push a file's bytes here once — over plain HTTP, NOT through the
 * conversation — and get back a handle they pass to the agent's `uploadFile`:
 *
 *   curl -s -F file=@/path/to/file "<mcpBaseUrl>/upload?token=<token>"
 *   → { "ok": true, "handle": "browserless-download://<id>", ... }
 *
 * Requires the same Browserless token as the MCP surface (?token= or
 * Authorization: Bearer). The handle resolves against the shared temp-file
 * store (15-min TTL), so the
 * base64 payload never enters the model's context. Only meaningful for the
 * httpStream transport; in stdio mode `uploadFile { path }` reads files directly.
 */
export function registerUploadRoute(server: FastMCP, config: McpConfig): void {
  const app = server.getApp();

  app.post('/upload', async (c) => {
    // Raw Hono routes bypass FastMCP's authenticate, so gate the route on the
    // same Browserless token rules as the MCP surface — no anonymous drops.
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

    let file: unknown;
    try {
      const body = await c.req.parseBody();
      file = body.file;
    } catch {
      return c.json(
        {
          ok: false,
          error: 'Expected multipart/form-data with a "file" field',
        },
        400,
      );
    }

    if (!(file instanceof File)) {
      return c.json(
        {
          ok: false,
          error: 'Missing multipart "file" field (use -F file=@path)',
        },
        400,
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.byteLength > MAX_UPLOAD_BYTES) {
      return c.json(
        { ok: false, error: 'FileTooLarge', maxBytes: MAX_UPLOAD_BYTES },
        413,
      );
    }

    const record = await storeDownload(
      file.name || 'upload',
      file.type || 'application/octet-stream',
      buf,
    );
    return c.json({
      ok: true,
      handle: downloadUri(record.id),
      filename: record.filename,
      mimeType: record.mimeType,
      size: record.size,
    });
  });
}
