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
          '# Browserless Smart Scraper API',
          '',
          '## Endpoint',
          `POST ${config.browserlessApiUrl}/smart-scrape`,
          '',
          '## Authentication',
          'Pass your API token as the `token` query parameter or via the `Authorization: Bearer <token>` header.',
          '',
          '## Request Body',
          '```json',
          '{',
          '  "url": "https://example.com",',
          '  "formats": ["markdown", "screenshot"]',
          '}',
          '```',
          '',
          '## Parameters',
          '- **url** (required): The URL to scrape. Must use http or https protocol.',
          '- **formats** (optional, default: `["html"]`): Output formats to include in the response.',
          '  - `"markdown"` – page content converted to markdown',
          '  - `"html"` – cleaned HTML (returned by default in `content`)',
          '  - `"screenshot"` – full-page PNG screenshot as base64 (forces browser strategy)',
          '  - `"pdf"` – PDF of the page as base64 (forces browser strategy)',
          '  - `"links"` – list of links extracted from the page',
          '',
          '## Response',
          'Returns JSON with fields: ok, statusCode, content, contentType, headers, strategy, attempted, message, screenshot, pdf, markdown, links.',
          '',
          '## Scraping Strategies',
          'The smart scraper automatically cascades through multiple strategies:',
          '1. HTTP fetch (fast, no browser)',
          '2. HTTP fetch with proxy',
          '3. Headless browser',
          '4. Headless browser with captcha solving',
          '',
          'When `screenshot` or `pdf` is in formats, a browser strategy is forced.',
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
