import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import { defineTool, validateHttpUrl } from '../lib/define-tool.js';
import { profileField } from './schemas.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  ExportParams,
  GenericApiResult,
  McpConfig,
} from '../@types/types.js';

export const ExportParamsSchema = z.object({
  url: z.url().describe('The URL to export (must be http or https)'),
  gotoOptions: z
    .object({
      waitUntil: z
        .union([
          z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']),
          z.array(
            z.enum([
              'load',
              'domcontentloaded',
              'networkidle0',
              'networkidle2',
            ]),
          ),
        ])
        .optional()
        .describe('When to consider navigation complete'),
      timeout: z
        .number()
        .optional()
        .describe('Navigation timeout in milliseconds'),
      referer: z.string().optional().describe('Referer header value'),
    })
    .optional()
    .describe('Puppeteer Page.goto() options for navigation'),
  bestAttempt: z
    .boolean()
    .optional()
    .describe('When true, proceed even if awaited events fail or timeout.'),
  includeResources: z
    .boolean()
    .optional()
    .describe(
      'When true, bundle all linked resources (CSS, JS, images) into a ZIP file.',
    ),
  waitForTimeout: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Milliseconds to wait after page load before exporting'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
  profile: profileField('before the page is exported'),
});

export function registerExportTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<ExportParams, GenericApiResult>(server, config, analytics, {
    name: 'browserless_export',
    description:
      'Export a webpage from a URL via the Browserless /export API. ' +
      'Fetches the URL and returns its content in the native format ' +
      '(HTML, PDF, image, etc.). Automatically detects the content type. ' +
      'Set includeResources=true to bundle all page assets (CSS, JS, images) ' +
      'into a ZIP archive for offline use.',
    parameters: ExportParamsSchema,
    annotations: {
      title: 'Browserless Export',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    validateUrl: (p) => validateHttpUrl(p.url),
    profileNotFoundMessage: (profile) =>
      `Profile "${profile}" was not found for the configured API ` +
      `token. Create the profile with Browserless.saveProfile in a ` +
      `live session first, or omit the profile parameter to export ` +
      `the page anonymously.`,
    run: async ({ client, params, log }) => {
      const response = await client.exportPage({
        url: params.url,
        gotoOptions: params.gotoOptions,
        bestAttempt: params.bestAttempt,
        includeResources: params.includeResources,
        waitForTimeout: params.waitForTimeout,
        timeout: params.timeout,
        profile: params.profile,
      });
      log.debug(
        `Export response: ok=${response.ok}, status=${response.statusCode}, ` +
          `contentType=${response.contentType}, size=${response.size}`,
      );
      return response;
    },
    analyticsProps: (params, result) => ({
      url: params.url,
      ok: result.ok,
      status_code: result.statusCode,
      content_type: result.contentType,
      size: result.size,
      include_resources: params.includeResources ?? false,
      profile_used: !!params.profile,
    }),
    format: (response, params) => {
      if (!response.ok) {
        throw new UserError(
          `Export failed (status ${response.statusCode}): ${response.data.slice(0, 500)}`,
        );
      }
      const filenameMatch = response.contentDisposition?.match(
        /filename[^;=\n]*=["']?([^"';\n]*)["']?/,
      );
      const filename = filenameMatch?.[1] ?? new URL(params.url).hostname;
      const blocks: Content[] = [];
      if (response.isBinary) {
        blocks.push({
          type: 'text' as const,
          text:
            `[Exported "${filename}" – ${response.contentType}, ` +
            `${response.size} bytes, base64-encoded]\n${response.data}`,
        });
      } else {
        blocks.push({ type: 'text' as const, text: response.data });
      }
      blocks.push({
        type: 'text' as const,
        text: [
          '---',
          `URL: ${params.url}`,
          `Filename: ${filename}`,
          `Content-Type: ${response.contentType}`,
          `Status: ${response.statusCode}`,
          `Size: ${response.size} bytes`,
          params.includeResources ? 'Resources: included (ZIP)' : '',
          '---',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      return blocks;
    },
  });
}
