import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import {
  defineTool,
  profileField,
  validateHttpUrl,
} from '../lib/define-tool.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  CrawlPageResult,
  CrawlParams,
  CrawlStartResponse,
  CrawlStatusResponse,
  McpConfig,
} from '../@types/types.js';

export const CrawlStatusSchema = z.enum([
  'in-progress',
  'completed',
  'failed',
  'cancelled',
]);

export const PageStatusSchema = z.enum([
  'queued',
  'in-progress',
  'completed',
  'failed',
  'cancelled',
]);

export const CrawlSitemapModeSchema = z.enum(['auto', 'force', 'skip']);

export const CrawlFormatSchema = z.enum(['markdown', 'html', 'rawText']);

export const CrawlScrapeOptionsSchema = z.object({
  formats: z
    .array(CrawlFormatSchema)
    .optional()
    .default(['markdown'])
    .describe('Output formats for scraped content'),
  onlyMainContent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Extract only the main content using Readability'),
  includeTags: z
    .array(z.string())
    .optional()
    .describe('HTML tag selectors to include'),
  excludeTags: z
    .array(z.string())
    .optional()
    .describe('HTML tag selectors to exclude'),
  waitFor: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(0)
    .describe('Time in ms to wait after page load before scraping'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('Custom HTTP headers to send with each request'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Navigation timeout in milliseconds'),
});

export const CrawlParamsSchema = z.object({
  url: z.url().describe('The URL to crawl (must be http or https)'),
  limit: z
    .number()
    .int()
    .positive()
    .max(10000)
    .optional()
    .default(100)
    .describe('Maximum number of pages to crawl (default: 100)'),
  maxDepth: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(5)
    .describe('Maximum link-follow depth from the root URL (default: 5)'),
  maxRetries: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(1)
    .describe('Number of retry attempts per failed page (default: 1)'),
  allowExternalLinks: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to follow links to external domains'),
  allowSubdomains: z
    .boolean()
    .optional()
    .default(false)
    .describe('Whether to follow links to subdomains'),
  sitemap: CrawlSitemapModeSchema.optional()
    .default('auto')
    .describe('Sitemap handling: "auto" (default), "force", "skip"'),
  includePaths: z
    .array(z.string())
    .optional()
    .describe('Regex patterns for URL paths to include'),
  excludePaths: z
    .array(z.string())
    .optional()
    .describe('Regex patterns for URL paths to exclude'),
  delay: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(200)
    .describe('Delay between requests in milliseconds (default: 200)'),
  scrapeOptions: CrawlScrapeOptionsSchema.optional().describe(
    'Options controlling how each page is scraped',
  ),
  waitForCompletion: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Whether to wait for crawl completion (default: true). If false, returns immediately with crawl ID.',
    ),
  pollInterval: z
    .number()
    .int()
    .positive()
    .optional()
    .default(5000)
    .describe(
      'Polling interval in ms when waiting for completion (default: 5000)',
    ),
  maxWaitTime: z
    .number()
    .int()
    .positive()
    .optional()
    .default(300000)
    .describe(
      'Maximum time in ms to wait for crawl completion when waitForCompletion is true (default: 300000 = 5 minutes)',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'HTTP request timeout in milliseconds for API calls (default: 30000)',
    ),
  profile: profileField('before each page is scraped'),
});

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Maximum number of pages to fetch full content for */
const MAX_CONTENT_PAGES = 50;

/** Maximum content length per page (chars) before truncation */
const MAX_CONTENT_LENGTH = 10000;

/** Maximum URLs to list in the crawled URLs section */
const MAX_URL_LIST = 200;

/** Shape of the JSON returned by contentUrl */
interface PageContent {
  url: string;
  statusCode: number;
  metadata: {
    title: string | null;
    description: string | null;
    language: string | null;
    contentType: string | null;
    scrapedAt: string | null;
  };
  markdown?: string;
  html?: string;
  rawText?: string;
}

/**
 * Fetch the actual scraped content from an S3 signed URL.
 * Returns null on any error (expired URL, network issue, etc.).
 */
async function fetchPageContent(
  contentUrl: string,
): Promise<PageContent | null> {
  try {
    const res = await fetch(contentUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return (await res.json()) as PageContent;
  } catch {
    return null;
  }
}

/**
 * Discriminated result of a crawl execution. `started` fires when
 * `waitForCompletion=false` so the tool returns the crawl ID immediately;
 * `completed` fires after polling reaches a terminal status.
 */
type CrawlRunResult =
  | { kind: 'started'; crawlId: string; startResponse: CrawlStartResponse }
  | {
      kind: 'completed';
      crawlId: string;
      statusResponse: CrawlStatusResponse;
      pages: Array<{ page: CrawlPageResult; content: PageContent | null }>;
    };

export function registerCrawlTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<CrawlParams, CrawlRunResult>(server, config, analytics, {
    name: 'browserless_crawl',
    description:
      'Crawl a website and scrape every discovered page using Browserless. ' +
      'Starts from a seed URL and follows links up to a configurable depth. ' +
      'Supports sitemap discovery, path filtering, subdomain handling, and custom scrape options. ' +
      'Returns scraped content (markdown/HTML) for each page along with metadata. ' +
      'Useful for comprehensive site analysis, content extraction, and data gathering.',
    parameters: CrawlParamsSchema,
    annotations: {
      title: 'Browserless Crawl',
      readOnlyHint: true,
      openWorldHint: true,
    },
    validateUrl: (p) => validateHttpUrl(p.url),
    profileNotFoundMessage: (profile) =>
      `Profile "${profile}" was not found for the configured API ` +
      `token. Create the profile with Browserless.saveProfile in a ` +
      `live session first, or omit the profile parameter to crawl ` +
      `anonymously.`,
    // crawl fires its own analytics events at multiple points (start failure,
    // timeout, async-return, success), so we skip defineTool's end-of-run fire.
    run: async ({
      client,
      params,
      log,
      analytics,
      token,
      apiUrl,
      reportProgress,
    }) => {
      const analyticsBase = {
        url: params.url,
        limit: params.limit ?? 100,
        api_url: apiUrl,
        profile_used: !!params.profile,
      };

      // Start the crawl (ProfileNotFoundError propagates to defineTool)
      const startResponse = await client.crawl({
        url: params.url,
        limit: params.limit,
        maxDepth: params.maxDepth,
        maxRetries: params.maxRetries,
        allowExternalLinks: params.allowExternalLinks,
        allowSubdomains: params.allowSubdomains,
        sitemap: params.sitemap,
        includePaths: params.includePaths,
        excludePaths: params.excludePaths,
        delay: params.delay,
        scrapeOptions: params.scrapeOptions,
        timeout: params.timeout,
        profile: params.profile,
      });

      if (!startResponse.success) {
        analytics?.fireToolRequest(token, 'browserless_crawl', {
          ...analyticsBase,
          success: false,
          error: startResponse.error ?? 'Unknown error',
        });
        throw new UserError(
          `Failed to start crawl: ${startResponse.error ?? 'Unknown error'}`,
        );
      }

      const crawlId = startResponse.id;
      log.debug(`Crawl started: id=${crawlId}, url=${params.url}`);

      // Async return — caller polls externally
      if (params.waitForCompletion === false) {
        analytics?.fireToolRequest(token, 'browserless_crawl', {
          ...analyticsBase,
          success: true,
          crawl_id: crawlId,
          wait_for_completion: false,
        });
        return { kind: 'started', crawlId, startResponse };
      }

      // Poll for completion
      const pollInterval = params.pollInterval ?? 5000;
      const maxWaitTime = params.maxWaitTime ?? 300000;
      const startTime = Date.now();
      let statusResponse: CrawlStatusResponse;
      let isFirstPoll = true;

      do {
        if (Date.now() - startTime > maxWaitTime) {
          analytics?.fireToolRequest(token, 'browserless_crawl', {
            ...analyticsBase,
            success: false,
            crawl_id: crawlId,
            timeout: true,
          });
          throw new UserError(
            `Crawl exceeded max wait time of ${maxWaitTime}ms. Crawl ID: ${crawlId}. ` +
              'The crawl may still be running. You can check its status later using the crawl ID.',
          );
        }
        if (!isFirstPoll) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }
        isFirstPoll = false;

        statusResponse = await client.getCrawl(crawlId);

        if (statusResponse.total > 0) {
          const progress = Math.min(
            Math.floor((statusResponse.completed / statusResponse.total) * 95),
            95,
          );
          await reportProgress({ progress, total: 100 });
        }

        log.debug(
          `Crawl status: ${statusResponse.status}, ` +
            `completed=${statusResponse.completed}/${statusResponse.total}, ` +
            `failed=${statusResponse.failed}`,
        );
      } while (!TERMINAL_STATUSES.has(statusResponse.status));

      // Fetch all pages (paginated)
      const allPages: CrawlPageResult[] = [...statusResponse.data];
      let nextUrl = statusResponse.next;
      let skip = allPages.length;
      while (nextUrl && allPages.length < statusResponse.total) {
        const nextResponse = await client.getCrawl(crawlId, skip);
        allPages.push(...nextResponse.data);
        skip = allPages.length;
        nextUrl = nextResponse.next;
      }

      analytics?.fireToolRequest(token, 'browserless_crawl', {
        ...analyticsBase,
        success: statusResponse.status === 'completed',
        crawl_id: crawlId,
        status: statusResponse.status,
        total_pages: statusResponse.total,
        completed_pages: statusResponse.completed,
        failed_pages: statusResponse.failed,
      });

      // Fetch page content for completed pages (so format() stays sync)
      const completedPages = allPages.filter((p) => p.status === 'completed');
      const pagesToFetch = completedPages.slice(0, MAX_CONTENT_PAGES);
      log.debug(`Fetching content for ${pagesToFetch.length} pages...`);
      const fetched = await Promise.all(
        pagesToFetch.map(async (page) => ({
          page,
          content: page.contentUrl
            ? await fetchPageContent(page.contentUrl)
            : null,
        })),
      );
      // Re-pair: keep order with allPages so failed pages render too
      const fetchedByUrl = new Map(
        fetched.map(({ page, content }) => [page, content] as const),
      );
      const pages = allPages.map((page) => ({
        page,
        content: fetchedByUrl.get(page) ?? null,
      }));

      log.debug(`Crawl completed: id=${crawlId}, pages=${allPages.length}`);
      return { kind: 'completed', crawlId, statusResponse, pages };
    },
    format: (result, params) => {
      if (result.kind === 'started') {
        return [
          {
            type: 'text' as const,
            text: [
              '## Crawl Started',
              '',
              `**Crawl ID:** ${result.crawlId}`,
              `**Status URL:** ${result.startResponse.url}`,
              `**Target URL:** ${params.url}`,
              '',
              'The crawl is running asynchronously. Use the crawl ID to check status.',
            ].join('\n'),
          },
        ];
      }

      const { crawlId, statusResponse, pages } = result;

      if (statusResponse.status === 'failed') {
        throw new UserError(
          `Crawl failed. Crawl ID: ${crawlId}. ` +
            `Completed: ${statusResponse.completed}/${statusResponse.total} pages.`,
        );
      }
      if (statusResponse.status === 'cancelled') {
        throw new UserError(
          `Crawl was cancelled. Crawl ID: ${crawlId}. ` +
            `Completed: ${statusResponse.completed}/${statusResponse.total} pages.`,
        );
      }

      const blocks: Content[] = [];

      blocks.push({
        type: 'text' as const,
        text: [
          `## Crawl Results for ${params.url}`,
          '',
          `**Status:** ${statusResponse.status}`,
          `**Total Pages:** ${statusResponse.total}`,
          `**Completed:** ${statusResponse.completed}`,
          `**Failed:** ${statusResponse.failed}`,
          statusResponse.expiresAt
            ? `**Results Expire:** ${statusResponse.expiresAt}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      });

      const completedPages = pages.filter((p) => p.page.status === 'completed');
      const failedPages = pages.filter((p) => p.page.status === 'failed');

      if (completedPages.length > 0) {
        const renderable = completedPages.slice(0, MAX_CONTENT_PAGES);
        const pageList = renderable
          .map(({ page, content }, index) => {
            const lines = [`### ${index + 1}. ${page.metadata.sourceURL}`];
            if (page.metadata.title)
              lines.push(`**Title:** ${page.metadata.title}`);
            if (page.metadata.statusCode)
              lines.push(`**Status Code:** ${page.metadata.statusCode}`);
            if (content) {
              let textContent =
                content.markdown ?? content.rawText ?? content.html;
              if (textContent) {
                if (textContent.length > MAX_CONTENT_LENGTH) {
                  textContent =
                    textContent.slice(0, MAX_CONTENT_LENGTH) +
                    `\n\n... [Content truncated at ${MAX_CONTENT_LENGTH} characters]`;
                }
                lines.push('');
                lines.push('**Content:**');
                lines.push('```');
                lines.push(textContent);
                lines.push('```');
              }
            } else if (page.contentUrl) {
              lines.push('');
              lines.push(
                '*[Content could not be fetched - URL may have expired]*',
              );
            }
            return lines.join('\n');
          })
          .join('\n\n---\n\n');
        blocks.push({
          type: 'text' as const,
          text: `## Scraped Pages (${completedPages.length})\n\n${pageList}`,
        });
        if (completedPages.length > MAX_CONTENT_PAGES) {
          blocks.push({
            type: 'text' as const,
            text:
              `\n*Note: Content shown for first ${MAX_CONTENT_PAGES} pages. ` +
              `${completedPages.length - MAX_CONTENT_PAGES} additional pages were crawled but content not included to avoid response size limits.*`,
          });
        }
      }

      if (failedPages.length > 0) {
        const failedList = failedPages
          .slice(0, 20)
          .map(({ page }, index) => {
            return `${index + 1}. ${page.metadata.sourceURL}\n   Error: ${page.metadata.error ?? 'Unknown error'}`;
          })
          .join('\n');
        blocks.push({
          type: 'text' as const,
          text: `## Failed Pages (${failedPages.length})\n\n${failedList}${failedPages.length > 20 ? `\n... and ${failedPages.length - 20} more` : ''}`,
        });
      }

      if (completedPages.length === 0 && failedPages.length === 0) {
        blocks.push({
          type: 'text' as const,
          text: 'No pages were successfully crawled.',
        });
      } else {
        const urlsToShow = completedPages.slice(0, MAX_URL_LIST);
        const urlList = urlsToShow
          .map(({ page }) => page.metadata.sourceURL)
          .join('\n');
        const urlListSuffix =
          completedPages.length > MAX_URL_LIST
            ? `\n\n... and ${completedPages.length - MAX_URL_LIST} more URLs`
            : '';
        blocks.push({
          type: 'text' as const,
          text: `## All Crawled URLs\n\n${urlList}${urlListSuffix}`,
        });
      }

      blocks.push({
        type: 'text' as const,
        text: [
          '---',
          `Crawl ID: ${crawlId}`,
          `Target URL: ${params.url}`,
          `Max Depth: ${params.maxDepth ?? 5}`,
          `Page Limit: ${params.limit ?? 100}`,
          `Sitemap Mode: ${params.sitemap ?? 'auto'}`,
          '---',
        ].join('\n'),
      });

      return blocks;
    },
  });
}
