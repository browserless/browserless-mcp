import { basename } from 'node:path';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import type { McpConfig } from '../@types/types.js';
import type { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool } from '../lib/define-tool.js';
import {
  downloadOwner,
  downloadUri,
  storeDownload,
} from '../lib/download-store.js';
import { downloadNativeFile } from '../lib/native-file-download.js';

export function registerStageFileTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
  download: (url: string) => Promise<Buffer> = (url) => downloadNativeFile(url),
): void {
  defineTool(server, config, analytics, {
    name: 'browserless_stage_file',
    description:
      'Stage a native client file for browserless_agent uploadFile. Pass the returned handle as files: [{ handle }]; it is reusable by the same token until expiry. Native downloads are disabled pending verification of trusted file hosts.',
    parameters: z.object({
      file: z.object({
        download_url: z.string().min(1),
        file_id: z.string().min(1),
        mime_type: z.string().optional(),
        file_name: z.string().optional(),
      }),
    }),
    _meta: { 'openai/fileParams': ['file'] },
    annotations: {
      title: 'Stage File',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: async ({ params: { file }, token }) => {
      const bytes = await download(file.download_url);
      const name = basename(
        (file.file_name ?? 'upload').replaceAll('\\', '/'),
      ).replace(/[\x00-\x1f\x7f]/g, '_'); // eslint-disable-line no-control-regex -- reject filename control characters
      const filename = !name || name === '.' || name === '..' ? 'upload' : name;
      const stored = await storeDownload(
        filename,
        file.mime_type || 'application/octet-stream',
        bytes,
        downloadOwner(token),
      );
      return {
        handle: downloadUri(stored.id),
        filename: stored.filename,
        mimeType: stored.mimeType,
        size: stored.size,
      };
    },
    format: (result) => [{ type: 'text', text: JSON.stringify(result) }],
  });
}
