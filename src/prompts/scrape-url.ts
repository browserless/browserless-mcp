import type { FastMCP } from 'fastmcp';

export function registerScrapeUrlPrompt(server: FastMCP): void {
  server.addPrompt({
    name: 'scrape-url',
    description:
      'Scrape a webpage and return its content as markdown with metadata',
    arguments: [
      {
        name: 'url',
        description: 'The URL to scrape',
        required: true,
      },
      {
        name: 'includeScreenshot',
        description: 'Whether to capture a screenshot (true/false)',
        required: false,
      },
    ],
    load: async ({ url, includeScreenshot }) => {
      const formats = includeScreenshot === 'true'
        ? '["markdown", "screenshot"]'
        : '["markdown"]';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Use the browserless_powerscraper tool to scrape the following URL: ${url}\n` +
                `Options: formats=${formats}\n` +
                'Return the markdown content and summarize the key information found on the page.',
            },
          },
        ],
      };
    },
  });
}
