import type { FastMCP } from 'fastmcp';
import {
  downloadUri,
  storeDownload,
  FILE_TRANSFER_MAX_BYTES,
} from '../lib/download-store.js';
import { resolveBrowserlessAuth } from '../lib/http-auth.js';
import type { McpConfig } from '../@types/types.js';

// Registers `POST /upload` (httpStream only): clients push a file's bytes over
// plain HTTP and get back a handle to pass to the agent's `uploadFile`.
//   curl -s -F file=@/path/to/file "<mcpBaseUrl>/upload?token=<token>"
// Same token as the MCP surface; the base64 never enters the model's context.
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
    if (buf.byteLength > FILE_TRANSFER_MAX_BYTES) {
      return c.json(
        { ok: false, error: 'FileTooLarge', maxBytes: FILE_TRANSFER_MAX_BYTES },
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
