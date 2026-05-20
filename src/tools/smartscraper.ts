import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import {
  defineTool,
  profileField,
  validateHttpUrl,
} from '../lib/define-tool.js';
import { ResponseCache } from '../lib/cache.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  McpConfig,
  SmartScrapeResult,
  SmartScraperParams,
} from '../@types/types.js';

/**
 * Output formats that can be requested.
 * Mirrors the Firecrawl "formats" convention used by the enterprise API.
 */
export const ScrapeFormatSchema = z.enum([
  'markdown',
  'html',
  'screenshot',
  'pdf',
  'links',
]);

export const SmartScraperParamsSchema = z.object({
  url: z.url().describe('The URL to scrape (must be http or https)'),
  formats: z
    .array(ScrapeFormatSchema)
    .optional()
    .default(['markdown'])
    .describe(
      'Output formats to include: "markdown", "html", "screenshot", "pdf", "links". Defaults to ["markdown"].',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
  profile: profileField('before scraping'),
});

export const SmartScraperResponseSchema = z.object({
  ok: z.boolean(),
  statusCode: z.number().nullable(),
  content: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]),
  contentType: z.string().nullable(),
  headers: z.record(z.string(), z.string()),
  strategy: z.string(),
  attempted: z.array(z.string()),
  message: z.string().nullable(),
  screenshot: z.string().nullable(),
  pdf: z.string().nullable(),
  markdown: z.string().nullable(),
  links: z.array(z.string()).nullable(),
});

export function registerSmartScraperTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  const cache = new ResponseCache(config.cacheTtlMs);

  defineTool<SmartScraperParams, SmartScrapeResult>(server, config, analytics, {
    name: 'browserless_smartscraper',
    description:
      'Scrape any webpage using the Browserless smart scraper. ' +
      'Returns page content in requested formats (markdown, html, screenshot, pdf, links). ' +
      'Handles JavaScript-heavy pages, anti-bot measures, and multiple scraping strategies automatically.',
    parameters: SmartScraperParamsSchema,
    annotations: {
      title: 'Browserless Smart Scraper',
      readOnlyHint: true,
      openWorldHint: true,
    },
    validateUrl: (p) => validateHttpUrl(p.url),
    profileNotFoundMessage: (profile) =>
      `Profile "${profile}" was not found for the configured API ` +
      `token. Create the profile with Browserless.saveProfile in a ` +
      `live session first, or omit the profile parameter to scrape ` +
      `anonymously.`,
    cache,
    run: async ({ client, params }) =>
      client.smartScrape({
        url: params.url,
        formats: params.formats,
        timeout: params.timeout,
        profile: params.profile,
      }),
    analyticsProps: (params, result) => ({
      url: params.url,
      formats: (params.formats ?? ['markdown']).join(','),
      timeout: params.timeout ?? config.requestTimeout,
      cache_hit: result.cacheHit,
      ok: result.ok,
      status_code: result.statusCode,
      strategy: result.strategy,
      profile_used: !!params.profile,
    }),
    format: (response) => {
      if (!response.ok) {
        throw new UserError(
          `Scraping failed: ${response.message ?? 'Unknown error'} ` +
            `(status: ${response.statusCode}, strategies attempted: ${response.attempted.join(', ')})`,
        );
      }
      const blocks: Content[] = [];
      // Primary text content: prefer markdown > string content > object content > diagnostic
      let textContent: string;
      if (response.markdown) {
        textContent = response.markdown;
      } else if (typeof response.content === 'string' && response.content) {
        textContent = response.content;
      } else if (response.content && typeof response.content === 'object') {
        textContent = JSON.stringify(response.content, null, 2);
      } else {
        textContent = `[No page content returned by the API. Strategy: ${response.strategy}, Status: ${response.statusCode}]`;
      }
      blocks.push({ type: 'text' as const, text: textContent });
      blocks.push({
        type: 'text' as const,
        text: [
          '---',
          `Strategy: ${response.strategy}`,
          `Status: ${response.statusCode}`,
          `Content-Type: ${response.contentType}`,
          `Strategies Attempted: ${response.attempted.join(', ')}`,
          '---',
        ].join('\n'),
      });
      if (response.screenshot) {
        blocks.push({
          type: 'image' as const,
          data: response.screenshot,
          mimeType: 'image/png',
        });
      }
      if (response.pdf) {
        blocks.push({
          type: 'text' as const,
          text: `[PDF Document - base64 encoded, ${response.pdf.length} characters]\n${response.pdf}`,
        });
      }
      if (response.links && response.links.length > 0) {
        blocks.push({
          type: 'text' as const,
          text: `## Links (${response.links.length})\n${response.links.join('\n')}`,
        });
      }
      return blocks;
    },
  });
}
