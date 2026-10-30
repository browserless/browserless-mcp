import { readFileSync } from 'node:fs';
import type { FastMCP } from 'fastmcp';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { VIEW_URI } from '../lib/view-schemas.js';
import type { McpConfig } from '../@types/types.js';
import { handoffOrigins } from '../lib/handoff.js';
import { mediaOrigin } from '../lib/agent-media.js';

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
    ...Array.from(
      { length: 8 },
      (_, index) => `ui://browserless/view/v${index + 1}.html`,
    ),
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
                resourceDomains:
                  config && mediaOrigin(config) ? [mediaOrigin(config)!] : [],
              },
            },
            'openai/widgetDescription':
              'Browserless replay player, screenshot gallery, recorded video, and interactive human handoff viewer.',
          },
        };
      },
    });
}
