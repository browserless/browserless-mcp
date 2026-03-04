import type { FastMCP } from 'fastmcp';

export function registerExtractContentPrompt(server: FastMCP): void {
  server.addPrompt({
    name: 'extract-content',
    description:
      'Extract specific information from a webpage using the smart scraper',
    arguments: [
      {
        name: 'url',
        description: 'The URL to extract content from',
        required: true,
      },
      {
        name: 'instructions',
        description: 'What information to extract from the page',
        required: true,
      },
    ],
    load: async ({ url, instructions }) => {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Use the browserless_smartscraper tool to scrape: ${url}\n` +
                `Then extract the following information: ${instructions}\n` +
                'Return the extracted information in a structured format.',
            },
          },
        ],
      };
    },
  });
}
