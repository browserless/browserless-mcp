import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import { defineTool, profileField } from '../lib/define-tool.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  DownloadParams,
  GenericApiResult,
  McpConfig,
} from '../@types/types.js';

export const DownloadParamsSchema = z.object({
  code: z
    .string()
    .describe(
      'JavaScript (ESM) code to execute. The default export receives ' +
        '{ page, context }. During execution the code should trigger a ' +
        'file download in the browser (e.g. clicking a download link).',
    ),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Optional context object passed to the function.'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
  profile: profileField('before the download script runs'),
});

export function registerDownloadTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<DownloadParams, GenericApiResult>(server, config, analytics, {
    name: 'browserless_download',
    description:
      'Run custom Puppeteer code on Browserless and return the file that ' +
      'Chrome downloads during execution. Your code should trigger a file ' +
      'download (e.g. clicking a download link). The downloaded file is ' +
      'returned with its original Content-Type. Useful for downloading ' +
      'CSVs, PDFs, images, or any file from a website.',
    parameters: DownloadParamsSchema,
    annotations: {
      title: 'Browserless Download',
      readOnlyHint: false,
      openWorldHint: true,
    },
    profileNotFoundMessage: (profile) =>
      `Profile "${profile}" was not found for the configured API ` +
      `token. Create the profile with Browserless.saveProfile in a ` +
      `live session first, or omit the profile parameter to run the ` +
      `download anonymously.`,
    run: async ({ client, params, log }) => {
      const response = await client.download({
        code: params.code,
        context: params.context,
        timeout: params.timeout,
        profile: params.profile,
      });
      log.debug(
        `Download response: ok=${response.ok}, status=${response.statusCode}, ` +
          `contentType=${response.contentType}, size=${response.size}, ` +
          `disposition=${response.contentDisposition}`,
      );
      return response;
    },
    analyticsProps: (params, result) => ({
      ok: result.ok,
      status_code: result.statusCode,
      content_type: result.contentType,
      size: result.size,
      profile_used: !!params.profile,
    }),
    format: (response) => {
      if (!response.ok) {
        throw new UserError(
          `Download failed (status ${response.statusCode}): ${response.data.slice(0, 500)}`,
        );
      }
      const filenameMatch = response.contentDisposition?.match(
        /filename[^;=\n]*=["']?([^"';\n]*)["']?/,
      );
      const filename = filenameMatch?.[1] ?? 'downloaded-file';
      const blocks: Content[] = [];
      if (response.isBinary) {
        blocks.push({
          type: 'text' as const,
          text:
            `[Downloaded file: "${filename}" – ${response.contentType}, ` +
            `${response.size} bytes, base64-encoded]\n${response.data}`,
        });
      } else {
        blocks.push({ type: 'text' as const, text: response.data });
      }
      blocks.push({
        type: 'text' as const,
        text: [
          '---',
          `Filename: ${filename}`,
          `Content-Type: ${response.contentType}`,
          `Status: ${response.statusCode}`,
          `Size: ${response.size} bytes`,
          '---',
        ].join('\n'),
      });
      return blocks;
    },
  });
}
