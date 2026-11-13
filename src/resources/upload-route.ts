import type { FastMCP } from 'fastmcp';
import {
  downloadOwner,
  downloadUri,
  storeDownload,
  FILE_TRANSFER_MAX_BYTES,
} from '../lib/download-store.js';
import { guardRouteAuth } from '../lib/http-auth.js';
import type { McpConfig } from '../@types/types.js';

// Registers `POST /upload` (httpStream only): clients push a file's bytes over
// plain HTTP and get back a handle to pass to the agent's `uploadFile`.
//   curl -fsS -F file=@/path/to/file "<mcpBaseUrl>/upload" -H "Authorization: Bearer ${BROWSERLESS_TOKEN:?Set BROWSERLESS_TOKEN locally to the MCP session token}"
// Same token as the MCP surface; the base64 never enters the model's context.
export function registerUploadRoute(server: FastMCP, config: McpConfig): void {
  const app = server.getApp();
  let verificationsInFlight = 0;

  app.post('/upload', async (c) => {
    // This route performs its own bounded verification below; do not also run
    // the session-opening /active check (or wait for it before applying the cap).
    const auth = await guardRouteAuth(c, config, false);
    if (auth instanceof Response) return auth;

    // Reject positively invalid plain keys before staging. Preserve existing
    // upload behavior when verification is unavailable or capacity-limited.
    if (auth.authMethod !== 'oauth' && verificationsInFlight >= 16) {
      // Bound upstream work without adding a new upload rejection or queue.
      console.warn(
        '[browserless-mcp] Upload credential verification at capacity; allowing upload',
      );
    } else if (auth.authMethod !== 'oauth') {
      verificationsInFlight++;
      try {
        const url = new URL(`${auth.apiUrl.replace(/\/+$/, '')}/pressure`);
        url.searchParams.set('token', auth.token);
        const response = await fetch(url, {
          // JSON avoids a worker's capacity-based 503 response.
          headers: { Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        const message = await response.text();
        let errorMessage = message;
        try {
          // Usage metadata is not an error signal. Retain nested error messages.
          errorMessage = JSON.stringify(JSON.parse(message), [
            'error',
            'message',
            'error_description',
            'code',
          ]);
        } catch {
          // Older backends return plain-text errors.
        }
        const limitError =
          /credits?|\bunits?\b|(?:spend|usage|concurrency|rate)[ _-]?(?:limit|cap)/i.test(
            errorMessage,
          );
        const capabilityError =
          /\bunsupported[ _-]*(?:plan|account[ _-]*type|endpoint)\b|\b(?:plan|account[ _-]*type|endpoint)(?: is)? (?:unsupported|not supported)\b|\b(?:plan|account) (?:does not|doesn't) support\b|\b(?:request|endpoint) requires (?:an? )?[\w-]+ (?:account|plan)\b/i.test(
            message,
          );
        const invalidKey =
          /\b(?:invalid|unknown|unrecognized)[ _-]*(?:api[ _-]*)?(?:key|token|credential)\b/i.test(
            message,
          );
        if (
          invalidKey ||
          ([401, 403].includes(response.status) &&
            !limitError &&
            !capabilityError)
        ) {
          return c.json({ ok: false, error: 'Unauthorized' }, 401);
        }
        if (!response.ok || limitError || capabilityError) {
          // Do not log the upstream body or URL: they may contain credentials.
          console.warn(
            `[browserless-mcp] Upload credential verification inconclusive (HTTP ${response.status}); allowing upload`,
          );
        }
      } catch {
        console.warn(
          '[browserless-mcp] Upload credential verification unavailable; allowing upload',
        );
      } finally {
        verificationsInFlight--;
      }
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
      downloadOwner(auth.token),
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
