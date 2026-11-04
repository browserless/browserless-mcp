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
  requestSessions,
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
      admitSessionRequest(
        requestSessionId(req),
        auth,
        requestSessions(req, server.sessions),
      );
      return auth;
    },
  });
  server.addTool({
    name: 'probe',
    description: 'Local probe',
    parameters: z.object({}),
    execute: async (_args, { log }) => {
      calls++;
      log.info('probe ran');
      return 'ok';
    },
  });
  const streams: ReturnType<typeof readFrames>[] = [];
  await server.start({
    transportType: 'httpStream',
    httpStream: {
      host: '127.0.0.1',
      port,
      eventStore: new BoundedEventStore(),
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

  it('replays request results only for the opening identity and session', async () => {
    const a = await f.initialize(A),
      b = await f.initialize(B);
    const original = f.track(
      await f.post(a, A, 'tools/call', { name: 'probe', arguments: {} }, 42),
    );
    await waitFor(() =>
      original.frames.some((frame) => frame.data.includes('"id":42')),
    );
    const cursor = original.frames[0].id!;
    expect(cursor).to.be.a('string').and.not.empty;
    for (const [key, status] of [
      [undefined, 401],
      [B, 404],
      ['x', 404],
    ] as const) {
      const denied = await f.get(a, key, cursor);
      expect(denied.status).to.equal(status);
      expect(await denied.text()).not.to.include('"result"');
    }
    const other = f.track(await f.get(b, B, cursor));
    const owner = f.track(await f.get(a, A, cursor));
    await waitFor(() =>
      owner.frames.some((frame) => frame.data.includes('"id":42')),
    );
    expect(
      JSON.parse(
        owner.frames.find((frame) => frame.data.includes('"id":42'))!.data,
      ).result,
    ).to.deep.equal({ content: [{ type: 'text', text: 'ok' }] });
    await delay(100);
    expect(other.frames).to.deep.equal([]);
  });

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

  it('requires the opening identity for legacy SSE message posts', async () => {
    const stream = f.track(
      await fetch(f.url.replace('/mcp', `/sse?token=${A}`)),
    );
    await waitFor(() =>
      stream.frames.some((frame) => frame.event === 'endpoint'),
    );
    const endpoint = new URL(
      stream.frames.find((frame) => frame.event === 'endpoint')!.data,
      f.url,
    );
    const denied = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 90,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'sse', version: '1' },
        },
      }),
    });
    expect(denied.status).to.equal(401);
    expect(await denied.json()).to.have.nested.property('error.code', -32000);
    const send = (
      target: URL,
      key: string | undefined,
      id: number | undefined,
      method = 'tools/call',
      params: object = { name: 'probe', arguments: {} },
    ) =>
      fetch(target, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    // Refusals also identify the opening session before initialize completes.
    const firstOther = await send(endpoint, B, 91);
    expect(firstOther.status).to.equal(404);
    expect(await firstOther.text()).to.equal(notFound);
    for (const [id, method, params] of [
      [
        1,
        'initialize',
        {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'sse', version: '1' },
        },
      ],
      [2, 'tools/list', {}],
    ] as const) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${A}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      expect(response.status).to.equal(202);
      await waitFor(() =>
        stream.frames.some((frame) => frame.data.includes(`"id":${id}`)),
      );
    }
    expect(
      stream.frames.find((frame) => frame.data.includes('"id":2'))!.data,
    ).to.include('probe');
    expect(
      (await send(endpoint, A, undefined, 'notifications/initialized', {}))
        .status,
    ).to.equal(202);
    expect((await send(endpoint, A, 3)).status).to.equal(202);
    await waitFor(() =>
      stream.frames.some((frame) => frame.data.includes('"id":3')),
    );
    expect(f.calls()).to.equal(1);
    for (const [key, status, id] of [
      [undefined, 401, 92],
      [B, 404, 93],
      ['a.b.c', 401, 94],
    ] as const) {
      const response = await send(endpoint, key, id);
      expect(response.status).to.equal(status);
      if (status === 404) expect(await response.text()).to.equal(notFound);
      else
        expect(await response.json()).to.have.nested.property(
          'error.code',
          -32000,
        );
    }
    for (const sid of ['unknown', 'x'.repeat(10000)]) {
      const target = new URL(endpoint);
      target.searchParams.set('sessionId', sid);
      const response = await send(target, A, 95);
      expect(response.status).to.equal(404);
      expect(await response.text()).to.equal(notFound);
    }
    const prefix = new URL(endpoint);
    prefix.pathname = '/messagesX';
    const otherPrefix = await send(prefix, B, 96);
    expect(otherPrefix.status).to.equal(404);
    expect(await otherPrefix.text()).to.equal(notFound);
    expect((await send(prefix, A, 4, 'tools/list', {})).status).to.equal(202);
    const duplicate = new URL(endpoint);
    duplicate.searchParams.append('sessionId', 'unknown');
    expect((await send(duplicate, A, 5, 'tools/list', {})).status).to.equal(
      202,
    );
    const query = new URL(endpoint);
    query.searchParams.set('token', B);
    expect((await send(query, undefined, 97)).status).to.equal(404);
    query.searchParams.set('token', A);
    expect((await send(query, undefined, 6, 'tools/list', {})).status).to.equal(
      202,
    );
    for (const value of ['', undefined]) {
      const target = new URL(endpoint);
      if (value === undefined) target.searchParams.delete('sessionId');
      else target.searchParams.set('sessionId', value);
      expect((await send(target, A, 98)).status).to.equal(400);
      expect((await send(target, undefined, 99)).status).to.equal(401);
    }
    expect(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${A}`,
          },
          body: '{',
        })
      ).status,
    ).to.equal(400);
    expect((await send(endpoint, A, 7, 'tools/list', {})).status).to.equal(202);
    await waitFor(() =>
      stream.frames.some((frame) => frame.data.includes('"id":7')),
    );
    await delay(500);
    expect(
      stream.frames
        .filter((frame) => frame.event === 'message')
        .some((frame) => JSON.parse(frame.data).id >= 90),
    ).to.equal(false);
    expect(f.calls()).to.equal(1);
  });

  it('accepts refreshed OAuth identities on legacy SSE posts', async () => {
    const jwt = (sub: string, jti: string) =>
      `e30.${Buffer.from(JSON.stringify({ sub, account: 'account-binding', jti })).toString('base64url')}.test`;
    const stream = f.track(
      await fetch(f.url.replace('/mcp', '/sse'), {
        headers: { Authorization: `Bearer ${jwt('u1', 'one')}` },
      }),
    );
    await waitFor(() =>
      stream.frames.some((frame) => frame.event === 'endpoint'),
    );
    const endpoint = new URL(
      stream.frames.find((frame) => frame.event === 'endpoint')!.data,
      f.url,
    );
    const post = (key: string, id: number, method: string, params: object) =>
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
    expect(
      (
        await post(jwt('u1', 'two'), 1, 'initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'sse', version: '1' },
        })
      ).status,
    ).to.equal(202);
    await waitFor(() =>
      stream.frames.some((frame) => frame.data.includes('"id":1')),
    );
    expect(
      (await post(jwt('u1', 'three'), 2, 'tools/list', {})).status,
    ).to.equal(202);
    await waitFor(() =>
      stream.frames.some((frame) => frame.data.includes('"id":2')),
    );
    const denied = await post(jwt('u2', 'four'), 3, 'tools/call', {
      name: 'probe',
      arguments: {},
    });
    expect(denied.status).to.equal(404);
    expect(await denied.text()).to.equal(notFound);
    expect(f.calls()).to.equal(0);
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
