import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import { defineTool } from '../lib/define-tool.js';
import { isCompliant, COMPLIANT_SEARCH_DESCRIPTION } from './compliance.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  McpConfig,
  SearchParams,
  SearchResponse,
} from '../@types/types.js';

export const SearchSourceSchema = z.enum(['web', 'news', 'images']);

export const SearchCategorySchema = z.enum(['github', 'research', 'pdf']);

export const TimeBasedOptionsSchema = z.enum(['day', 'week', 'month', 'year']);

export const SearchScrapeOptionsSchema = z.object({
  formats: z
    .array(z.enum(['markdown', 'html', 'links', 'screenshot']))
    .optional()
    .describe('Output formats for scraped content'),
  onlyMainContent: z
    .boolean()
    .optional()
    .describe('Extract only the main content using Readability'),
  includeTags: z
    .array(z.string())
    .optional()
    .describe('Only include content from these HTML tags'),
  excludeTags: z
    .array(z.string())
    .optional()
    .describe('Exclude content from these HTML tags'),
});

export const SearchParamsSchema = z.object({
  query: z.string().min(1).describe('The search query string'),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .default(10)
    .describe('Maximum number of results to return (default: 10, max: 100)'),
  lang: z
    .string()
    .optional()
    .default('en')
    .describe('Language code for search results (default: "en")'),
  country: z
    .string()
    .optional()
    .describe('Country code for geo-targeted results'),
  location: z
    .string()
    .optional()
    .describe('Location string for geo-targeted results'),
  tbs: TimeBasedOptionsSchema.optional().describe(
    'Time-based filter: "day", "week", "month", "year"',
  ),
  sources: z
    .array(SearchSourceSchema)
    .optional()
    .default(['web'])
    .describe('Search sources: "web", "news", "images" (default: ["web"])'),
  categories: z
    .array(SearchCategorySchema)
    .optional()
    .describe('Filter by categories: "github", "research", "pdf"'),
  scrapeOptions: SearchScrapeOptionsSchema.optional().describe(
    'Options for scraping each search result',
  ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});

// Compliant surface: an explicit param ALLOWLIST (`.pick`, not `.omit`), so a
// field added to the full schema later does NOT auto-appear here — it stays off
// until deliberately allowed, matching the fail-closed philosophy. Notably
// excludes `scrapeOptions` (per-result scraping reads as a search-driven bulk
// relay). `.strict()` rejects any non-allowed key loudly instead of silently
// stripping it (see ./compliance.ts).
const CompliantSearchParamsSchema = SearchParamsSchema.pick({
  query: true,
  limit: true,
  lang: true,
  country: true,
  location: true,
  tbs: true,
  sources: true,
  categories: true,
  timeout: true,
}).strict();

export function registerSearchTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  const compliant = isCompliant(config);

  defineTool<SearchParams, SearchResponse>(server, config, analytics, {
    name: 'browserless_search',
    description: compliant
      ? COMPLIANT_SEARCH_DESCRIPTION
      : 'Search the web using Browserless and optionally scrape each result. ' +
        'Performs web searches via SearXNG and can return results from web, news, or images. ' +
        'Optionally scrape each result URL to get markdown, HTML, links, or screenshots. ' +
        'Useful for research, gathering information, and finding relevant web pages.',
    // Cast: Zod's generic is invariant, so the ternary needs it. The compliant
    // schema is a `.pick` subset (a structural subtype); the runtime schema
    // FastMCP validates against is the real guard, plus the compliance-mode spec.
    parameters: (compliant
      ? CompliantSearchParamsSchema
      : SearchParamsSchema) as z.ZodType<SearchParams>,
    annotations: {
      title: 'Browserless Search',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: async ({ client, params, log }) => {
      // Defense-in-depth (parity with the agent allowlist): the `.pick().strict()`
      // schema already rejects `scrapeOptions`, but guard run() too so a future
      // schema regression can't forward per-result scraping to the backend.
      if (compliant && params.scrapeOptions !== undefined) {
        throw new UserError('scrapeOptions is not available on this endpoint.');
      }
      const response = await client.search({
        query: params.query,
        limit: params.limit,
        lang: params.lang,
        country: params.country,
        location: params.location,
        tbs: params.tbs,
        sources: params.sources,
        categories: params.categories,
        scrapeOptions: params.scrapeOptions,
        timeout: params.timeout,
      });
      log.debug(
        `Search response: success=${response.success}, totalResults=${response.totalResults}`,
      );
      return response;
    },
    analyticsProps: (params, result) => ({
      query: params.query,
      limit: params.limit ?? 10,
      sources: (params.sources ?? ['web']).join(','),
      success: result.success,
      total_results: result.totalResults,
    }),
    format: (response, params) => {
      if (!response.success) {
        throw new UserError(
          `Search failed: ${response.error ?? 'Unknown error'}`,
        );
      }
      const blocks: Content[] = [];
      if (response.data.web && response.data.web.length > 0) {
        const webResults = response.data.web
          .map((result, index) => {
            let text = `### ${index + 1}. ${result.title}\n`;
            text += `**URL:** ${result.url}\n`;
            if (result.description)
              text += `**Description:** ${result.description}\n`;
            if (result.markdown) {
              const truncated =
                result.markdown.length > 1000
                  ? `${result.markdown.slice(0, 1000)}...`
                  : result.markdown;
              text += `\n**Content:**\n${truncated}\n`;
            }
            return text;
          })
          .join('\n---\n');
        blocks.push({
          type: 'text' as const,
          text: `## Web Results (${response.data.web.length})\n\n${webResults}`,
        });
      }
      if (response.data.news && response.data.news.length > 0) {
        const newsResults = response.data.news
          .map((result, index) => {
            let text = `### ${index + 1}. ${result.title}\n`;
            text += `**URL:** ${result.url}\n`;
            if (result.date) text += `**Date:** ${result.date}\n`;
            if (result.description)
              text += `**Description:** ${result.description}\n`;
            return text;
          })
          .join('\n---\n');
        blocks.push({
          type: 'text' as const,
          text: `## News Results (${response.data.news.length})\n\n${newsResults}`,
        });
      }
      if (response.data.images && response.data.images.length > 0) {
        const imageResults = response.data.images
          .map((result, index) => {
            let text = `### ${index + 1}. ${result.title ?? 'Image'}\n`;
            if (result.imageUrl) text += `**Image URL:** ${result.imageUrl}\n`;
            if (result.url) text += `**Source:** ${result.url}\n`;
            if (result.imageWidth && result.imageHeight) {
              text += `**Size:** ${result.imageWidth}x${result.imageHeight}\n`;
            }
            return text;
          })
          .join('\n---\n');
        blocks.push({
          type: 'text' as const,
          text: `## Image Results (${response.data.images.length})\n\n${imageResults}`,
        });
      }
      if (blocks.length === 0) {
        blocks.push({
          type: 'text' as const,
          text: `No results found for query: "${params.query}"`,
        });
      }
      blocks.push({
        type: 'text' as const,
        text: [
          '---',
          `Query: ${params.query}`,
          `Total Results: ${response.totalResults}`,
          `Sources: ${(params.sources ?? ['web']).join(', ')}`,
          '---',
        ].join('\n'),
      });
      return blocks;
    },
  });
}
