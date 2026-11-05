import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../../src/config.js';
import { registerSurface } from '../../src/tools/register.js';
import { AnalyticsHelper } from '../../src/lib/analytics.js';
import { replayViews } from '../../src/lib/view-store.js';
import { ShowOutputSchema } from '../../src/lib/view-schemas.js';
import { LogPayloadSchema } from '../../src/lib/log-view-schemas.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/request-logs.json', 'utf8'),
);
const content = (result: Record<string, unknown>) =>
  JSON.stringify(result.content);
describe('request-log explorer over MCP HTTP', () => {
  it('keeps rows/cursors UI-only, forwards all filters, isolates owners, rechecks access, and preserves text fallback', async () => {
    let revoked = false,
      empty = false;
    const requests: Array<{ query: string; variables: Record<string, any> }> =
      [];
    const retentionError =
      'Request logs for this plan are limited to the last 8 hours.';
    const backend = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body);
      requests.push(parsed);
      response.setHeader('content-type', 'application/json');
      if (
        (revoked && parsed.query.includes('requestLogs')) ||
        parsed.variables.startTime === '1900-01-01T00:00:00Z'
      ) {
        response.end(
          JSON.stringify({
            errors: [{ message: revoked ? 'Access revoked' : retentionError }],
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          data: {
            accountSummary: { accountId: 'account-a' },
            requestLogs: empty ? { entries: [], nextCursor: null } : fixture,
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
      browserlessApiUrl: base,
      apiServerUrl: base,
      browserlessToken: undefined,
      transport: 'httpStream' as const,
      complianceMode: false,
      analyticsEnabled: false,
      maxRetries: 0,
    };
    const server = new FastMCP({
      name: 'logs-widget-test',
      version: '1.0.0',
      authenticate: async (request) => ({
        token: 'account-key',
        apiUrl: base,
        authMethod: 'oauth',
        accountId: 'account-a',
        userId: request.headers.authorization?.slice(7) ?? 'alice',
      }),
    });
    const analytics = new AnalyticsHelper(false);
    const fire = sinon.stub(analytics, 'fireToolRequest');
    registerSurface(server, config, analytics);
    const clients: Client[] = [];
    async function connect(user = 'alice', ui = true) {
      const client = new Client(
        { name: 'logs-host', version: '1.0.0' },
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
      const logs = tools.find((tool) => tool.name === 'browserless_logs')!;
      assert.equal(logs._meta, undefined);
      assert.equal(logs.inputSchema.properties!._prompt, undefined);
      const filters = {
        startTime: '2026-11-05T11:00:00Z',
        endTime: '2026-11-05T13:00:00Z',
        limit: 20,
        requestId: 'filter-request',
        url: 'https://filter-private.test/',
        eventNames: ['request.failed'],
        outcome: 'failed',
        apiKeyId: 'filter-api-key',
        endpoint: '/filter-private',
        category: 'filter-category',
        reason: 'filter-reason',
        levels: ['ERROR'],
        order: 'asc',
      };
      const prepared = await alice.callTool({
        name: 'browserless_logs',
        arguments: { ...filters, _prompt: 'private-filter-prompt' },
      });
      assert.ok(!prepared.isError, content(prepared));
      const view = ShowOutputSchema.parse(prepared.structuredContent);
      const page = LogPayloadSchema.parse(prepared._meta!.payload);
      assert.equal(view.kind, 'request-logs');
      assert.deepEqual(page.filters, filters);
      assert.equal(page.nextCursor, fixture.nextCursor);
      assert.deepEqual(requests.at(-1)!.variables, {
        ...filters,
        order: 'ASC',
        apiToken: 'account-key',
      });
      const visible = JSON.stringify({
        content: prepared.content,
        structuredContent: prepared.structuredContent,
      });
      for (const secret of [
        'opaque-log-page-2',
        'filter-request',
        'filter-private',
        'request-failure',
        'session-failure',
        'Too many',
        'onerror',
      ])
        assert.ok(!visible.includes(secret), secret);
      const beforeShow = requests.length;
      const shown = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef: view.viewRef },
      });
      assert.deepEqual(shown.structuredContent, view);
      assert.deepEqual(shown._meta!.payload, page);
      assert.equal(requests.length, beforeShow + 1);
      assert.ok(requests.at(-1)!.query.includes('LogViewAccess'));
      assert.match(
        requests.at(-1)!.query,
        /requestLogs\(apiToken: \$apiToken, limit: 1\)/,
      );
      assert.ok(!requests.at(-1)!.query.includes('entries'));
      const beforeForeign = requests.length;
      const foreign = await bob.callTool({
        name: 'browserless_show',
        arguments: { viewRef: view.viewRef },
      });
      assert.equal(foreign.isError, true);
      assert.equal(requests.length, beforeForeign);
      const next = await alice.callTool({
        name: 'browserless_logs',
        arguments: { ...filters, cursor: page.nextCursor },
      });
      assert.equal(requests.at(-1)!.variables.cursor, fixture.nextCursor);
      assert.equal((next._meta!.payload as any).filters.cursor, undefined);
      assert.ok(!content(next).includes(fixture.nextCursor));
      const fallback = await legacy.callTool({
        name: 'browserless_logs',
        arguments: {},
      });
      assert.equal(fallback.structuredContent, undefined);
      assert.ok(content(fallback).includes('Too many concurrent requests'));
      assert.ok(content(fallback).includes(fixture.nextCursor));
      empty = true;
      const nothing = await alice.callTool({
        name: 'browserless_logs',
        arguments: {},
      });
      assert.deepEqual((nothing._meta!.payload as any).entries, []);
      assert.equal(
        (ShowOutputSchema.parse(nothing.structuredContent).data as any)
          .entryCount,
        0,
      );
      const rangeError = await alice.callTool({
        name: 'browserless_logs',
        arguments: { startTime: '1900-01-01T00:00:00Z' },
      });
      assert.equal(rangeError.isError, true);
      assert.ok(content(rangeError).includes(retentionError));
      const properties = fire.args.map((args) => args[2]);
      const telemetry = JSON.stringify(properties);
      for (const value of [
        'filter-request',
        'filter-private',
        'filter-api-key',
        'filter-category',
        'filter-reason',
        'private-filter-prompt',
        'request-failure',
        'session-failure',
        'Too many',
        fixture.nextCursor,
      ])
        assert.ok(!telemetry.includes(value), value);
      revoked = true;
      // Account identity remains valid; only request-log access has been lost.
      const denied = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef: view.viewRef },
      });
      assert.equal(denied.isError, true);
      assert.equal(denied._meta?.payload, undefined);
      const deniedRead = await alice.callTool({
        name: 'browserless_logs',
        arguments: filters,
      });
      assert.equal(deniedRead.isError, true);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await server.stop();
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      fire.restore();
      await replayViews.clear();
    }
  });
});
