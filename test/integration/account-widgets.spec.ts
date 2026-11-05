import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../../src/config.js';
import { registerSurface } from '../../src/tools/register.js';
import { replayViews } from '../../src/lib/view-store.js';
import { ShowOutputSchema } from '../../src/lib/view-schemas.js';

const blocks = (result: Record<string, unknown>) =>
  result.content as Array<{ text?: string }>;
const snapshot = (result: Record<string, unknown>) =>
  ShowOutputSchema.parse(result.structuredContent).data as any;

describe('account widgets over real MCP HTTP', () => {
  it('prepares owned snapshots, preserves legacy text and filters, and rechecks access without repeating producers', async () => {
    let revoked = false;
    let empty = false;
    const requests: Array<{ query: string; variables: Record<string, any> }> =
      [];
    const backend = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      requests.push(parsed);
      response.setHeader('content-type', 'application/json');
      if (revoked) {
        response.end(
          JSON.stringify({ errors: [{ message: 'Access revoked' }] }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            accountSummary: {
              accountId: 'account-a',
              currentPeriodEnd: 1800000000,
              cloudUnits: { used: 240, available: 200, overageFee: 0 },
            },
            accountUsage: {
              summary: empty
                ? null
                : {
                    successful: parsed.variables.timeframe === 'week' ? 70 : 10,
                    errored: 0,
                    timedout: null,
                    queued: 0,
                    rejected: 0,
                    maxConcurrent: 1,
                    captcha: null,
                    proxy: 0,
                  },
            },
            getActiveSession: {
              count: empty ? 0 : 9,
              sessions: empty
                ? []
                : [
                    {
                      browserId: 'browser-a',
                      browserName: 'Chromium',
                      type: 'agent',
                      startTime: '2026-11-05T12:00:00.000Z',
                    },
                  ],
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, '127.0.0.1', resolve),
    );
    const base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const reserve = createServer();
    await new Promise<void>((resolve) =>
      reserve.listen(0, '127.0.0.1', resolve),
    );
    const port = (reserve.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const config = {
      ...getConfig(),
      transport: 'httpStream' as const,
      browserlessApiUrl: base,
      apiServerUrl: base,
      browserlessToken: undefined,
      analyticsEnabled: false,
      maxRetries: 0,
      complianceMode: false,
    };
    const server = new FastMCP({
      name: 'account-widgets',
      version: '1.0.0',
      authenticate: async (request) => ({
        token: 'account-key',
        apiUrl: base,
        authMethod: 'oauth',
        accountId: 'account-a',
        userId: request.headers.authorization?.slice(7) ?? 'alice',
      }),
    });
    registerSurface(server, config);
    const clients: Client[] = [];
    async function connect(user = 'alice', ui = true) {
      const client = new Client(
        { name: 'account-host', version: '1.0.0' },
        {
          capabilities: ui
            ? {
                extensions: {
                  'io.modelcontextprotocol/ui': {
                    mimeTypes: ['text/html;profile=mcp-app'],
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
          {
            requestInit: { headers: { Authorization: `Bearer ${user}` } },
          },
        ),
      );
      return client;
    }
    try {
      await server.start({
        transportType: 'httpStream',
        httpStream: { host: '127.0.0.1', port },
      });
      const alice = await connect(),
        bob = await connect('bob'),
        legacy = await connect('alice', false);
      const tools = (await alice.listTools()).tools;
      for (const name of ['browserless_usage', 'browserless_sessions'])
        assert.equal(
          tools.find((tool) => tool.name === name)!._meta,
          undefined,
        );
      const args = { timeframe: 'day', apiKeyIds: ['key-a'] };
      const original = await legacy.callTool({
        name: 'browserless_usage',
        arguments: args,
      });
      const prepared = await alice.callTool({
        name: 'browserless_usage',
        arguments: args,
      });
      const first = ShowOutputSchema.parse(prepared.structuredContent);
      assert.equal(first.kind, 'usage');
      assert.deepEqual(blocks(prepared)[0], blocks(original)[0]);
      assert.equal(original.structuredContent, undefined);
      assert.equal(prepared._meta, undefined);
      assert.ok(JSON.stringify(prepared.content).includes(first.viewRef));
      assert.ok(!JSON.stringify(prepared).includes('account-key'));
      assert.deepEqual((first.data as any).apiKeyIds, ['key-a']);
      assert.equal((first.data as any).counters.timedout, null);
      const producers = requests.filter((r) =>
        r.query.includes('query AccountUsage'),
      ).length;
      const shown = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef: first.viewRef },
      });
      assert.deepEqual(shown.structuredContent, first);
      assert.equal(
        requests.filter((r) => r.query.includes('query AccountUsage')).length,
        producers,
      );
      const beforeForeign = requests.length;
      const foreign = await bob.callTool({
        name: 'browserless_show',
        arguments: { viewRef: first.viewRef },
      });
      assert.equal(foreign.isError, true);
      assert.equal(requests.length, beforeForeign);
      const week = await alice.callTool({
        name: 'browserless_usage',
        arguments: { ...args, timeframe: 'week' },
      });
      assert.deepEqual(requests.at(-1)!.variables.apiKeyIds, ['key-a']);
      assert.equal(requests.at(-1)!.variables.timeframe, 'week');
      assert.equal(snapshot(week).counters.successful, 70);
      const previous = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef: first.viewRef },
      });
      assert.deepEqual(previous.structuredContent, first);
      const sessions = await alice.callTool({
        name: 'browserless_sessions',
        arguments: { action: 'active', limit: 2, skip: 3 },
      });
      const active = ShowOutputSchema.parse(sessions.structuredContent);
      assert.equal(active.kind, 'active-sessions');
      assert.deepEqual((active.data as any).sessions[0], {
        browserId: 'browser-a',
        browserName: 'Chromium',
        type: 'agent',
        startTime: '2026-11-05T12:00:00.000Z',
      });
      assert.equal((active.data as any).limit, 2);
      assert.equal((active.data as any).skip, 3);
      assert.equal(requests.at(-1)!.variables.limit, 2);
      assert.equal(requests.at(-1)!.variables.skip, 3);
      empty = true;
      const emptyUsage = await alice.callTool({
        name: 'browserless_usage',
        arguments: {},
      });
      assert.equal(snapshot(emptyUsage).counters, null);
      assert.equal(snapshot(emptyUsage).units.used, 240);
      const emptySessions = await alice.callTool({
        name: 'browserless_sessions',
        arguments: { action: 'active' },
      });
      assert.deepEqual(snapshot(emptySessions).sessions, []);
      const legacySessions = await legacy.callTool({
        name: 'browserless_sessions',
        arguments: { action: 'active' },
      });
      assert.equal(legacySessions.structuredContent, undefined);
      assert.equal(
        blocks(legacySessions)[0].text,
        'No browsers are running on this account right now.',
      );
      // Ordinary refresh/timeframe calls must not consume every shared slot.
      for (let index = 0; index < 16; index++) {
        const refreshed = await alice.callTool({
          name: 'browserless_usage',
          arguments: { timeframe: index % 2 ? 'day' : 'week' },
        });
        assert.equal(
          ShowOutputSchema.parse(refreshed.structuredContent).kind,
          'usage',
        );
      }
      const otherUsage = await bob.callTool({
        name: 'browserless_usage',
        arguments: {},
      });
      assert.equal(
        ShowOutputSchema.parse(otherUsage.structuredContent).kind,
        'usage',
      );
      const otherSessions = await bob.callTool({
        name: 'browserless_sessions',
        arguments: { action: 'active' },
      });
      const otherView = ShowOutputSchema.parse(otherSessions.structuredContent);
      assert.equal(otherView.kind, 'active-sessions');
      const displayed = await bob.callTool({
        name: 'browserless_show',
        arguments: { viewRef: otherView.viewRef },
      });
      assert.deepEqual(displayed.structuredContent, otherView);
      revoked = true;
      const beforeRevocationCheck = requests.length;
      const denied = await bob.callTool({
        name: 'browserless_show',
        arguments: { viewRef: otherView.viewRef },
      });
      assert.equal(denied.isError, true);
      assert.equal(requests.length, beforeRevocationCheck + 1);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await server.stop();
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      await replayViews.clear();
    }
  });
});
