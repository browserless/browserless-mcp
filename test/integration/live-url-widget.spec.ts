import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../../src/config.js';
import { registerSurface } from '../../src/tools/register.js';
import { replayViews } from '../../src/lib/view-store.js';

const chrome =
  process.env.CHROME_PATH ||
  ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

describe('direct live viewer over MCP HTTP', () => {
  it('renders create independently of the store and keeps lifecycle calls and legacy output URL-only', async function () {
    this.timeout(30000);
    let creates = 0;
    let invalid = false;
    let widget = '';
    let host = '';
    const results: unknown[] = [];
    const state = {
      status: 'open',
      reason: null,
      interactable: false,
      viewerCount: 0,
      expiresAt: Date.now() + 60_000,
    };
    const backend = createServer((request, response) => {
      if (request.url === '/widget') {
        response.setHeader('content-type', 'text/html');
        response.setHeader(
          'content-security-policy',
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'",
        );
        response.end(widget);
        return;
      }
      if (request.url === '/host.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end(host);
        return;
      }
      if (request.url === '/results') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(results));
        return;
      }
      if (request.url === '/') {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<!doctype html><pre>Waiting</pre><iframe title="MCP App" sandbox="allow-scripts allow-same-origin" style="width:760px;height:760px;border:0"></iframe><script type="module" src="/host.js"></script>',
        );
        return;
      }
      if (request.url?.startsWith('/e/abcdef/live/')) {
        response.setHeader('content-type', 'text/html');
        response.end(
          '<!doctype html><style>body{font:16px system-ui;background:#f6f5fa;padding:40px}h1{font-size:28px}</style><main id="viewer-ready"><h1>Example Domain</h1><p>Synthetic browser viewer — no live customer session</p></main>',
        );
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST') {
        creates++;
        response.end(
          JSON.stringify({
            liveURL: invalid
              ? 'https://untrusted.example/live/index.html?i=live-1'
              : `${base}/e/abcdef/live/index.html?i=live-1`,
            liveURLId: 'live-1',
            timeout: 60_000,
            browserExpiresAt: Date.now() + 30_000,
            targetId: 'target-1',
          }),
        );
      } else if (request.method === 'DELETE') {
        response.writeHead(204);
        response.end();
      } else response.end(JSON.stringify(state));
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
    const server = new FastMCP({
      name: 'live-view-test',
      version: '1.0.0',
      authenticate: async () => ({ token: 'fixture-token', apiUrl: base }),
    });
    registerSurface(server, {
      ...getConfig(),
      browserlessApiUrl: base,
      transport: 'httpStream',
      complianceMode: false,
      analyticsEnabled: false,
      maxRetries: 0,
    });
    const clients: Client[] = [];
    const connect = async (ui: boolean) => {
      const client = new Client(
        { name: 'live-host', version: '1.0.0' },
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
      const tool = (await ui.listTools()).tools.find(
        (tool) => tool.name === 'browserless_live_url',
      )!;
      assert.equal(
        (tool._meta?.ui as any)?.resourceUri,
        'ui://browserless/live-url/v1.html',
      );
      const resource = (
        await ui.readResource({ uri: 'ui://browserless/live-url/v1.html' })
      ).contents[0];
      assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
      assert.ok('text' in resource);
      widget = resource.text;
      // Four unrelated owners fill the entire shared store, across its owner quota.
      for (let index = 0; index < 16; index++)
        assert.ok(
          replayViews.prepareLogs(`other-${Math.floor(index / 4)}`, {
            entries: [],
            filters: {},
            nextCursor: null,
          }),
        );
      assert.equal(
        replayViews.prepareLogs('new-owner', {
          entries: [],
          filters: {},
          nextCursor: null,
        }),
        undefined,
      );
      const call = (action: string) =>
        ui.callTool({
          name: 'browserless_live_url',
          arguments: {
            action,
            browserId: 'browser-1',
            ...(action !== 'create' ? { liveURLId: 'live-1' } : {}),
          },
        });
      const created = await call('create');
      results.push(created);
      assert.ok(!created.isError, JSON.stringify(created));
      assert.equal((created.structuredContent as any)?.kind, 'live-url');
      assert.equal((created.structuredContent as any)?.action, 'create');
      assert.equal((created.structuredContent as any)?.liveURLId, 'live-1');
      assert.equal(
        (created._meta?.payload as any)?.liveURL,
        `${base}/e/abcdef/live/index.html?i=live-1`,
      );
      assert.ok(
        !JSON.stringify([created.content, created.structuredContent]).includes(
          '/live/',
        ),
      );
      assert.ok(!JSON.stringify(created).includes('fixture-token'));
      assert.equal(creates, 1);
      for (const action of ['status', 'close']) {
        const result = await call(action);
        results.push(result);
        assert.ok(!result.isError);
        assert.equal((result.structuredContent as any)?.action, action);
        assert.equal(result._meta?.payload, undefined);
        assert.deepEqual(
          JSON.parse((result.content as any)[0].text),
          action === 'status' ? state : { closed: true },
        );
      }
      assert.equal(creates, 1, 'lifecycle calls cannot mint viewers');
      const legacy = await connect(false);
      const plain = await legacy.callTool({
        name: 'browserless_live_url',
        arguments: { action: 'create', browserId: 'browser-1' },
      });
      assert.equal(plain.structuredContent, undefined);
      assert.equal(
        JSON.parse((plain.content as any)[0].text).liveURL,
        `${base}/e/abcdef/live/index.html?i=live-1`,
      );
      invalid = true;
      const rejected = await call('create');
      assert.ok(
        !rejected.isError,
        'an unembeddable URL must not fail an already successful create',
      );
      assert.equal(rejected._meta?.payload, undefined);
      assert.equal((rejected.structuredContent as any)?.action, 'unavailable');
      results.push(rejected);
      if (chrome) {
        const built = await build({
          stdin: {
            resolveDir: process.cwd(),
            contents: `
            import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
            const output = document.querySelector('pre');
            try {
              const results = await (await fetch('/results')).json();
              const frame = document.querySelector('iframe');
              const bridge = new AppBridge(null, { name: 'Test host', version: '1.0.0' }, {});
              const ready = new Promise(resolve => { bridge.oninitialized = resolve; });
              await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
              frame.src = '/widget'; await ready;
              async function show(result) {
                await bridge.sendToolResult(result);
                await new Promise(resolve => setTimeout(resolve, 100));
                return frame.contentDocument.querySelector('#live-url');
              }
              let root = await show(results[0]);
              const viewer = root.querySelector('iframe');
              if (root.hidden || viewer.hidden || !viewer.contentDocument?.querySelector('#viewer-ready'))
                throw new Error('Real create result did not mount its viewer');
              if (!frame.contentDocument.querySelector('.replay-card').hidden)
                throw new Error('Replay UI leaked into live viewer');
              if (new URL(viewer.src).pathname !== '/e/abcdef/live/index.html')
                throw new Error('Worker route lost');
              for (const result of results.slice(1)) {
                root = await show(result);
                if (root.hidden || root.querySelector('iframe[src]') || !root.querySelector('iframe').hidden)
                  throw new Error('Non-create result opened a viewer');
              }
              const expired = structuredClone(results[0]);
              expired.structuredContent.expiresAt = new Date(Date.now() - 1).toISOString();
              root = await show(expired);
              if (root.querySelector('iframe[src]') || !root.textContent.includes('expired'))
                throw new Error('Expired viewer was embedded');
              const invalid = structuredClone(results[0]);
              invalid._meta.payload.liveURL = 'javascript:alert(1)';
              root = await show(invalid);
              if (root.querySelector('iframe[src]')) throw new Error('Unsafe viewer was embedded');
              await show(results[0]);
              await bridge.sendToolCancelled({ reason: 'Cancelled live viewer' });
              await new Promise(resolve => setTimeout(resolve, 100));
              if (root.querySelector('iframe[src]')) throw new Error('Cancelled viewer stayed connected');
              const timed = structuredClone(results[0]);
              timed.structuredContent.expiresAt = new Date(Date.now() + 300).toISOString();
              root = await show(timed);
              await new Promise(resolve => setTimeout(resolve, 400));
              if (root.querySelector('iframe[src]') || !root.textContent.includes('expired'))
                throw new Error('Viewer remained connected after expiry');
              await bridge.teardownResource({});
              output.textContent = 'PASS: real create mounts; lifecycle, invalid, expired, cancelled results do not embed';
            } catch (error) { output.textContent = 'FAIL: ' + error.message; }
          `,
          },
          bundle: true,
          platform: 'browser',
          format: 'esm',
          write: false,
        });
        host = built.outputFiles[0].text;
        const directory = await mkdtemp(join(tmpdir(), 'live-url-browser-'));
        try {
          const { stdout } = await promisify(execFile)(
            chrome,
            [
              '--headless',
              '--no-sandbox',
              '--disable-gpu',
              '--no-first-run',
              `--user-data-dir=${directory}`,
              '--dump-dom',
              '--virtual-time-budget=10000',
              base,
            ],
            { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
          );
          assert.equal(
            /<pre>([\s\S]*?)<\/pre>/.exec(stdout)?.[1],
            'PASS: real create mounts; lifecycle, invalid, expired, cancelled results do not embed',
          );
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    } finally {
      await replayViews.clear();
      await Promise.allSettled(clients.map((client) => client.close()));
      await server.stop();
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });
});
