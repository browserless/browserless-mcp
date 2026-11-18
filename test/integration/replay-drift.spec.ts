import { expect } from 'chai';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

describe('unverified retained replay', () => {
  it('installs on SDK drift, serves real client calls, and completes resume with 400', async function () {
    this.timeout(25_000);
    const root = process.cwd();
    const fixture = mkdtempSync(join(tmpdir(), 'mcp-replay-drift-'));
    const reserve = createServer();
    await new Promise<void>((resolve) =>
      reserve.listen(0, '127.0.0.1', resolve),
    );
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const client = new Client({ name: 'drift-client', version: '1.0.0' });
    const otherClient = new Client({
      name: 'other-drift-client',
      version: '1.0.0',
    });
    let child: ReturnType<typeof spawn> | undefined;
    let logs = '';
    try {
      cpSync(join(root, 'build/src'), join(fixture, 'build/src'), {
        recursive: true,
      });
      cpSync(join(root, 'scripts'), join(fixture, 'scripts'), {
        recursive: true,
      });
      cpSync(join(root, 'package.json'), join(fixture, 'package.json'));
      mkdirSync(join(fixture, 'node_modules'));
      for (const dependency of readdirSync(join(root, 'node_modules'))) {
        if (dependency === 'fastmcp') continue;
        symlinkSync(
          join(root, 'node_modules', dependency),
          join(fixture, 'node_modules', dependency),
        );
      }
      // Only this isolated copy is mutated, never the running/shared install.
      cpSync(
        join(root, 'node_modules/fastmcp'),
        join(fixture, 'node_modules/fastmcp'),
        {
          recursive: true,
          dereference: true,
        },
      );
      const require = createRequire(join(fixture, 'package.json'));
      const proxyDist = dirname(
        createRequire(require.resolve('fastmcp')).resolve('mcp-proxy'),
      );
      expect(proxyDist).to.satisfy((path: string) => path.startsWith(fixture));
      let drifted = 0;
      for (const file of readdirSync(proxyDist).filter((f) =>
        /\.(mjs|js)$/.test(f),
      )) {
        const path = join(proxyDist, file);
        const source = readFileSync(path, 'utf8');
        const changed = source.replaceAll(
          '.replayEventsAfter(lastEventId, { sessionId: this.sessionId,',
          '.replayEventsAfter(lastEventId /* upstream drift */, {',
        );
        if (changed !== source) {
          writeFileSync(path, changed);
          drifted++;
        }
      }
      expect(drifted, 'active bundled SDK was changed').to.be.greaterThan(0);
      const installed = execFileSync('npm', ['run', 'postinstall'], {
        cwd: fixture,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      expect(installed).not.to.include('replay patch: complete');
      child = spawn(process.execPath, ['build/src/index.js'], {
        cwd: fixture,
        env: {
          ...process.env,
          TRANSPORT: 'httpStream',
          PORT: String(port),
          OAUTH_ENABLED: 'false',
          REDIS_URL: '',
          AMPLITUDE_API_KEY: '',
          ANALYTICS_ENABLED: 'false',
          OTEL_ENABLED: 'false',
          MCP_COMPLIANCE_MODE: 'false',
          BROWSERLESS_TOKEN: 'local-drift',
          BROWSERLESS_API_URL: 'http://127.0.0.1:9',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', (data) => {
        logs += data;
      });
      child.stderr!.on('data', (data) => {
        logs += data;
      });
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          ready = (await fetch(`${base}/health`)).ok;
        } catch {
          /* starting */
        }
        if (ready || child.exitCode !== null) break;
        await delay(50);
      }
      expect(ready, logs).to.equal(true);
      expect(logs).to.match(/retained replay.*disabled/i);
      let cursor: string | undefined;
      const transport = new StreamableHTTPClientTransport(
        new URL(`${base}/mcp`),
        {
          requestInit: { headers: { Authorization: 'Bearer local-drift' } },
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            if (
              typeof init?.body === 'string' &&
              init.body.includes('tools/call')
            ) {
              expect(response.headers.get('content-type')).to.include(
                'text/event-stream',
              );
              cursor = (await response.clone().text()).match(
                /^id: *(.+)$/m,
              )?.[1];
            }
            return response;
          },
        },
      );
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === 'browserless_skill')).to.equal(
        true,
      );
      const result = await client.callTool({
        name: 'browserless_skill',
        arguments: { id: 'cookie-consent' },
      });
      expect(result.isError).not.to.equal(true);
      expect(result.content).to.be.an('array').that.is.not.empty;
      expect(JSON.stringify(result.content)).to.include('cookie');
      expect(cursor, 'real tool call supplies a cursor').to.be.a('string').and
        .not.empty;
      const otherTransport = new StreamableHTTPClientTransport(
        new URL(`${base}/mcp`),
        {
          requestInit: { headers: { Authorization: 'Bearer local-other' } },
        },
      );
      await otherClient.connect(otherTransport);
      expect((await otherClient.listTools()).tools.length).to.equal(
        tools.tools.length,
      );
      console.log(
        `PASS SDK drift: postinstall exit=0, startup warning, official client tools/list=${tools.tools.length}, SSE skill call=cookie-consent`,
      );
      for (const [label, token, session, replayCursor] of [
        ['owner cursor', 'local-drift', transport.sessionId!, cursor!],
        ['other principal', 'local-other', otherTransport.sessionId!, cursor!],
        [
          'unknown cursor',
          'local-drift',
          transport.sessionId!,
          'unknown-cursor',
        ],
      ]) {
        const started = performance.now();
        const response = await fetch(`${base}/mcp`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
            'mcp-session-id': session,
            'Last-Event-ID': replayCursor,
          },
          signal: AbortSignal.timeout(1500),
        });
        expect(response.status).to.equal(400);
        expect(response.headers.get('content-type')).to.include(
          'application/json',
        );
        const body = (await response.json()) as {
          error: { code: number; message: string };
          id: null;
        };
        expect(body.error.code).to.equal(-32000);
        expect(body.error.message).to.include('Retained replay unavailable');
        expect(body.id).to.equal(null);
        expect(body).not.to.have.property('result');
        const elapsed = performance.now() - started;
        expect(elapsed).to.be.lessThan(1500);
        console.log(
          `PASS SDK drift ${label}: HTTP 400, completed JSON, no result, ${Math.round(elapsed)}ms`,
        );
      }
      // Refused resume does not poison the live session.
      expect((await client.listTools()).tools.length).to.equal(
        tools.tools.length,
      );
    } finally {
      await client.close();
      await otherClient.close();
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
