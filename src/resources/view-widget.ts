import { readFileSync } from 'node:fs';
import type { FastMCP } from 'fastmcp';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { VIEW_URI } from '../lib/view-schemas.js';
import type { McpConfig } from '../@types/types.js';
import { handoffOrigins } from '../lib/handoff.js';
import { mediaOrigin } from '../lib/agent-media.js';
import { PERFORMANCE_URI } from '../lib/performance-summary.js';

// Performance is self-contained and needs no media, frame, or network origins.
export function registerPerformanceWidget(server: FastMCP): void {
  // Keep the previous resource readable during host metadata refreshes.
  for (const uri of [PERFORMANCE_URI, 'ui://browserless/performance/v3.html'])
    server.addResource({
      uri,
      name:
        uri === PERFORMANCE_URI
          ? 'Browserless Lighthouse scorecard'
          : 'Browserless Lighthouse scorecard (v3 compatibility)',
      mimeType: RESOURCE_MIME_TYPE,
      async load() {
        return {
          // Errors/cancellations may not include a structured result discriminator.
          text: readFileSync(
            new URL('../ui/view.html', import.meta.url),
            'utf8',
          ).replace('<body>', '<body data-view-kind="performance">'),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: [],
                frameDomains: [],
              },
            },
            'openai/widgetDescription':
              'Lighthouse loading card that becomes an interactive scorecard with category scores, lab metrics, and failing audits. A pending audit has no scores yet. Let the widget finish; do not poll or repeat the audit. Do not recreate its charts or tables in chat. Use the completed audit reference for follow-up analysis.',
          },
        };
      },
    });
}

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
      { length: 12 },
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
              permissions: { clipboardWrite: {} },
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
              'Browserless replay, captured media, human handoff, account usage meter, active sessions table, and request-log explorer. Let the widget present its data; do not repeat its charts or tables in chat unless asked for analysis or specific values.',
          },
        };
      },
    });
}
