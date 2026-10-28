import { readFileSync } from 'node:fs';
import type { FastMCP } from 'fastmcp';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { VIEW_URI } from '../lib/view-schemas.js';

export function registerViewWidget(server: FastMCP): void {
  // Keep the previous URI readable while refreshed hosts discover the new UI.
  for (const uri of [VIEW_URI, 'ui://browserless/view/v1.html'])
    server.addResource({
      uri,
      name:
        uri === VIEW_URI
          ? 'Browserless session replay'
          : 'Browserless session replay (v1 compatibility)',
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
              csp: { connectDomains: [], resourceDomains: [] },
            },
            'openai/widgetDescription':
              'Recorded browser session with playback, timeline, speed, and fullscreen controls.',
          },
        };
      },
    });
}
