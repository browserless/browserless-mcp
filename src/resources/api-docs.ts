import type { FastMCP } from 'fastmcp';
import type { McpConfig } from '../config.js';

export function registerApiDocsResource(
  server: FastMCP,
  config: McpConfig,
): void {
  server.addResource({
    uri: 'browserless://api-docs',
    name: 'Browserless API Documentation',
    mimeType: 'text/markdown',
    async load() {
      return {
        text: [
          '# Browserless Power Scraper API',
          '',
          '## Endpoint',
          `POST ${config.browserlessApiUrl}`,
          '',
          '## Authentication',
          'Pass your API token as the `token` query parameter or via the `Authorization: Bearer <token>` header.',
          '',
          '## Request Body',
          '```json',
          '{',
          '  "url": "https://example.com",',
          '  "screenshot": false,',
          '  "pdf": false,',
          '  "markdown": true',
          '}',
          '```',
          '',
          '## Parameters',
          '- **url** (required): The URL to scrape. Must use http or https protocol.',
          '- **screenshot** (optional, default: false): Return a base64-encoded PNG screenshot.',
          '- **pdf** (optional, default: false): Return a base64-encoded PDF document.',
          '- **markdown** (optional, default: true): Convert page content to markdown.',
          '',
          '## Response',
          'Returns JSON with fields: ok, statusCode, content, contentType, headers, strategy, attempted, message, screenshot, pdf, markdown.',
          '',
          '## Scraping Strategies',
          'The power scraper automatically cascades through multiple strategies:',
          '1. HTTP fetch (fast, no browser)',
          '2. HTTP fetch with proxy',
          '3. Headless browser',
          '4. Headless browser with captcha solving',
          '',
          'The response includes which strategy succeeded and which were attempted.',
          '',
          '## Documentation',
          '- [Browserless Docs](https://docs.browserless.io/)',
          '- [REST APIs](https://docs.browserless.io/rest-apis/intro)',
        ].join('\n'),
      };
    },
  });
}
