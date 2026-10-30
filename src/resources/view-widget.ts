import { readFileSync } from 'node:fs';
import type { FastMCP } from 'fastmcp';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { VIEW_URI } from '../lib/view-schemas.js';
import type { McpConfig } from '../@types/types.js';
import { mediaOrigin } from '../lib/agent-media.js';

export function registerViewWidget(
  server: FastMCP,
  config?: Pick<McpConfig, 'mcpBaseUrl' | 'transport'>,
): void {
  // Keep the previous URI readable while refreshed hosts discover the new UI.
  for (const uri of [
    VIEW_URI,
    'ui://browserless/view/v2.html',
    'ui://browserless/view/v1.html',
  ])
    server.addResource({
      uri,
      name:
        uri === VIEW_URI
          ? 'Browserless views'
          : `Browserless view (${uri.includes('v2') ? 'v2' : 'v1'} compatibility)`,
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
                resourceDomains:
                  config && mediaOrigin(config) ? [mediaOrigin(config)!] : [],
              },
            },
            'openai/widgetDescription':
              'Browserless replay player, screenshot gallery, and recorded video viewer.',
          },
        };
      },
    });
}
