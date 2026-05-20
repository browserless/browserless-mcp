import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';
import { defineTool, validateHttpUrl } from '../lib/define-tool.js';
import { AmplitudeHelper } from '../lib/amplitude.js';
import type { MapParams, MapResponse, McpConfig } from '../@types/types.js';

export const SitemapModeSchema = z.enum(['include', 'skip', 'only']);

export const MapParamsSchema = z.object({
  url: z
    .url()
    .describe('The base URL to start mapping from (must be http or https)'),
  search: z
    .string()
    .optional()
    .describe('Search query to order results by relevance'),
  limit: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .default(100)
    .describe('Maximum number of links to return (default: 100, max: 5000)'),
  sitemap: SitemapModeSchema.optional()
    .default('include')
    .describe('Sitemap handling: "include" (default), "skip", "only"'),
  includeSubdomains: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include URLs from subdomains (default: true)'),
  ignoreQueryParameters: z
    .boolean()
    .optional()
    .default(true)
    .describe('Exclude URLs with query parameters (default: true)'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Request timeout in milliseconds'),
});

export function registerMapTool(
  server: FastMCP,
  config: McpConfig,
  amplitude?: AmplitudeHelper,
): void {
  defineTool<MapParams, MapResponse>(server, config, amplitude, {
    name: 'browserless_map',
    description:
      'Discover and map all URLs on a website using Browserless. ' +
      'Crawls a site via sitemaps and link extraction to find all pages. ' +
      'Returns a list of URLs with optional titles and descriptions. ' +
      'Use the search parameter to order results by relevance to a query. ' +
      'Useful for site audits, content discovery, and building site maps.',
    parameters: MapParamsSchema,
    annotations: {
      title: 'Browserless Map',
      readOnlyHint: true,
      openWorldHint: true,
    },
    validateUrl: (p) => validateHttpUrl(p.url),
    run: async ({ client, params, log }) => {
      const response = await client.map({
        url: params.url,
        search: params.search,
        limit: params.limit,
        sitemap: params.sitemap,
        includeSubdomains: params.includeSubdomains,
        ignoreQueryParameters: params.ignoreQueryParameters,
        timeout: params.timeout,
      });
      if (!response.success) {
        throw new UserError(`Map failed: ${response.error ?? 'Unknown error'}`);
      }
      log.debug(
        `Map response: success=${response.success}, links=${response.links?.length ?? 0}`,
      );
      return response;
    },
    analyticsProps: (params, result) => ({
      url: params.url,
      limit: params.limit ?? 100,
      sitemap_mode: params.sitemap ?? 'include',
      success: result.success,
      links_found: result.links?.length ?? 0,
    }),
    format: (response, params) => {
      const blocks: Content[] = [];
      if (response.links && response.links.length > 0) {
        const linksText = response.links
          .map((link, index) => {
            let text = `${index + 1}. ${link.url}`;
            if (link.title) text += `\n   Title: ${link.title}`;
            if (link.description) {
              const truncated =
                link.description.length > 200
                  ? `${link.description.slice(0, 200)}...`
                  : link.description;
              text += `\n   Description: ${truncated}`;
            }
            return text;
          })
          .join('\n\n');
        blocks.push({
          type: 'text' as const,
          text: `## Site Map Results (${response.links.length} URLs)\n\n${linksText}`,
        });
        const urlList = response.links.map((l) => l.url).join('\n');
        blocks.push({
          type: 'text' as const,
          text: `## URL List\n\n${urlList}`,
        });
      } else {
        blocks.push({
          type: 'text' as const,
          text: `No URLs found for site: ${params.url}`,
        });
      }
      blocks.push({
        type: 'text' as const,
        text: [
          '---',
          `Base URL: ${params.url}`,
          `URLs Found: ${response.links?.length ?? 0}`,
          `Sitemap Mode: ${params.sitemap ?? 'include'}`,
          params.search ? `Search Query: ${params.search}` : '',
          '---',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      return blocks;
    },
  });
}
