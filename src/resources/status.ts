import type { FastMCP } from 'fastmcp';
import type { McpConfig } from '../config.js';
import { createApiClient } from '../lib/api-client.js';

export function registerStatusResource(
  server: FastMCP,
  config: McpConfig,
): void {
  server.addResource({
    uri: 'browserless://status',
    name: 'Browserless Service Status',
    mimeType: 'application/json',
    async load() {
      if (!config.browserlessToken) {
        return {
          text: JSON.stringify(
            {
              apiUrl: config.browserlessApiUrl,
              ok: false,
              message:
                'No BROWSERLESS_TOKEN configured. For HTTP: pass Authorization header.',
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        };
      }

      const client = createApiClient(config);
      const status = await client.getStatus();
      return {
        text: JSON.stringify(
          {
            apiUrl: config.browserlessApiUrl,
            ...status,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
      };
    },
  });
}
