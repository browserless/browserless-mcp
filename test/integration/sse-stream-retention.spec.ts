import { expect } from 'chai';
import { createServer } from 'node:net';
import { queryObjects } from 'node:v8';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

// Every MCP session keeps a standalone SSE stream open for its whole life, and
// the server writes to it on every keepalive ping and notification. The HTTP
// writer bundled in mcp-proxy used to chain one pending promise per chunk until
// the stream closed, so memory grew for as long as a client stayed connected.

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const waitFor = async (condition: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('long-lived SSE streams', () => {
  it('do not retain a promise per event written to an open stream', async () => {
    const port = await freePort();
    const server = new FastMCP({ name: 'sse-retention', version: '1.0.0' });
    server.addTool({
      name: 'noop',
      description: 'No-op tool so the server advertises tools',
      parameters: z.object({}),
      execute: async () => 'ok',
    });
    await server.start({
      transportType: 'httpStream',
      httpStream: { port, host: '127.0.0.1' },
    });

    let received = 0;
    let onReceived: (() => void) | undefined;
    const client = new Client(
      { name: 'sse-retention-test', version: '1.0.0' },
      { capabilities: {} },
    );
    client.setNotificationHandler(LoggingMessageNotificationSchema, () => {
      received++;
      onReceived?.();
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );

    try {
      await client.connect(transport);
      await waitFor(() => server.sessions.length === 1);
      const [session] = server.sessions;

      // The client opens its standalone stream after initialization; until it
      // does, server-initiated messages have nowhere to go. Probe until one
      // arrives so every measured event is written to the open stream.
      const probe = setInterval(() => {
        session.server
          .sendLoggingMessage({ level: 'debug', data: 'probe' })
          .catch(() => {});
      }, 50);
      try {
        await waitFor(() => received > 0);
      } finally {
        clearInterval(probe);
      }
      await new Promise((resolve) => setTimeout(resolve, 200)); // in-flight probes land

      // Like keepalive pings: one small event at a time, each delivered before
      // the next, so the socket never backs up (a full socket restarts the
      // writer's read loop on `drain`, which hides the chain).
      const events = 2_000;
      const before = queryObjects(Promise, { format: 'count' });
      for (let i = 0; i < events; i++) {
        const delivered = new Promise<void>((resolve) => {
          onReceived = resolve;
        });
        await session.server.sendLoggingMessage({ level: 'info', data: i });
        await delivered;
      }
      onReceived = undefined;
      const retained = queryObjects(Promise, { format: 'count' }) - before;

      expect(
        retained,
        `${retained} promises retained after ${events} events on one open stream`,
      ).to.be.below(events / 10);
    } finally {
      await transport.close().catch(() => {});
      await server.stop();
    }
  });
});
