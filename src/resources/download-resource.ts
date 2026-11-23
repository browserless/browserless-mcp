import { FastMCP, UserError } from 'fastmcp';
import { readFile, rm } from 'node:fs/promises';
import type { BrowserlessSession, McpConfig } from '../@types/types.js';
import {
  consumeDownload,
  downloadOwner,
  downloadResourceUri,
  getDownload,
  NATIVE_ARTIFACT_MAX_BYTES,
} from '../lib/download-store.js';

/** Private bytes are returned only by an explicit, authenticated resource read. */
export function registerDownloadResource(
  server: FastMCP,
  config: McpConfig,
): void {
  if (config.transport !== 'httpStream') return;
  server.addResourceTemplate({
    name: 'Browserless artifact',
    description:
      'Single-use owner-authenticated file. Saving without model exposure requires a verified client path.',
    uriTemplate: 'browserless-download://{id}/{filename}',
    arguments: [
      { name: 'id', required: true },
      { name: 'filename', required: true },
    ],
    async load({ id, filename }, auth) {
      // Never fall back to config.browserlessToken on this hosted endpoint.
      const token = (auth as BrowserlessSession | undefined)?.token;
      const unavailable = () =>
        new UserError(
          'Artifact not available (unknown, expired, or already consumed).',
        );
      if (!token || !/^[0-9a-f]{32}$/.test(id)) throw unavailable();
      const owner = downloadOwner(token);
      const existing = getDownload(id, owner);
      // The template supplies decoded segments. The name identifies this exact
      // artifact, never a path to open; malformed names must not consume it.
      if (!existing || filename !== existing.filename) throw unavailable();
      if (existing.size > NATIVE_ARTIFACT_MAX_BYTES) {
        throw new UserError(
          `Artifact exceeds the ${NATIVE_ARTIFACT_MAX_BYTES}-byte native transfer limit. Not consumed; automatic retry or regeneration is not supported.`,
        );
      }
      const record = consumeDownload(id, owner);
      if (!record) throw unavailable();
      try {
        return {
          uri: downloadResourceUri(record),
          mimeType: record.mimeType,
          blob: (await readFile(record.path)).toString('base64'),
        };
      } catch {
        throw unavailable();
      } finally {
        await rm(record.path, { force: true }).catch(() => {});
      }
    },
  });
}
