import { expect } from 'chai';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { getConfig } from '../../src/config.js';
import { registerSurface } from '../../src/tools/register.js';
import {
  MAX_WIDGET_REPLAY_BYTES,
  REPLAY_WIDGET_URI,
} from '../../src/resources/replay-widget.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/replay-widget.json', 'utf8'),
);

describe('replay widget over real MCP HTTP', () => {
  for (const complianceMode of [false, true]) {
    it(`preserves fallback and isolates widget data on ${complianceMode ? 'compliant' : 'full'} surface`, async () => {
      let oversized = false;
      const backend = createServer(async (request, response) => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/recording.json') {
          response.end(
            JSON.stringify({
              ...fixture,
              ...(oversized
                ? { padding: 'x'.repeat(MAX_WIDGET_REPLAY_BYTES) }
                : {}),
            }),
          );
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        const { query, variables } = JSON.parse(body);
        const entry =
          variables.apiToken === 'owner' &&
          variables.sessionId === fixture.sessionId
            ? {
                ...fixture,
                events: undefined,
                url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}/recording.json`,
              }
            : null;
        response.end(
          JSON.stringify({
            data: query.includes('getActiveSession')
              ? { getActiveSession: { sessions: [], count: 0 } }
              : { sessionReplayBySessionId: entry },
          }),
        );
      });
      await new Promise<void>((resolve) =>
        backend.listen(0, '127.0.0.1', resolve),
      );
      const portReservation = createServer();
      await new Promise<void>((resolve) =>
        portReservation.listen(0, '127.0.0.1', resolve),
      );
      const port = (portReservation.address() as AddressInfo).port;
      await new Promise<void>((resolve) =>
        portReservation.close(() => resolve()),
      );
      const base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
      const server = new FastMCP({
        name: 'replay-test',
        version: '1.0.0',
        authenticate: async (request) => ({
          token: request.headers.authorization?.slice(7) ?? '',
        }),
      });
      registerSurface(server, {
        ...getConfig(),
        browserlessToken: undefined,
        browserlessApiUrl: base,
        apiServerUrl: base,
        transport: 'httpStream',
        complianceMode,
        analyticsEnabled: false,
        maxRetries: 0,
      });
      const clients: Client[] = [];
      const connect = async (ui: boolean, token = 'owner') => {
        const client = new Client(
          { name: ui ? 'widget-host' : 'text-client', version: '1.0.0' },
          {
            capabilities: ui
              ? {
                  extensions: {
                    'io.modelcontextprotocol/ui': {
                      mimeTypes: [RESOURCE_MIME_TYPE],
                    },
                  },
                }
              : {},
          },
        );
        clients.push(client);
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${port}/mcp`),
            { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
          ),
        );
        return client;
      };
      try {
        await server.start({
          transportType: 'httpStream',
          httpStream: { host: '127.0.0.1', port },
        });
        const ui = await connect(true);
        const descriptor = (await ui.listTools()).tools.find(
          (tool) => tool.name === 'browserless_sessions',
        )!;
        expect(descriptor._meta).to.deep.include({
          ui: { resourceUri: REPLAY_WIDGET_URI },
          'openai/outputTemplate': REPLAY_WIDGET_URI,
        });
        expect(descriptor.outputSchema).to.exist;
        expect(
          (await ui.listResources()).resources.map((resource) => resource.uri),
        ).to.include(REPLAY_WIDGET_URI);
        const resource = (await ui.readResource({ uri: REPLAY_WIDGET_URI }))
          .contents[0];
        expect(resource.mimeType).to.equal(RESOURCE_MIME_TYPE);
        expect(resource._meta).to.have.property('ui');
        expect('text' in resource && resource.text).to.include('ui/initialize');
        expect('text' in resource && resource.text).not.to.include(
          fixture.sessionId,
        );
        const args = {
          name: 'browserless_sessions',
          arguments: { action: 'replay', sessionId: fixture.sessionId },
        };
        const result = await ui.callTool(args);
        expect(result.isError).not.to.equal(true);
        expect(result.structuredContent).to.include({
          action: 'replay',
          sessionId: fixture.sessionId,
          eventCount: 6,
          playable: true,
        });
        expect(
          (result._meta?.replay as { events: unknown[] }).events,
        ).to.deep.equal(fixture.events);
        expect(
          JSON.stringify({
            content: result.content,
            structuredContent: result.structuredContent,
          }),
        ).not.to.include('Step 2: Filled form');
        expect(JSON.stringify(result)).not.to.include('127.0.0.1');
        const textClient = await connect(false);
        const fallback = await textClient.callTool(args);
        expect(fallback._meta).to.equal(undefined);
        expect(
          (fallback.content as Array<{ type: string }>).some(
            (block) => block.type === 'resource',
          ),
        ).to.equal(true);
        const active = await ui.callTool({
          name: 'browserless_sessions',
          arguments: { action: 'active' },
        });
        expect(active.structuredContent).to.include({
          action: 'active',
          summary: 'No browsers are running on this account right now.',
        });
        expect(active._meta).to.equal(undefined);
        const other = await connect(true, 'other');
        const denied = await other.callTool(args);
        expect(denied.isError).to.equal(true);
        expect(denied._meta).to.equal(undefined);
        oversized = true;
        const large = await ui.callTool(args);
        expect(large.isError).not.to.equal(true);
        expect(large.structuredContent).to.include({ playable: false });
        expect(large._meta).to.equal(undefined);
        expect(
          (large.content as Array<{ type: string }>).some(
            (block) => block.type === 'resource',
          ),
        ).to.equal(true);
      } finally {
        await Promise.all(clients.map((client) => client.close()));
        await server.stop();
        backend.closeAllConnections();
        await new Promise<void>((resolve) => backend.close(() => resolve()));
      }
    });
  }
});
