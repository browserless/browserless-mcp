import { FastMCP } from 'fastmcp';
import { getConfig } from './config.js';
import type { BrowserlessSession } from './config.js';
import { registerPowerScraperTool } from './tools/smartscraper.js';
import { registerSearchTool } from './tools/search.js';
import { registerMapTool } from './tools/map.js';
import { registerApiDocsResource } from './resources/api-docs.js';
import { registerStatusResource } from './resources/status.js';
import { registerScrapeUrlPrompt } from './prompts/scrape-url.js';
import { registerExtractContentPrompt } from './prompts/extract-content.js';
import { AmplitudeHelper } from './lib/amplitude.js';

const config = getConfig();
const amplitude = new AmplitudeHelper(
  config.analyticsEnabled,
  config.sqsQueueUrl,
  config.sqsRegion,
);

const server = new FastMCP<BrowserlessSession>({
  name: 'browserless-mcp',
  version: '0.1.0',
  authenticate:
    config.transport === 'httpStream'
      ? async (request) => {
          const params = new URLSearchParams(request.url?.split('?')[1] ?? '');

          // Token: Authorization header > ?token= query param
          const authHeader = request.headers.authorization;
          const headerToken = authHeader?.startsWith('Bearer ')
            ? authHeader.slice(7)
            : authHeader;
          const token = headerToken || params.get('token') || undefined;

          if (!token) {
            throw new Error(
              'No Browserless API token provided. ' +
                'Pass it as Authorization: Bearer <token> header or ?token= query parameter.',
            );
          }

          // API URL: x-browserless-api-url header > ?browserlessUrl= query param > default
          const apiUrl =
            (request.headers['x-browserless-api-url'] as string) ??
            params.get('browserlessUrl') ??
            config.browserlessApiUrl;

          return { token, apiUrl };
        }
      : undefined,
});

registerPowerScraperTool(server, config, amplitude);
registerSearchTool(server, config, amplitude);
registerMapTool(server, config, amplitude);
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
