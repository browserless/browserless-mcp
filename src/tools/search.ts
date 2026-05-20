import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { SearchParamsSchema } from './schemas.js';
import { defineTool } from '../lib/define-tool.js';
import { AmplitudeHelper } from '../lib/amplitude.js';
import type {
  McpConfig,
  SearchParams,
  SearchResponse,
} from '../@types/types.js';

export function registerSearchTool(
  server: FastMCP,
  config: McpConfig,
  amplitude?: AmplitudeHelper,
): void {
  defineTool<SearchParams, SearchResponse>(server, config, amplitude, {
    name: 'browserless_search',
    description:
      'Search the web using Browserless and optionally scrape each result. ' +
      'Performs web searches via SearXNG and can return results from web, news, or images. ' +
      'Optionally scrape each result URL to get markdown, HTML, links, or screenshots. ' +
      'Useful for research, gathering information, and finding relevant web pages.',
    parameters: SearchParamsSchema,
    annotations: {
      title: 'Browserless Search',
      readOnlyHint: true,
      openWorldHint: true,
    },
    run: async ({ client, params, log }) => {
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
