import { expect } from 'chai';
import { createServer, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrowserlessSession } from '../../src/@types/types.js';
import {
  authInputFromRequest,
  resolveBrowserlessAuth,
} from '../../src/lib/http-auth.js';
import {
  admitSessionRequest,
  requestSessionId,
} from '../../src/lib/session-binding.js';
import { clearResolverCache } from '../../src/lib/account-resolver.js';
import { BoundedEventStore } from '../../src/lib/bounded-event-store.js';

const A = 'synthetic-key-A';
const B = 'synthetic-key-B';
const notFound =
  '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}';
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for frame');
    await delay(10);
  }
};

function readFrames(response: Response) {
  const frames: { id?: string; event?: string; data: string }[] = [];
  const reader = response.body!.getReader();
  const done = (async () => {
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const lines = pending.slice(0, end).split('\n');
        pending = pending.slice(end + 2);
        const field = (name: string) =>
          lines
            .find((line) => line.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        frames.push({
          id: field('id'),
          event: field('event'),
          data: field('data') ?? '',
        });
      }
    }
  })();
  return {
    frames,
    close: async () => {
      await reader.cancel();
      await done;
    },
  };
}

async function fixture() {
  clearResolverCache();
  const stub = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/v1/user') {
      try {
        const claims = JSON.parse(
          Buffer.from(
            req.headers.authorization!.split('.')[1],
            'base64url',
          ).toString(),
        );
        res.end(
          JSON.stringify({
            id: claims.sub,
            app_metadata: { accountId: claims.account, role: 'owner' },
          }),
        );
      } catch {
        res.writeHead(401);
        res.end('{}');
      }
    } else if (req.url?.startsWith('/rest/v1/accounts?')) {
      res.end(JSON.stringify([{ api_key: A, email: 'fixture@local.dev' }]));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const cfg = {
    browserlessApiUrl: 'http://127.0.0.1:9',
    supabaseUrl: `http://127.0.0.1:${(stub.address() as { port: number }).port}`,
    supabaseServiceRoleKey: 'fixture',
  };
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  let calls = 0;
  const server = new FastMCP<BrowserlessSession>({
    name: 'session-binding',
    version: '1.0.0',
    authenticate: async (req) => {
      const auth = await resolveBrowserlessAuth(authInputFromRequest(req), cfg);
      admitSessionRequest(requestSessionId(req), auth, server.sessions);
      return auth;
    },
  });
  server.addTool({
    name: 'probe',
    description: 'Local probe',
    parameters: z.object({ wait: z.boolean().optional() }),
    execute: async ({ wait }, { log }) => {
      calls++;
      log.info('probe ran');
      if (wait) await delay(300);
      return 'ok';
    },
  });
  const streams: ReturnType<typeof readFrames>[] = [];
  const store = new BoundedEventStore();
  await server.start({
    transportType: 'httpStream',
    httpStream: {
      host: '127.0.0.1',
      port,
      eventStore: store,
    },
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = (sid: string, key?: string) => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
    ...(sid ? { 'mcp-session-id': sid } : {}),
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  });
  const post = (
    sid: string,
    key: string | undefined,
    method = 'tools/list',
    params: object = {},
    id: number | undefined = 2,
    query = '',
  ) =>
    fetch(url + query, {
      method: 'POST',
      headers: headers(sid, key),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  const initialize = async (key: string) => {
    const response = await post('', key, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'binding', version: '1' },
    });
    expect(response.status).to.equal(200);
    const sid = response.headers.get('mcp-session-id')!;
    await response.text();
    const initialized = await fetch(url, {
      method: 'POST',
      headers: headers(sid, key),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    expect(initialized.status).to.equal(202);
    return sid;
  };
  const get = (sid: string, key?: string, cursor?: string) =>
    fetch(url, {
      headers: {
        ...headers(sid, key),
        ...(cursor ? { 'Last-Event-ID': cursor } : {}),
      },
    });
  const track = (response: Response) => {
    expect(response.status).to.equal(200);
    const stream = readFrames(response);
    streams.push(stream);
    return stream;
  };
  return {
    url,
    store,
    headers,
    post,
    initialize,
    get,
    track,
    notifyStandalone: () =>
      server.sessions[0].server.sendLoggingMessage({
        level: 'info',
        data: 'standalone probe',
      }),
    calls: () => calls,
    remove: (sid: string, key?: string) =>
      fetch(url, { method: 'DELETE', headers: headers(sid, key) }),
    close: async () => {
      for (const stream of streams) await stream.close().catch(() => {});
      for (const session of [...server.sessions]) await session.close();
      await server.stop();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
      clearResolverCache();
    },
  };
}

describe('session request identity', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f.close();
  });

  for (const [key, status] of [
    [undefined, 401],
    [B, 404],
  ] as const) {
    it(`keeps the opening identity's live channel when a resume answers ${status}`, async () => {
      const sid = await f.initialize(A);
      await (
        await f.post(sid, A, 'logging/setLevel', { level: 'debug' })
      ).text();
      const live = f.track(await f.get(sid, A));
      const denied = await f.get(sid, key, '_GET_stream_1_0_x');
      expect(denied.status).to.equal(status);
      expect(await denied.text()).not.to.include('data:');
      const result = await (
        await f.post(sid, A, 'tools/call', { name: 'probe', arguments: {} })
      ).text();
      expect(result).to.include('"text":"ok"');
      expect(result).to.include('probe ran');
      // Tool logs now use the POST stream; probe the GET channel separately.
      await f.notifyStandalone();
      await waitFor(() =>
        live.frames.some((frame) => frame.data.includes('standalone probe')),
      );
    });
  }

  const jwt = (sub: string, account: string, jti: string) =>
    `e30.${Buffer.from(JSON.stringify({ sub, account, jti })).toString('base64url')}.test`;
  for (const { label, ownerKey, refreshedKey, foreignKeys } of [
    { label: 'API keys', ownerKey: A, refreshedKey: A, foreignKeys: [B, 'x'] },
    {
      label: 'OAuth users',
      ownerKey: jwt('u1', 'account1', 'original'),
      refreshedKey: jwt('u1', 'account1', 'refreshed'),
      foreignKeys: [
        jwt('u2', 'account1', 'other-user'),
        jwt('u1', 'account2', 'other-account'),
        A,
      ],
    },
  ]) {
    it(`replays offline results only for the opening identity and session (${label})`, async () => {
      const a = await f.initialize(ownerKey),
        b = await f.initialize(foreignKeys[0]),
        otherOwnerSession = await f.initialize(refreshedKey);
      const original = f.track(
        await f.post(
          a,
          ownerKey,
          'tools/call',
          { name: 'probe', arguments: { wait: true } },
          42,
        ),
      );
      await waitFor(() => original.frames.some((frame) => frame.id));
      const cursor = original.frames[0].id!;
      expect(cursor).to.be.a('string').and.not.empty;
      expect(
        original.frames.some((frame) => frame.data.includes('"id":42')),
      ).to.equal(false);
      const retained = f.store.size;
      await original.close();
      await waitFor(() => f.store.size > retained);
      for (const key of [undefined, ...foreignKeys]) {
        const denied = await f.get(a, key, cursor);
        expect(denied.status).to.equal(key === undefined ? 401 : 404);
        expect(await denied.text()).not.to.include('"result"');
      }
      for (const [session, key, replayCursor] of [
        [b, foreignKeys[0], cursor],
        [otherOwnerSession, refreshedKey, cursor],
        [a, refreshedKey, 'unknown-cursor'],
      ]) {
        const denied = await f.get(session, key, replayCursor);
        expect(denied.status).to.equal(400);
        expect(await denied.text()).not.to.include('"result"');
      }
      const owner = f.track(await f.get(a, refreshedKey, cursor));
      await waitFor(() =>
        owner.frames.some((frame) => frame.data.includes('"id":42')),
      );
      expect(
        JSON.parse(
          owner.frames.find((frame) => frame.data.includes('"id":42'))!.data,
        ).result,
      ).to.deep.equal({ content: [{ type: 'text', text: 'ok' }] });
      await delay(100);
      expect(f.calls()).to.equal(1);
    });
  }

  it('admits calls and termination only for the opening identity', async () => {
    const sid = await f.initialize(A);
    const denied = await f.post(sid, B, 'tools/call', {
      name: 'probe',
      arguments: {},
    });
    expect(denied.status).to.equal(404);
    expect(f.calls()).to.equal(0);
    expect((await f.remove(sid)).status).to.equal(401);
    expect((await f.remove(sid, B)).status).to.equal(404);
    const listed = await f.post(sid, A);
    expect(listed.status).to.equal(200);
    await listed.text();
    expect((await f.remove(sid, A)).status).to.equal(200);
    expect((await f.post(sid, A)).status).to.equal(404);
  });

  it('uses identical not-found responses for unknown and other-identity sessions', async () => {
    const sid = await f.initialize(A);
    for (const id of [sid, '00000000-0000-4000-8000-000000000000']) {
      for (const response of [
        await f.post(id, B),
        await f.get(id, B),
        await f.remove(id, B),
      ]) {
        expect(response.status).to.equal(404);
        expect(response.statusText).to.equal('Not Found');
        expect(response.headers.get('content-type')).to.equal(
          'application/json',
        );
        expect(await response.text()).to.equal(notFound);
      }
    }
  });

  it('keeps refreshed OAuth tokens bound to the same account and user', async () => {
    const jwt = (sub: string, jti: string) =>
      `e30.${Buffer.from(JSON.stringify({ sub, account: 'account-binding', jti })).toString('base64url')}.test`;
    const sid = await f.initialize(jwt('u1', 'one'));
    const listed = await f.post(sid, jwt('u1', 'two'));
    expect(listed.status).to.equal(200);
    await listed.text();
    const stream = await f.get(sid, jwt('u1', 'three'));
    expect(stream.status).to.equal(200);
    await stream.body?.cancel();
    expect((await f.post(sid, jwt('u2', 'four'))).status).to.equal(404);
    expect((await f.post(sid, A)).status).to.equal(404);
  });

  it('accepts the opening key through the query parameter', async () => {
    const sid = await f.initialize(A);
    const listed = await f.post(
      sid,
      undefined,
      'tools/list',
      {},
      2,
      `?token=${A}`,
    );
    expect(listed.status).to.equal(200);
    await listed.text();
  });

  it('supports SDK clients including the standalone stream', async () => {
    const client = new Client({ name: 'binding-sdk', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(f.url), {
      requestInit: { headers: { Authorization: `Bearer ${B}` } },
    });
    const errors: Error[] = [];
    try {
      await client.connect(transport);
      transport.onerror = (error) => errors.push(error);
      expect((await client.listTools()).tools.map((t) => t.name)).to.include(
        'probe',
      );
      await delay(800);
      expect(errors).to.deep.equal([]);
    } finally {
      await client.close();
    }
  });

  it('answers malformed session and credential inputs without disrupting the session', async () => {
    const sid = await f.initialize(A);
    for (const [id, key] of [
      ['x'.repeat(10000), A],
      ['not-a-uuid', A],
      [sid, ''],
      [sid, 'a.b.c'],
    ]) {
      const response = await fetch(f.url, {
        headers: { ...f.headers(id, A), Authorization: `Bearer ${key}` },
      });
      expect(response.status).to.be.within(400, 499);
      await response.text();
    }
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        f.url,
        { headers: { ...f.headers('', A), 'mcp-session-id': [sid, 'other'] } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).to.be.within(400, 499);
    const listed = await f.post(sid, A);
    expect(listed.status).to.equal(200);
    await listed.text();
  });
});
