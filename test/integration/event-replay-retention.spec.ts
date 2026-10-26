import { expect } from 'chai';
import { createConnection, createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { BoundedEventStore } from '../../src/lib/bounded-event-store.js';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const waitFor = async (condition: () => boolean, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for frame');
    await delay(20);
  }
};

type Frame = { id?: string; data: Record<string, unknown> };
const readFrames = (response: Response) => {
  const frames: Frame[] = [];
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
        const data = lines
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim();
        frames.push({
          id: lines
            .find((line) => line.startsWith('id:'))
            ?.slice(3)
            .trim(),
          data: data ? JSON.parse(data) : {},
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
};

async function fixture(store = new BoundedEventStore()) {
  const port = await freePort();
  const server = new FastMCP({ name: 'event-retention', version: '1.0.0' });
  for (const name of ['noop', 'slow'])
    server.addTool({
      name,
      description: name,
      parameters: z.object({}),
      execute: async () => {
        if (name === 'slow') await delay(1500);
        return 'ok';
      },
    });
  await server.start({
    transportType: 'httpStream',
    httpStream: { port, host: 'localhost', eventStore: store },
  });
  const url = `http://localhost:${port}/mcp`;
  const streams: ReturnType<typeof readFrames>[] = [];
  const headers = (session = '') => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
    ...(session ? { 'mcp-session-id': session } : {}),
  });
  const post = (
    session: string,
    method: string,
    id: number,
    params: object = {},
  ) =>
    fetch(url, {
      method: 'POST',
      headers: headers(session),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  const initialize = async () => {
    const response = await post('', 'initialize', 1, {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'retention-test', version: '1' },
    });
    expect(response.status).to.equal(200);
    const session = response.headers.get('mcp-session-id')!;
    await response.text();
    await fetch(url, {
      method: 'POST',
      headers: headers(session),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    return session;
  };
  const track = (response: Response) => {
    expect(response.status).to.equal(200);
    const stream = readFrames(response);
    streams.push(stream);
    return stream;
  };
  const get = async (session: string, cursor?: string) =>
    track(
      await fetch(url, {
        headers: {
          ...headers(session),
          ...(cursor ? { 'Last-Event-ID': cursor } : {}),
        },
      }),
    );
  return {
    server,
    port,
    url,
    post,
    initialize,
    get,
    track,
    headers,
    close: async () => {
      await Promise.all(
        streams.map((stream) => stream.close().catch(() => {})),
      );
      await server.stop();
    },
  };
}

describe('event store retention', () => {
  it('keeps event ids on standalone-stream frames', async () => {
    const f = await fixture();
    try {
      const stream = await f.get(await f.initialize());
      await waitFor(() =>
        stream.frames.some((frame) => frame.data.method === 'ping'),
      );
      expect(
        stream.frames.find((frame) => frame.data.method === 'ping')!.id,
      ).to.match(/^_GET_stream_/);
    } finally {
      await f.close();
    }
  });

  it('replays nothing when a standalone stream is resumed', async () => {
    const f = await fixture();
    try {
      const session = await f.initialize();
      const stream = await f.get(session);
      await waitFor(() =>
        stream.frames.some((frame) => frame.data.method === 'ping'),
      );
      const cursor = stream.frames.find(
        (frame) => frame.data.method === 'ping',
      )!.id!;
      await stream.close();
      const other = await f.initialize();
      const otherStream = await f.get(other);
      await f.server.sessions[1].server.sendLoggingMessage({
        level: 'debug',
        data: 'from-A',
      });
      await waitFor(() =>
        otherStream.frames.some((frame) => frame.data.method === 'ping'),
      );
      const resumed = await f.get(session, cursor);
      await delay(2000);
      expect(
        resumed.frames.filter((frame) =>
          ['ping', 'notifications/message'].includes(String(frame.data.method)),
        ),
      ).to.deep.equal([]);
      await f.server.sessions[0].server.sendLoggingMessage({
        level: 'debug',
        data: 'from-B',
      });
      await waitFor(
        () =>
          resumed.frames.some(
            (frame) => frame.data.method === 'notifications/message',
          ),
        2000,
      );
      expect(resumed.frames.at(-1)!.data.params).to.deep.equal({
        level: 'debug',
        data: 'from-B',
      });
    } finally {
      await f.close();
    }
  });

  it('reattaches a client after a half-open disconnect', async () => {
    const f = await fixture();
    const pairs: { client: Socket; upstream: Socket; halfOpen: boolean }[] = [];
    const proxy = createServer((client) => {
      const upstream = createConnection({ port: f.port, host: 'localhost' });
      const pair = { client, upstream, halfOpen: false };
      pairs.push(pair);
      client.pipe(upstream).pipe(client);
      client.on('error', () => {});
      upstream.on('error', () => {});
      client.on('close', () => {
        if (!pair.halfOpen) upstream.destroy();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, resolve));
    const port = (proxy.address() as { port: number }).port;
    const client = new Client(
      { name: 'retention-client', version: '1' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
    );
    const errors: string[] = [];
    let received = 0;
    client.setNotificationHandler(LoggingMessageNotificationSchema, () => {
      received++;
    });
    try {
      await client.connect(transport);
      client.onerror = (error) => errors.push(error.message);
      await delay(6000);
      expect(
        (await client.callTool({ name: 'noop', arguments: {} })).isError,
      ).not.to.equal(true);
      for (const pair of pairs) {
        pair.halfOpen = true;
        pair.client.unpipe(pair.upstream);
        pair.upstream.unpipe(pair.client);
        pair.upstream.pause();
        pair.client.destroy();
      }
      await delay(3000);
      expect(
        (await client.callTool({ name: 'noop', arguments: {} })).isError,
      ).not.to.equal(true);
      await f.server.sessions[0].server.sendLoggingMessage({
        level: 'debug',
        data: 'reattached',
      });
      await waitFor(() => received > 0, 2000);
      expect(errors.join('\n')).not.to.match(
        /Conflict|Maximum reconnection attempts/,
      );
    } finally {
      await transport.close();
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await f.close();
    }
  });

  it('replays a dropped request stream', async () => {
    const f = await fixture();
    try {
      const session = await f.initialize();
      const original = f.track(
        await f.post(session, 'tools/call', 42, {
          name: 'slow',
          arguments: {},
        }),
      );
      await waitFor(() => original.frames.some((frame) => frame.id));
      const cursor = original.frames[0].id!;
      await original.close();
      const resumed = await f.get(session, cursor);
      await waitFor(
        () => resumed.frames.some((frame) => frame.data.id === 42),
        5000,
      );
      expect(
        resumed.frames.find((frame) => frame.data.id === 42)!.data.result,
      ).to.deep.equal({ content: [{ type: 'text', text: 'ok' }] });
    } finally {
      await f.close();
    }
  });

  it('tolerates malformed Last-Event-ID values', async () => {
    const f = await fixture(new BoundedEventStore(10_000, 50));
    try {
      const session = await f.initialize();
      const original = f.track(
        await f.post(session, 'tools/call', 3, { name: 'noop', arguments: {} }),
      );
      await waitFor(() => original.frames.some((frame) => frame.id));
      await delay(100);
      for (const cursor of [
        'not-an-id',
        'x'.repeat(10 * 1024),
        original.frames[0].id!,
      ]) {
        const response = await fetch(f.url, {
          headers: { ...f.headers(session), 'Last-Event-ID': cursor },
        });
        expect(
          response.status === 200 ||
            (response.status >= 400 && response.status < 500),
        ).to.equal(true);
        if (response.status === 200) {
          const stream = f.track(response);
          await delay(100);
          expect(stream.frames).to.deep.equal([]);
          await stream.close();
        } else await response.text();
        const listed = await f.post(session, 'tools/list', 4);
        expect(listed.status).to.equal(200);
        expect(await listed.text()).to.include('noop');
      }
    } finally {
      await f.close();
    }
  });
});
