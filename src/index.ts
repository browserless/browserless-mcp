import { FastMCP } from 'fastmcp';
import { getConfig } from './config.js';
import type { BrowserlessSession } from './config.js';
import { registerPowerScraperTool } from './tools/powerscraper.js';
import { registerApiDocsResource } from './resources/api-docs.js';
import { registerStatusResource } from './resources/status.js';
import { registerScrapeUrlPrompt } from './prompts/scrape-url.js';
import { registerExtractContentPrompt } from './prompts/extract-content.js';

const config = getConfig();

const server = new FastMCP<BrowserlessSession>({
  name: 'browserless-mcp',
  version: '0.1.0',
  authenticate:
    config.transport === 'httpStream'
      ? async (request) => {
          const authHeader = request.headers.authorization;
          const token = authHeader?.startsWith('Bearer ')
            ? authHeader.slice(7)
            : authHeader;

          if (!token) {
            throw new Error(
              'Missing Authorization header. Provide your Browserless API token as: Authorization: Bearer <token>',
            );
          }
          const apiUrl =
            (request.headers['x-browserless-api-url'] as string) ??
            config.browserlessApiUrl;

          return { token, apiUrl };
        }
      : undefined,
});

registerPowerScraperTool(server, config);
registerApiDocsResource(server, config);
registerStatusResource(server, config);
registerScrapeUrlPrompt(server);
registerExtractContentPrompt(server);

server.on('connect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  console.error(`[browserless-mcp] Client connected: ${id}`);
});

server.on('disconnect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  console.error(`[browserless-mcp] Client disconnected: ${id}`);
});

if (config.transport === 'httpStream') {
  server.start({
    transportType: 'httpStream',
    httpStream: {
      port: config.port,
      host: '0.0.0.0',
    },
  });
  console.error(
    `[browserless-mcp] HTTP Streamable server listening on port ${config.port}`,
  );
} else {
  server.start({
    transportType: 'stdio',
  });
}

export { server };
