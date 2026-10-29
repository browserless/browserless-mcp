import { readFileSync } from 'node:fs';
import type { FastMCP } from 'fastmcp';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { VIEW_URI } from '../lib/view-schemas.js';
import type { McpConfig } from '../@types/types.js';
import { handoffOrigins } from '../lib/handoff.js';

export function registerViewWidget(
  server: FastMCP,
  config?: Pick<
    McpConfig,
    'mcpBaseUrl' | 'transport' | 'browserlessApiUrl' | 'publicBrowserlessUrl'
  >,
): void {
  // Keep the previous URI readable while refreshed hosts discover the new UI.
  for (const uri of [
    VIEW_URI,
    'ui://browserless/view/v8.html',
    'ui://browserless/view/v7.html',
    'ui://browserless/view/v6.html',
    'ui://browserless/view/v5.html',
    'ui://browserless/view/v4.html',
    'ui://browserless/view/v3.html',
    'ui://browserless/view/v2.html',
    'ui://browserless/view/v1.html',
  ])
    server.addResource({
      uri,
      name:
        uri === VIEW_URI
          ? 'Browserless views'
          : `Browserless view (${uri.match(/v\d+/)?.[0]} compatibility)`,
      mimeType: RESOURCE_MIME_TYPE,
      async load() {
        return {
          text: readFileSync(
            new URL('../ui/view.html', import.meta.url),
            'utf8',
          ),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                frameDomains:
                  config?.transport === 'httpStream'
                    ? handoffOrigins(config)
                    : [],
                resourceDomains: [],
              },
            },
            'openai/widgetDescription':
              'Browserless replay and interactive human handoff viewer.',
          },
        };
      },
    });
}
