import { FastMCP, UserError } from 'fastmcp';
import { readFile } from 'node:fs/promises';
import { getDownload } from '../lib/download-store.js';

/**
 * Exposes captured downloads as readable MCP resources. getDownloads returns a
 * `browserless-download://<id>` link (HTTP mode); the client reads the bytes on
 * demand here — so the base64 payload stays out of the model's context until a
 * consumer genuinely asks for it.
 */
export function registerDownloadResources(server: FastMCP): void {
  server.addResourceTemplate({
    uriTemplate: 'browserless-download://{id}',
    name: 'Browserless Download',
    mimeType: 'application/octet-stream',
    arguments: [
      {
        name: 'id',
        description: 'The download handle id returned by getDownloads.',
        required: true,
      },
    ],
    async load({ id }) {
      const record = getDownload(id);
      if (!record) {
        throw new UserError(`Unknown download handle: ${id}`);
      }
      const data = await readFile(record.path);
      return { blob: data.toString('base64'), mimeType: record.mimeType };
    },
  });
}
