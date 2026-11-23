import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FastMCP } from 'fastmcp';
import sinon from 'sinon';
import { getConfig } from '../../src/config.js';
import { AgentRunPayloadSchema } from '../../src/lib/agent-run-view.js';
import { AnalyticsHelper } from '../../src/lib/analytics.js';
import { replayViews, VIEW_UNAVAILABLE } from '../../src/lib/view-store.js';
import {
  MediaPayloadSchema,
  ShowOutputSchema,
} from '../../src/lib/view-schemas.js';
import { registerSurface } from '../../src/tools/register.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/agent-run.json', 'utf8'),
);
const text = (result: Record<string, unknown>) =>
  JSON.stringify(result.content);
const listen = async (server: ReturnType<typeof createServer>) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};
const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

describe('hosted run timeline over MCP HTTP', () => {
  it('reads with GET only, keeps timeline detail UI-only, and enforces access on show', async () => {
    const requests: { url: URL; method?: string }[] = [];
    let status = 200;
    let snapshot = fixture;
    const backend = createServer((request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      requests.push({ url, method: request.method });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          status !== 200
            ? { error: 'FORBIDDEN-UPSTREAM' }
            : url.pathname === '/agent/run'
              ? {
                  runs: [{ ...fixture, queryPreview: 'An example task' }],
                  nextCursor: 'opaque-next',
                }
              : snapshot,
        ),
      );
    });
    const api = `http://127.0.0.1:${await listen(backend)}`;
    const reserve = createServer();
    const port = await listen(reserve);
    await close(reserve);
    const base = `http://127.0.0.1:${port}`;
    const server = new FastMCP({
      name: 'agent-runs-test',
      version: '1.0.0',
      authenticate: async (request) => ({
        token: 'account-key',
        apiUrl: api,
        authMethod: 'oauth',
        accountId: 'account-test',
        userId: request.headers.authorization?.slice(7),
      }),
    });
    const analytics = new AnalyticsHelper(false);
    const fire = sinon.stub(analytics, 'fireToolRequest');
    const config = {
      ...getConfig(),
      browserlessApiUrl: api,
      apiServerUrl: api,
      browserlessToken: undefined,
      transport: 'httpStream' as const,
      complianceMode: false,
      analyticsEnabled: false,
      mcpBaseUrl: base,
      maxRetries: 1,
    };
    registerSurface(server, config, analytics);
    const clients: Client[] = [];
    async function connect(user: string, ui = true) {
      const client = new Client(
        { name: 'widget-host', version: '1.0.0' },
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
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${user}` } },
        }),
      );
      return client;
    }
    try {
      await server.start({
        transportType: 'httpStream',
        httpStream: { host: '127.0.0.1', port },
      });
      const alice = await connect('alice');
      const legacy = await connect('alice', false);
      const bob = await connect('bob');
      const call = (args: Record<string, unknown>, client = alice) =>
        client.callTool({ name: 'browserless_agent_runs', arguments: args });
      const get = (client = alice) =>
        call({ action: 'get', runId: fixture.id }, client);
      const show = (viewRef: string, client = alice) =>
        client.callTool({ name: 'browserless_show', arguments: { viewRef } });
      const tools = (await alice.listTools()).tools;
      const reader = tools.find(
        ({ name }) => name === 'browserless_agent_runs',
      )!;
      for (const phrase of [
        'Read-only',
        'never starts, continues, cancels or repeats a run',
        'not MCP session IDs or browser session IDs',
        'browserless_show',
        'Show at most one run timeline per chat turn',
      ])
        assert.ok(reader.description?.includes(phrase));
      assert.match(
        tools.find(({ name }) => name === 'browserless_show')!.description!,
        /hosted agent run timeline/,
      );
      const listed = await call({
        action: 'list',
        cursor: 'opaque-start',
        status: 'succeeded',
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url.pathname, '/agent/run');
      assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), {
        token: 'account-key',
        limit: '10',
        cursor: 'opaque-start',
        status: 'succeeded',
      });
      assert.match(text(listed), /An example task.*opaque-next/);

      const prepared = await get();
      assert.equal(requests.length, 2);
      assert.equal(requests[1].url.pathname, `/agent/run/${fixture.id}`);
      assert.ok(!prepared.isError, text(prepared));
      const view = ShowOutputSchema.parse(prepared.structuredContent);
      assert.equal(view.kind, 'agent-run');
      assert.match(text(prepared), /inspect the timeline inline/);
      assert.doesNotMatch(
        text(prepared) + JSON.stringify(view),
        /browserless_interact|#missing/,
      );
      const page = AgentRunPayloadSchema.parse(prepared._meta?.payload);
      assert.deepEqual(
        page.turns[0].actions.map(({ seq }) => seq),
        [1, 2, 3],
      );
      assert.equal(page.screenshot.state, 'available');
      assert.doesNotMatch(
        JSON.stringify(prepared),
        /FORBIDDEN|forbidden-links|2099-01-01/,
      );
      assert.doesNotMatch(
        JSON.stringify(fire.args.map((args) => args[2])),
        /FORBIDDEN|forbidden-links|run_example|Example Domain|opaque-start/,
      );
      assert.ok(
        fire.args.some(
          (args) =>
            args[2]?.action_count === 3 && args[2]?.failed_action_count === 1,
        ),
      );

      const shown = await show(view.viewRef);
      assert.deepEqual(shown.structuredContent, view);
      assert.deepEqual(shown._meta?.payload, page);
      assert.equal(requests.length, 3);
      assert.match(
        text(await show(view.viewRef, bob)),
        new RegExp(VIEW_UNAVAILABLE.replace('.', '\\.')),
      );
      if (page.screenshot.state !== 'available')
        assert.fail('Expected a screenshot viewRef');
      assert.equal((await show(page.screenshot.viewRef, bob)).isError, true);
      const media = await show(page.screenshot.viewRef);
      assert.equal(
        ShowOutputSchema.parse(media.structuredContent).kind,
        'agent-media',
      );
      assert.deepEqual(
        MediaPayloadSchema.parse(media._meta?.payload).artifacts.map(
          ({ label, width, height }) => [label, width, height],
        ),
        [['Final screenshot', 1, 1]],
      );
      assert.equal(requests.length, 3);

      const expiry = new Date(Date.now() + 60000).toISOString();
      snapshot = {
        ...fixture,
        expires_at: expiry,
        turns: Array.from({ length: 5 }, () => ({
          ...fixture.turns[0],
          data: { answer: 'x'.repeat(150000) },
        })),
      };
      const oversized = await get();
      assert.equal(oversized.structuredContent, undefined);
      const [message] = oversized.content as { type: string; text: string }[];
      const mediaRef =
        /Final screenshot: call browserless_show with \{"viewRef":"([^"]+)"\}/.exec(
          message.text,
        )?.[1];
      assert.ok(mediaRef);
      const oversizedMedia = ShowOutputSchema.parse(
        (await show(mediaRef)).structuredContent,
      );
      assert.equal(oversizedMedia.kind, 'agent-media');
      assert.equal(oversizedMedia.expiresAt, expiry);
      snapshot = fixture;

      const fallback = await get(legacy);
      assert.equal(fallback.structuredContent, undefined);
      assert.match(
        text(fallback),
        /1\. browserless_navigate.*2\. browserless_interact.*3\. browserless_observe/,
      );
      assert.match(text(fallback), /No steps recorded/);
      for (const [overrides, reason] of [
        [{ status: 'running' }, 'run_active'],
        [{ screenshot: '?invalid' }, 'invalid'],
        [{ formatErrors: { screenshot: 'too_large' } }, 'too_large'],
      ] as const) {
        snapshot = { ...fixture, ...overrides };
        const result = await get();
        assert.deepEqual(
          AgentRunPayloadSchema.parse(result._meta?.payload).screenshot,
          { state: 'unavailable', reason },
        );
      }

      for (const [code, message] of [
        [404, 'Run not found'],
        [403, 'Agent runs need an account-scoped API key.'],
        [429, 'Agent run reads are busy. Try again shortly.'],
        [503, 'Agent runs are temporarily unavailable.'],
        [401, 'API error 401'],
      ] as const) {
        status = code;
        const before: number = requests.length;
        const result = await get();
        assert.deepEqual(result.content, [{ type: 'text', text: message }]);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.equal(requests.length, before + 1);
        if (code === 404 || code === 403) {
          const denied = await show(view.viewRef);
          assert.deepEqual(denied.content, [
            { type: 'text', text: VIEW_UNAVAILABLE },
          ]);
        }
      }
      const beforeInvalid = requests.length;
      assert.equal((await call({ action: 'get' })).isError, true);
      for (const runId of [
        'abc',
        'run_',
        'run_../x',
        'run_a/b',
        'run_a?x=1',
        'run_' + 'a'.repeat(300),
      ])
        await assert.rejects(
          call({ action: 'get', runId }),
          /parameter validation failed/,
        );
      for (const limit of [0, 21])
        await assert.rejects(
          call({ action: 'list', limit }),
          /parameter validation failed/,
        );
      assert.equal(requests.length, beforeInvalid);
      assert.ok(requests.every(({ method }) => method === 'GET'));
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await server.stop();
      await close(backend);
      await replayViews.clear();
    }
  });
});
