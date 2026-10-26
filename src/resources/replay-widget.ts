import { readFileSync } from 'node:fs';
import type { FastMCP } from 'fastmcp';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

export const REPLAY_WIDGET_URI = 'ui://browserless/replay/v1.html';
// Keep the model-visible result small. Larger recordings retain the existing download fallback.
export const MAX_WIDGET_REPLAY_BYTES = 2 * 1024 * 1024;

export function registerReplayWidget(server: FastMCP): void {
  server.addResource({
    uri: REPLAY_WIDGET_URI,
    name: 'Browserless Session Replay',
    mimeType: RESOURCE_MIME_TYPE,
    async load() {
      return {
        text: readFileSync(
          new URL('../ui/replay.html', import.meta.url),
          'utf8',
        ),
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] },
          },
          'openai/widgetDescription':
            'Recorded Browserless session with playback and timeline controls.',
        },
      };
    },
  });
}
