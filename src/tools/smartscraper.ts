import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import { defineTool, validateHttpUrl } from '../lib/define-tool.js';
import { profileField } from './schemas.js';
import { ResponseCache } from '../lib/cache.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  McpConfig,
  SmartScrapeResult,
  SmartScraperParams,
} from '../@types/types.js';

/**
 * Output formats that can be requested.
 * Mirrors the Firecrawl "formats" convention used by the Browserless API.
 */
export const ScrapeFormatSchema = z.enum([
  'markdown',
  'html',
  'rawText',
  'screenshot',
  'pdf',
  'links',
]);

export const SmartScraperParamsSchema = z
  .object({
    url: z.url().describe('The URL to scrape (must be http or https)'),
    formats: z
      .array(ScrapeFormatSchema)
      .min(1)
      .optional()
      .default(['markdown'])
      .describe(
        'Output formats to include: "markdown", "html", "rawText", "screenshot", "pdf", "links". rawText is DOM text with script, style, and noscript elements removed and whitespace collapsed, or extracted text for PDF targets. Defaults to ["markdown"].',
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Request timeout in milliseconds'),
    profile: profileField('before scraping'),
    onlyMainContent: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'For HTML webpages, remove nav, footer, aside, role=navigation, script, style, and noscript elements from DOM-derived outputs. Parsed JSON and PDF content are unchanged. Defaults to false.',
      ),
    includeTags: z
      .array(z.string())
      .max(100)
      .optional()
      .describe(
        'Up to 100 CSS selectors to keep in HTML webpage outputs. Malformed entries are ignored; if no selector matches, the scraper returns unfiltered content. Cannot be combined with excludeTags or onlyMainContent.',
      ),
    excludeTags: z
      .array(z.string())
      .max(100)
      .optional()
      .describe(
        'Up to 100 CSS selectors to remove from HTML webpage outputs. Malformed selectors are ignored. Cannot be combined with includeTags.',
      ),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Custom HTTP headers sent to the target site. host, authorization, proxy-authorization, cookie, set-cookie, x-forwarded-for, x-real-ip, and forwarded are removed by the API.',
      ),
    waitFor: z
      .number()
      .int()
      .min(0)
      .max(30_000)
      .optional()
      .describe(
        'Milliseconds to wait after page load, from 0 to 30000. A positive value forces browser rendering.',
      ),
  })
  .superRefine((params, context) => {
    if (params.includeTags?.length && params.excludeTags?.length) {
      context.addIssue({
        code: 'custom',
        message: 'includeTags and excludeTags cannot be combined',
        path: ['includeTags'],
      });
    }
    if (params.includeTags?.length && params.onlyMainContent) {
      context.addIssue({
        code: 'custom',
        message: 'includeTags and onlyMainContent cannot be combined',
        path: ['includeTags'],
      });
    }
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
  rawText: z.string().nullable().optional(),
  metadata: z
    .object({
      title: z.string().nullable(),
      description: z.string().nullable(),
      language: z.string().nullable(),
      sourceURL: z.string(),
      statusCode: z.number().nullable(),
    })
    .nullable()
    .optional(),
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
      'Scrape a SINGLE webpage and return HTML, markdown, raw DOM text, links, screenshots, or PDFs plus page metadata. ' +
      'Handles JavaScript-heavy pages and anti-bot measures automatically. ' +
      'For content across MULTIPLE pages of a site, use browserless_crawl; ' +
      "to list a site's URLs, use browserless_map.",
    parameters: SmartScraperParamsSchema,
    annotations: {
      title: 'Browserless Smart Scraper',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    validateUrl: (p) => validateHttpUrl(p.url),
    profileNotFoundMessage: (profile) =>
      `Profile "${profile}" was not found for the configured API ` +
      `token. Create the profile with Browserless.saveProfile in a ` +
      `live session first, or omit the profile parameter to scrape ` +
      `anonymously.`,
    cache,
    run: async ({ client, params }) => client.smartScrape(params),
    analyticsProps: (params, result) => ({
      url: params.url,
      formats: (params.formats ?? ['markdown']).join(','),
      timeout: params.timeout ?? config.requestTimeout,
      cache_hit: result.cacheHit,
      ok: result.ok,
      status_code: result.statusCode,
      strategy: result.strategy,
      profile_used: !!params.profile,
      only_main_content: params.onlyMainContent ?? false,
      has_content_filters: !!(
        params.includeTags?.length || params.excludeTags?.length
      ),
    }),
    format: (response, params) => {
      if (!response.ok) {
        throw new UserError(
          `Scraping failed: ${response.message ?? 'Unknown error'} ` +
            `(status: ${response.statusCode}, strategies attempted: ${response.attempted.join(', ')})`,
        );
      }
      const blocks: Content[] = [];
      // Primary text content: prefer markdown > rawText > string content > object content > diagnostic
      let textContent: string;
      if (response.markdown) {
        textContent = response.markdown;
      } else if (typeof response.rawText === 'string') {
        textContent = response.rawText;
      } else if (typeof response.content === 'string' && response.content) {
        textContent = response.content;
      } else if (response.content && typeof response.content === 'object') {
        textContent = JSON.stringify(response.content, null, 2);
      } else {
        textContent = `[No page content returned by the API. Strategy: ${response.strategy}, Status: ${response.statusCode}]`;
      }
      blocks.push({ type: 'text' as const, text: textContent });
      if (
        response.markdown &&
        params.formats.includes('rawText') &&
        typeof response.rawText === 'string'
      ) {
        blocks.push({
          type: 'text' as const,
          text: `## Raw text\n${response.rawText}`,
        });
      }
      if (
        params.formats.includes('html') &&
        typeof response.content === 'string' &&
        response.content !== textContent
      ) {
        blocks.push({
          type: 'text' as const,
          text: `## HTML\n${response.content}`,
        });
      }
      const pageMetadata = response.metadata
        ? [
            `Title: ${response.metadata.title ?? 'unknown'}`,
            `Description: ${response.metadata.description ?? 'unknown'}`,
            `Language: ${response.metadata.language ?? 'unknown'}`,
            `Source URL: ${response.metadata.sourceURL}`,
            `Source Status: ${response.metadata.statusCode ?? 'unknown'}`,
          ]
        : [];
      blocks.push({
        type: 'text' as const,
        text: [
          '---',
          ...pageMetadata,
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
