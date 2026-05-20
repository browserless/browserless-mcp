import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { SmartScraperParamsSchema } from './schemas.js';
import { defineTool, validateHttpUrl } from '../lib/define-tool.js';
import { ResponseCache } from '../lib/cache.js';
import { AmplitudeHelper } from '../lib/amplitude.js';
import type {
  McpConfig,
  SmartScrapeResult,
  SmartScraperParams,
} from '../@types/types.js';

export function registerSmartScraperTool(
  server: FastMCP,
  config: McpConfig,
  amplitude?: AmplitudeHelper,
): void {
  const cache = new ResponseCache(config.cacheTtlMs);

  defineTool<SmartScraperParams, SmartScrapeResult>(server, config, amplitude, {
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
