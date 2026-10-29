import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../../src/config.js';
import { registerSurface } from '../../src/tools/register.js';
import {
  clearHandoffs,
  prepareHandoff,
  findHandoff,
  readHandoff,
} from '../../src/lib/handoff.js';
import { createApiClient } from '../../src/lib/api-client.js';
import {
  getOrCreateSession,
  closeSessionByHandle,
  send,
} from '../../src/lib/agent-client.js';

const text = (result: any) => JSON.stringify(result.content);
const ref = (result: any) => text(result).match(/view_[a-f0-9-]+/)?.[0];

describe('direct agent human handoff over MCP', () => {
  it('pauses the owned browser, renders without reminting, and resumes only after backend confirmation', async () => {
    let connections = 0,
      minted = 0,
      reads = 0,
      closedLinks = 0;
    let rejectClose = false,
      rejectMint = false;
    const commands: string[] = [];
    const states = new Map<string, any>();
    const backend = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture');
      if (url.pathname.startsWith('/browser/browser-1/live/')) {
        const id = url.pathname.split('/').at(-1)!;
        if (request.method === 'DELETE') {
          if (rejectClose) {
            response.writeHead(503);
            response.end();
            return;
          }
          closedLinks++;
          states.set(id, {
            ...states.get(id),
            status: 'closed',
            reason: 'closed',
            viewerCount: 0,
          });
          response.writeHead(204);
          response.end();
          return;
        }
        reads++;
        const state = states.get(id);
        response.writeHead(state ? 200 : 404, {
          'content-type': 'application/json',
        });
        response.end(JSON.stringify(state ?? { message: 'Not found' }));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    const sockets = new WebSocketServer({ noServer: true });
    backend.on('upgrade', (request, socket, head) =>
      sockets.handleUpgrade(request, socket, head, (ws) => {
        connections++;
        ws.on('message', (bytes) => {
          const message = JSON.parse(String(bytes));
          commands.push(message.method);
          let result: any = {
            url: 'https://example.com/',
            title: 'Same browser',
            elements: [],
          };
          if (message.method === 'liveURL') {
            if (rejectMint) {
              ws.send(
                JSON.stringify({
                  id: message.id,
                  error: {
                    message: 'A human handoff is already active for this page.',
                  },
                }),
              );
              return;
            }
            const id = `live-${++minted}`;
            states.set(id, {
              status: 'open',
              reason: null,
              interactable: true,
              viewerCount: 0,
              expiresAt: Date.now() + 60_000,
            });
            result = {
              browserId: 'browser-1',
              liveURLId: id,
              liveURL: `http://127.0.0.1:${(backend.address() as AddressInfo).port}/live/index.html?i=${id}`,
              timeout: 60_000,
              browserExpiresAt: Date.now() + 120_000,
            };
          }
          if (message.method === 'getDownloads') result = { downloads: [] };
          ws.send(JSON.stringify({ id: message.id, result }));
        });
      }),
    );
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
      browserlessToken: undefined,
      browserlessApiUrl: base,
      transport: 'httpStream' as const,
      mcpBaseUrl: `http://127.0.0.1:${port}`,
      complianceMode: false,
      analyticsEnabled: false,
      maxRetries: 0,
    };
    const server = new FastMCP({
      name: 'Handoff fixture',
      version: '1.0.0',
      authenticate: async (request) => ({
        token: 'fixture-key',
        apiUrl: base,
        authMethod: 'oauth',
        accountId: 'account',
        userId: request.headers.authorization?.slice(7) ?? 'alice',
      }),
    });
    registerSurface(server, config);
    const clients: Client[] = [];
    async function connect(user = 'alice', ui = true) {
      const client = new Client(
        { name: 'Handoff client', version: '1.0' },
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
        new StreamableHTTPClientTransport(new URL(config.mcpBaseUrl + '/mcp'), {
          requestInit: { headers: { Authorization: 'Bearer ' + user } },
        }),
      );
      return client;
    }
    try {
      await server.start({
        transportType: 'httpStream',
        httpStream: { host: '127.0.0.1', port },
      });
      const alice = await connect();
      const opened = await alice.callTool({
        name: 'browserless_agent',
        arguments: {
          method: 'goto',
          params: { url: 'https://example.com/' },
          keepSessionAlive: true,
        },
      });
      assert.ok(!opened.isError, text(opened));
      const handle = text(opened).match(/s:[a-f0-9-]+/)?.[0];
      assert.ok(handle);
      const prepared = await alice.callTool({
        name: 'browserless_live_url',
        arguments: {
          action: 'handoff',
          sessionId: handle,
          instructions: 'Enter the code, then choose Done.',
        },
      });
      assert.ok(!prepared.isError, text(prepared));
      const first = ref(prepared);
      assert.ok(first);
      assert.equal(/live-1|\/live\/|fixture-key/.test(text(prepared)), false);
      async function snapshot() {
        return alice.callTool({
          name: 'browserless_agent',
          arguments: { method: 'snapshot', sessionId: handle },
        });
      }
      const before = commands.length;
      assert.equal((await snapshot()).isError, true);
      assert.equal(commands.length, before);
      assert.equal(connections, 1);
      for (let i = 0; i < 2; i++) {
        const shown = await alice.callTool({
          name: 'browserless_show',
          arguments: { viewRef: first },
        });
        assert.ok(!shown.isError, text(shown));
        assert.equal((shown.structuredContent as any).kind, 'handoff');
        assert.ok((shown._meta!.payload as any).liveURL.includes('/live/'));
        assert.equal(
          JSON.stringify(shown.structuredContent).includes('/live/'),
          false,
        );
      }
      assert.equal(minted, 1);
      const bob = await connect('bob'),
        priorReads = reads;
      assert.equal(
        (
          await bob.callTool({
            name: 'browserless_show',
            arguments: { viewRef: first },
          })
        ).isError,
        true,
      );
      assert.equal(reads, priorReads);
      assert.equal(
        (
          await bob.callTool({
            name: 'browserless_live_url',
            arguments: {
              action: 'handoff',
              sessionId: handle,
              instructions: 'Foreign handoff',
            },
          })
        ).isError,
        true,
      );
      assert.equal(
        minted,
        1,
        'another user cannot hand off the shared account’s browser',
      );
      const reconnect = await connect();
      assert.ok(
        !(
          await reconnect.callTool({
            name: 'browserless_handoff_state',
            arguments: { viewRef: first },
          })
        ).isError,
      );
      states.set('live-1', {
        ...states.get('live-1'),
        status: 'closed',
        reason: 'userDone',
        viewerCount: 0,
      });
      const done = await alice.callTool({
        name: 'browserless_live_url',
        arguments: { action: 'handoff_status', viewRef: first },
      });
      assert.ok(!done.isError, text(done));
      assert.ok(text(done).includes('userDone'));
      assert.ok(!(await snapshot()).isError);
      assert.equal(connections, 1);
      const repeated = await Promise.all(
        [0, 1].map(() =>
          alice.callTool({
            name: 'browserless_live_url',
            arguments: {
              action: 'handoff',
              sessionId: handle,
              instructions: 'Do the next human step.',
            },
          }),
        ),
      );
      assert.equal(
        repeated.filter((result) => !result.isError).length,
        1,
        'concurrent creation must mint only one new handoff',
      );
      assert.equal(minted, 2);
      const secondResult = repeated.find((result) => !result.isError)!;
      const second = ref(secondResult);
      assert.ok(second);
      await alice.callTool({
        name: 'browserless_handoff_state',
        arguments: { viewRef: first },
      });
      assert.equal(
        (await snapshot()).isError,
        true,
        'old completion cannot unlock the new handoff',
      );
      states.set('live-2', {
        ...states.get('live-2'),
        status: 'closed',
        reason: 'userFailed',
      });
      await alice.callTool({
        name: 'browserless_handoff_state',
        arguments: { viewRef: second },
      });
      assert.equal(
        (await snapshot()).isError,
        true,
        'failed handoff cannot resume automation',
      );
      const noUi = await connect('alice', false),
        oldMinted = minted;
      assert.equal(
        (
          await noUi.callTool({
            name: 'browserless_live_url',
            arguments: {
              action: 'handoff',
              sessionId: handle,
              instructions: 'Do not create a hidden handoff.',
            },
          })
        ).isError,
        true,
      );
      assert.equal(minted, oldMinted);
      assert.equal(connections, 1);
      const closingHandoff = await alice.callTool({
        name: 'browserless_live_url',
        arguments: {
          action: 'handoff',
          sessionId: handle,
          instructions: 'This handoff will be explicitly cancelled.',
        },
      });
      assert.ok(!closingHandoff.isError, text(closingHandoff));
      const closingRef = ref(closingHandoff)!;
      for (const socket of sockets.clients) socket.terminate();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        (await snapshot()).isError,
        true,
        'disconnected handoff must not launch a replacement',
      );
      assert.equal(connections, 1);
      const close = () =>
        alice.callTool({
          name: 'browserless_agent',
          arguments: { method: 'close', sessionId: handle },
        });
      rejectClose = true;
      assert.equal(
        (await close()).isError,
        true,
        'failed viewer cancellation must not report a successful close',
      );
      assert.equal((await snapshot()).isError, true);
      rejectClose = false;
      const closed = await close();
      assert.ok(!closed.isError, text(closed));
      assert.equal(closedLinks, 1);
      assert.equal(states.get('live-3').reason, 'closed');
      const ended = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef: closingRef },
      });
      assert.ok(!ended.isError, text(ended));
      assert.equal((ended._meta!.payload as any).state.reason, 'closed');
      assert.equal((ended._meta!.payload as any).liveURL, undefined);
      const endedStatus = await alice.callTool({
        name: 'browserless_handoff_state',
        arguments: { viewRef: closingRef },
      });
      assert.equal((endedStatus.structuredContent as any).status, 'closed');
      assert.deepEqual(
        JSON.parse(
          (endedStatus.content as any[]).find((block) => block.type === 'text')
            .text,
        ),
        endedStatus.structuredContent,
        'status remains readable when a host forwards text without structuredContent',
      );
      const reopened = await alice.callTool({
        name: 'browserless_agent',
        arguments: {
          method: 'goto',
          params: { url: 'https://example.com/' },
          sessionId: handle,
          keepSessionAlive: true,
        },
      });
      assert.ok(!reopened.isError, text(reopened));
      assert.equal(connections, 2);
      const next = await alice.callTool({
        name: 'browserless_live_url',
        arguments: {
          action: 'handoff',
          sessionId: handle,
          instructions: 'New handoff after explicit close.',
        },
      });
      assert.ok(!next.isError, text(next));
      assert.equal(minted, 4);
      assert.equal(
        (
          await alice.callTool({
            name: 'browserless_handoff_state',
            arguments: { viewRef: closingRef },
          })
        ).isError,
        true,
        'a new handoff retires cancelled references without unlocking it',
      );
      assert.equal((await snapshot()).isError, true);
      assert.ok(!(await close()).isError);
      assert.ok(!(await snapshot()).isError);
      rejectMint = true;
      const orphaned = await alice.callTool({
        name: 'browserless_live_url',
        arguments: {
          action: 'handoff',
          sessionId: handle,
          instructions: 'An old backend viewer survived the MCP process.',
        },
      });
      assert.equal(orphaned.isError, true);
      assert.ok(
        text(orphaned).includes('earlier human handoff is still active'),
      );
      assert.ok(
        text(orphaned).includes('Never ask the user to paste passwords'),
      );
      assert.ok(!(await snapshot()).isError);
    } finally {
      clearHandoffs();
      await Promise.allSettled(clients.map((client) => client.close()));
      await server.stop();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });
});

describe('handoff compatibility with older Docker runtimes', () => {
  it('replaces the legacy capability, resolves only its page, and keeps API requests local', async () => {
    let minted = 0;
    let connections = 0;
    let ambiguous = false;
    let reuseId = false;
    const commands: string[] = [];
    const deleted: string[] = [];
    const backend = createServer((request, response) => {
      const path = new URL(request.url!, 'http://fixture').pathname;
      response.setHeader('content-type', 'application/json');
      if (path === '/sessions') {
        response.end(
          JSON.stringify([
            { id: 'unrelated', browserId: 'other-browser' },
            { id: 'page-1', browserId: 'browser-1' },
            ...(ambiguous
              ? [{ id: 'page-1', browserId: 'other-browser' }]
              : []),
          ]),
        );
      } else if (path.startsWith('/browser/browser-1/live/')) {
        if (request.method === 'DELETE') {
          deleted.push(path);
          response.writeHead(204);
          response.end();
        } else
          response.end(
            JSON.stringify({
              status: 'open',
              reason: null,
              interactable: true,
              viewerCount: 0,
              expiresAt: Date.now() + 60_000,
            }),
          );
      } else {
        response.writeHead(404);
        response.end('{}');
      }
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, '127.0.0.1', resolve),
    );
    const base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const sockets = new WebSocketServer({ noServer: true });
    backend.on('upgrade', (request, socket, head) =>
      sockets.handleUpgrade(request, socket, head, (ws) => {
        connections++;
        ws.on('message', (bytes) => {
          const message = JSON.parse(String(bytes));
          commands.push(message.method);
          if (message.method === 'liveURL') minted++;
          const id = `live-${reuseId ? 1 : minted}`;
          ws.send(
            JSON.stringify({
              id: message.id,
              result:
                message.method === 'liveURL'
                  ? {
                      targetId: 'page-1',
                      liveURLId: id,
                      liveURL: `${base}/live/index.html?i=${id}`,
                      timeout: 60_000,
                      browserExpiresAt: Date.now() + 120_000,
                    }
                  : {},
            }),
          );
        });
      }),
    );
    let session = await getOrCreateSession(
      'legacy-handoff',
      base,
      'legacy-test-token',
    );
    const client = createApiClient({
      ...getConfig(),
      browserlessToken: 'legacy-test-token',
      browserlessApiUrl: base,
      maxRetries: 0,
    });
    try {
      await assert.rejects(
        prepareHandoff(
          session,
          'owner',
          client,
          'Verify',
          60_000,
          'http://public.example',
        ),
        /Invalid public/,
      );
      assert.deepEqual(
        commands,
        [],
        'invalid public configuration cannot mint a link',
      );
      const prepared = await prepareHandoff(
        session,
        'owner',
        client,
        'Verify',
        60_000,
        'https://viewer.example',
      );
      assert.deepEqual(commands, ['liveURL', 'closeLiveURL', 'liveURL']);
      assert.equal(connections, 1, 'compatibility uses the owned socket');
      const view = findHandoff(prepared.viewRef, 'owner')!;
      assert.equal(
        view.liveURL,
        'https://viewer.example/live/index.html?i=live-2',
      );
      assert.equal(view.browserId, 'browser-1');
      assert.equal(view.liveURLId, 'live-2');
      assert.equal((await readHandoff(view, client)).status, 'open');
      await assert.rejects(send(session, 'snapshot'), /human handoff owns/);
      await closeSessionByHandle(session.handle, 'legacy-test-token');
      assert.deepEqual(deleted, ['/browser/browser-1/live/live-2']);
      const next = await getOrCreateSession(
        'legacy-handoff',
        base,
        'legacy-test-token',
      );
      session = next;
      ambiguous = true;
      await assert.rejects(
        prepareHandoff(next, 'owner', client, 'Verify'),
        /cannot resolve/,
      );
      assert.equal(
        (await send(next, 'snapshot')).error,
        undefined,
        'failed resolution releases the guard',
      );
      ambiguous = false;
      reuseId = true;
      await assert.rejects(
        prepareHandoff(next, 'owner', client, 'Verify'),
        /target changed/,
      );
      assert.deepEqual(commands.slice(-3), [
        'closeLiveURL',
        'liveURL',
        'closeLiveURL',
      ]);
      assert.equal((await send(next, 'snapshot')).error, undefined);
    } finally {
      await closeSessionByHandle(session.handle, 'legacy-test-token');
      clearHandoffs();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
  });
});
