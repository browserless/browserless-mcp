import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { PowerScraperParamsSchema } from './schemas.js';
import { createApiClient } from '../lib/api-client.js';
import type { McpConfig } from '../config.js';

export function registerPowerScraperTool(
  server: FastMCP,
  config: McpConfig,
): void {
  server.addTool({
    name: 'browserless_powerscraper',
    description:
      'Scrape any webpage using the Browserless power scraper. ' +
      'Returns page content, optionally as markdown, with optional ' +
      'screenshot (PNG) and PDF. Handles JavaScript-heavy pages, ' +
      'anti-bot measures, and multiple scraping strategies automatically.',
    parameters: PowerScraperParamsSchema,
    annotations: {
      title: 'Browserless Power Scraper',
      readOnlyHint: true,
      openWorldHint: true,
    },
    execute: async (args, { reportProgress, session, log }) => {
      // Resolve token: session (httpStream auth header) > env var
      const token = (session?.token as string | undefined) ?? config.browserlessToken;
      if (!token) {
        throw new UserError(
          'No Browserless API token provided. ' +
            'For stdio: set the BROWSERLESS_TOKEN environment variable. ' +
            'For HTTP: pass Authorization: Bearer <token> header.',
        );
      }

      // Resolve API URL: session (httpStream header) > env var > default
      const apiUrl = (session?.apiUrl as string | undefined) ?? config.browserlessApiUrl;

      const urlObj = new URL(args.url);
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        throw new UserError(
          `Invalid URL protocol "${urlObj.protocol}". Only http and https are supported.`,
        );
      }

      await reportProgress({ progress: 0, total: 100 });

      const client = createApiClient({
        ...config,
        browserlessToken: token,
        browserlessApiUrl: apiUrl,
      });

      const response = await client.powerScrape({
        url: args.url,
        screenshot: args.screenshot,
        pdf: args.pdf,
        markdown: args.markdown,
        timeout: args.timeout,
      });

      await reportProgress({ progress: 100, total: 100 });

      if (!response.ok) {
        throw new UserError(
          `Scraping failed: ${response.message ?? 'Unknown error'} ` +
            `(status: ${response.statusCode}, strategies attempted: ${response.attempted.join(', ')})`,
        );
      }

      log.debug(
        `API response: ok=${response.ok}, status=${response.statusCode}, ` +
          `strategy=${response.strategy}, ` +
          `content=${typeof response.content}(${response.content ? String(response.content).length : 0}), ` +
          `markdown=${response.markdown ? response.markdown.length : 0}`,
      );

      const contentBlocks: Content[] = [];

      let textContent: string;
      if (response.markdown) {
        textContent = response.markdown;
      } else if (
        typeof response.content === 'string' &&
        response.content
      ) {
        textContent = response.content;
      } else if (
        response.content &&
        typeof response.content === 'object'
      ) {
        textContent = JSON.stringify(response.content, null, 2);
      } else {
        textContent = `[No page content returned by the API. Strategy: ${response.strategy}, Status: ${response.statusCode}]`;
      }

      contentBlocks.push({
        type: 'text' as const,
        text: textContent,
      });

      contentBlocks.push({
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
        contentBlocks.push({
          type: 'image' as const,
          data: response.screenshot,
          mimeType: 'image/png',
        });
      }

      if (response.pdf) {
        contentBlocks.push({
          type: 'text' as const,
          text: `[PDF Document - base64 encoded, ${response.pdf.length} characters]\n${response.pdf}`,
        });
      }

      return { content: contentBlocks };
    },
  });
}
