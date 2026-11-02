import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('local Docker MCP runner', () => {
  it('terminates its MCP child when the gateway exits unexpectedly', async () => {
    const port = await freePort();
    const internal = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const runner = new URL('../../../scripts/local-mcp.mjs', import.meta.url)
      .href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import ${JSON.stringify(runner)}; process.on('message', () => process.exit(2));`,
      ],
      {
        env: {
          ...process.env,
          PORT: String(port),
          MCP_INTERNAL_PORT: String(internal),
          BROWSERLESS_API_URL: 'http://127.0.0.1:5555',
          BROWSERLESS_PUBLIC_URL: base,
          BROWSERLESS_TOKEN: 'local-runner-test',
        },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      },
    );
    const internalUrl = `http://127.0.0.1:${internal}/health`;
    try {
      const readyBy = Date.now() + 10_000;
      let ready = false;
      while (!ready && Date.now() < readyBy) {
        ready = await fetch(internalUrl).then(
          () => true,
          () => false,
        );
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(ready, 'internal MCP child started');
      const exited = once(child, 'exit');
      child.send('exit');
      assert.equal((await exited)[0], 2);
      const stoppedBy = Date.now() + 3000;
      while (
        await fetch(internalUrl).then(
          () => true,
          () => false,
        )
      ) {
        assert.ok(
          Date.now() < stoppedBy,
          'gateway exit must terminate its MCP child',
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    }
  });

  it('proxies MCP and viewer traffic and survives aborted upgrades', async () => {
    const backend = createServer((_request, response) =>
      response.end('viewer asset'),
    );
    const sockets = new WebSocketServer({ noServer: true });
    backend.on('upgrade', (request, socket, head) => {
      if (request.url?.includes('reject')) {
        socket.on('error', () => {});
        socket.end(
          'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) =>
        ws.on('message', (bytes) => ws.send(bytes)),
      );
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, '127.0.0.1', resolve),
    );
    const port = await freePort();
    const internal = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../../scripts/local-mcp.mjs', import.meta.url),
        ),
      ],
      {
        env: {
          ...process.env,
          BROWSERLESS_TOKEN: 'local-runner-test',
          BROWSERLESS_API_URL: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
          BROWSERLESS_PUBLIC_URL: base,
          MCP_BASE_URL: base,
          PORT: String(port),
          MCP_INTERNAL_PORT: String(internal),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const token = 'local-runner-test';
    let logs = '';
    let leaked = false;
    let carry = '';
    const record = (data: Buffer) => {
      const text = carry + data;
      if (text.includes(token)) leaked = true;
      carry = text.slice(-(token.length - 1));
      logs = (logs + data).slice(-8000);
    };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    let client: Client | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!client && Date.now() < deadline) {
        const attempt = new Client({
          name: 'Local runner check',
          version: '1',
        });
        try {
          await attempt.connect(
            new StreamableHTTPClientTransport(
              new URL(base + '/mcp?token=local-runner-test'),
            ),
          );
          client = attempt;
        } catch {
          await attempt.close();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(client, logs);
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === 'browserless_agent'));
      assert.ok(
        tools.tools.some((tool) => tool.name === 'browserless_live_url'),
      );
      assert.equal((await fetch(base + '/live/index.html')).status, 200);
      assert.equal((await fetch(base + '/demo/2fa')).status, 404);
      const ws = new WebSocket(
        base.replace('http:', 'ws:') + '/chromium/live/test',
      );
      await once(ws, 'open');
      const echoed = once(ws, 'message');
      ws.send('viewer connected');
      assert.equal(String((await echoed)[0]), 'viewer connected');
      ws.close();
      await once(ws, 'close');
      for (let i = 0; i < 30; i++) {
        await new Promise<void>((resolve) => {
          const socket = connect(port, '127.0.0.1', () => {
            socket.write(
              'GET /chromium/live/test HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
            );
            socket.destroy();
          });
          socket.on('error', () => {});
          socket.once('close', () => resolve());
        });
      }
      await new Promise<void>((resolve, reject) => {
        const upgrade = request(
          base + '/chromium/live/reject',
          { headers: { connection: 'Upgrade', upgrade: 'websocket' } },
          (response) => {
            assert.equal(response.statusCode, 404);
            response.resume();
            response.on('end', resolve);
          },
        );
        upgrade.on('error', reject);
        upgrade.end();
      });
      assert.deepEqual(await (await fetch(base + '/health')).json(), {
        ok: true,
      });
      for (const upgrade of [true, false]) {
        for (const path of ['//', '//%', 'http://[invalid']) {
          const status = await new Promise<number | undefined>(
            (resolve, reject) => {
              const req = request(
                {
                  hostname: '127.0.0.1',
                  port,
                  path,
                  headers: upgrade
                    ? { connection: 'Upgrade', upgrade: 'websocket' }
                    : {},
                },
                (response) => {
                  response.resume();
                  response.on('end', () => resolve(response.statusCode));
                },
              );
              req.on('error', reject);
              req.end();
            },
          );
          assert.equal(
            status,
            400,
            `reject malformed ${upgrade ? 'upgrade' : 'HTTP'} target ${path}`,
          );
        }
      }
      assert.ok((await client.listTools()).tools.length > 0);
      assert.equal(leaked, false, 'runner must not print the API token');
    } finally {
      await client?.close();
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
    await assert.rejects(
      fetch(`http://127.0.0.1:${internal}/health`),
      'stopping the runner must stop its internal MCP child',
    );
  });
});
