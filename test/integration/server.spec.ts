import { expect } from 'chai';
import sinon from 'sinon';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getConfig } from '../../src/config.js';
import {
  consumeDownload,
  downloadOwner,
  storeDownload,
} from '../../src/lib/download-store.js';
import {
  describeReadyDownload,
  normalizeUploadCommand,
} from '../../src/tools/agent.js';
import { FastMCP, OAuthProvider } from 'fastmcp';
import { z } from 'zod';
import { AnalyticsHelper } from '../../src/lib/analytics.js';
import { defineTool } from '../../src/lib/define-tool.js';
import { resolveBrowserlessRequestAuth } from '../../src/lib/http-auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerSmartScraperTool } from '../../src/tools/smartscraper.js';
import { registerApiDocsResource } from '../../src/resources/api-docs.js';
import { registerStatusResource } from '../../src/resources/status.js';
import { registerDownloadRoute } from '../../src/resources/download-route.js';
import { registerUploadRoute } from '../../src/resources/upload-route.js';
import { registerScrapeUrlPrompt } from '../../src/prompts/scrape-url.js';
import { registerExtractContentPrompt } from '../../src/prompts/extract-content.js';
import type { BrowserlessSession, McpConfig } from '../../src/@types/types.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'httpStream',
  port: 0, // let OS pick a port
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
  analyticsEnabled: false,
  complianceMode: false,
  sqsRegion: 'us-east-1',
  oauthEnabled: false,
  oauthRegisterRateLimitPerHour: 300,
  supabaseUrl: '',
  supabaseOAuthClientId: '',
  supabaseOAuthClientSecret: '',
  supabaseServiceRoleKey: '',
  mcpBaseUrl: '',
  oauthAllowedRedirectUriPatterns: [],
};

describe('MCP Server Integration', () => {
  let server: FastMCP;

  it('runs the download recipe with a local owner token and fails safely otherwise', async () => {
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), 'mcp-curl-'));
    const owner = downloadOwner('owner-token');
    const record = await storeDownload(
      'download.txt',
      'text/plain',
      Buffer.from('download bytes'),
      owner,
    );
    server = new FastMCP({ name: 'test', version: '1.0.0' });
    registerDownloadRoute(server, mockConfig);
    try {
      await server.start({
        transportType: 'httpStream',
        httpStream: { port, host: '127.0.0.1' },
      });
      const recipe = describeReadyDownload(record, {
        transport: 'httpStream',
        mcpBaseUrl: `http://127.0.0.1:${port}`,
      });
      const command = recipe.split('save it:  ')[1].split('   (single use)')[0];
      const run = (token: string | undefined) =>
        promisify(execFile)('sh', ['-c', command], {
          cwd: dir,
          env: { ...process.env, BROWSERLESS_TOKEN: token },
        });

      for (const token of [undefined, '', 'other-owner']) {
        await run(token).then(
          () => expect.fail('expected the download command to fail'),
          (error) => {
            expect(error.code).to.be.a('number').and.not.equal(0);
            expect(error.stderr).to.include(
              token ? '404' : 'BROWSERLESS_TOKEN',
            );
          },
        );
        expect(await readdir(dir)).to.deep.equal([]);
      }
      await run('owner-token');
      expect(await readFile(join(dir, record.filename), 'utf8')).to.equal(
        'download bytes',
      );
      await run('owner-token').then(
        () => expect.fail('expected the single-use URL to fail on repeat'),
        (error) => expect(error.code).to.equal(22),
      );
    } finally {
      await server.stop();
      consumeDownload(record.id, owner);
      await rm(record.path, { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const compliant of [true, false]) {
    it(`advertises the ${compliant ? 'connector' : 'full'} HTTP surface at startup`, async () => {
      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['build/src/index.js'], {
        env: {
          ...process.env,
          TRANSPORT: 'httpStream',
          PORT: String(port),
          MCP_COMPLIANCE_MODE: String(compliant),
          OAUTH_ENABLED: 'false',
          REDIS_URL: '',
          AMPLITUDE_API_KEY: '',
          ANALYTICS_ENABLED: 'false',
          OTEL_ENABLED: 'false',
          BROWSERLESS_TOKEN: '',
        },
        stdio: 'ignore',
      });
      const exited = once(child, 'exit');
      const client = new Client({ name: 'surface-test', version: '0.0.0' });
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            ready = (await fetch(`${base}/health`)).ok;
          } catch {
            /* starting */
          }
          if (ready || child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(ready, 'surface server starts').to.equal(true);
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            requestInit: {
              headers: { Authorization: `Bearer ${'a'.repeat(24)}` },
            },
          }),
        );
        const caps = client.getServerCapabilities();
        if (compliant) {
          expect(caps?.tools).to.deep.equal({});
          expect(caps).to.have.property('resources');
          expect(caps).not.to.have.property('prompts');
        } else {
          expect(caps?.tools).to.deep.include({ listChanged: true });
        }
        const names = (await client.listTools()).tools
          .map((tool) => tool.name)
          .sort();
        const connectorNames = [
          'browserless_export',
          'browserless_map',
          'browserless_performance',
          'browserless_performance_result',
          'browserless_performance_run',
          'browserless_read_page',
          'browserless_search',
        ];
        if (compliant) {
          expect(names).to.deep.equal(connectorNames);
        } else {
          expect(names).to.have.length(23);
          expect(names).not.to.include('browserless_read_page');
          expect(names).to.include.members([
            ...connectorNames.filter(
              (name) => name !== 'browserless_read_page',
            ),
            'browserless_stage_file',
            'browserless_show',
            'browserless_view_data',
          ]);
        }
      } finally {
        await client.close().catch(() => {});
        child.kill('SIGTERM');
        await exited;
      }
    });
  }

  for (const oauth of [false, true]) {
    it(`binds built-server session requests with OAuth=${oauth}`, async () => {
      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      const keys = ['a'.repeat(24), 'b'.repeat(24)];
      const child = spawn(process.execPath, ['build/src/index.js'], {
        env: {
          ...process.env,
          TRANSPORT: 'httpStream',
          PORT: String(port),
          BROWSERLESS_API_URL: 'http://127.0.0.1:9',
          OAUTH_ENABLED: String(oauth),
          MCP_BASE_URL: base,
          SUPABASE_URL: 'http://127.0.0.1:9',
          SUPABASE_OAUTH_CLIENT_ID: 'test',
          SUPABASE_OAUTH_CLIENT_SECRET: 'test',
          REDIS_URL: '',
          AMPLITUDE_API_KEY: '',
          ANALYTICS_ENABLED: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const exited = once(child, 'exit');
      let sid = '';
      const request = (method: string, key?: string, rpc = 'tools/list') =>
        fetch(`${base}/mcp`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-11-25',
            ...(sid ? { 'mcp-session-id': sid } : {}),
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          },
          ...(method === 'POST'
            ? {
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: rpc,
                  params:
                    rpc === 'initialize'
                      ? {
                          protocolVersion: '2025-11-25',
                          capabilities: {},
                          clientInfo: { name: 'binding', version: '1' },
                        }
                      : {},
                }),
              }
            : {}),
        });
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            ready = (await fetch(`${base}/health`)).ok;
          } catch {
            /* starting */
          }
          if (ready || child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(ready).to.equal(true);
        const initialized = await request('POST', keys[0], 'initialize');
        expect(initialized.status).to.equal(200);
        sid = initialized.headers.get('mcp-session-id')!;
        expect(sid).to.be.a('string').and.not.empty;
        await initialized.text();
        const challenges: (string | null)[] = [];
        for (const method of ['GET', 'POST', 'DELETE']) {
          const denied = await request(method);
          expect(denied.status, method).to.equal(401);
          expect(await denied.json()).to.have.nested.property(
            'error.code',
            -32000,
          );
          challenges.push(denied.headers.get('www-authenticate'));
          const other = await request(method, keys[1]);
          expect(other.status).to.equal(404);
          expect(await other.text()).to.equal(
            '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}',
          );
        }
        if (oauth) {
          expect(challenges[0]).to.include('resource_metadata=');
          expect(new Set(challenges).size).to.equal(1);
        }
        const listed = await request('POST', keys[0]);
        expect(listed.status).to.equal(200);
        await listed.text();
        expect((await request('DELETE', keys[0])).status).to.equal(200);
      } finally {
        child.kill('SIGTERM');
        await exited;
      }
      for (const key of keys) expect(output).not.to.include(key);
      expect(output).not.to.include('key:');
    });
  }

  for (const oauth of [false, true]) {
    for (const opener of [
      'header',
      'query',
      'empty-bearer',
      'jwt-with-query',
    ]) {
      it(`binds built-server legacy SSE posts with OAuth=${oauth}, opener=${opener}`, async () => {
        const queryAuth = opener !== 'header';
        const port = await freePort();
        const base = `http://127.0.0.1:${port}`;
        const keys = ['a'.repeat(24) + '+&=%/#', 'b'.repeat(24)];
        const authorization =
          opener === 'header'
            ? `Bearer ${keys[0]}`
            : opener === 'empty-bearer'
              ? 'Bearer '
              : opener === 'jwt-with-query'
                ? 'Bearer e30.e30.test'
                : undefined;
        const child = spawn(process.execPath, ['build/src/index.js'], {
          env: {
            ...process.env,
            TRANSPORT: 'httpStream',
            PORT: String(port),
            BROWSERLESS_API_SERVER: 'http://127.0.0.1:9',
            BROWSERLESS_API_URL: 'http://127.0.0.1:9',
            BROWSERLESS_MAX_RETRIES: '0',
            OAUTH_ENABLED: String(oauth),
            MCP_BASE_URL: base,
            SUPABASE_URL: 'http://127.0.0.1:9',
            SUPABASE_OAUTH_CLIENT_ID: 'test',
            SUPABASE_OAUTH_CLIENT_SECRET: 'test',
            REDIS_URL: '',
            AMPLITUDE_API_KEY: '',
            ANALYTICS_ENABLED: 'false',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        child.stderr.on('data', (chunk) => {
          output += chunk;
        });
        const exited = once(child, 'exit');
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          let ready = false;
          for (let i = 0; i < 100; i++) {
            try {
              ready = (await fetch(`${base}/health`)).ok;
            } catch {
              /* starting */
            }
            if (ready || child.exitCode !== null) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(ready).to.equal(true);
          const stream = await fetch(
            `${base}/sse?token=${encodeURIComponent(queryAuth ? keys[0] : keys[1])}`,
            {
              headers: authorization ? { Authorization: authorization } : {},
              signal: AbortSignal.timeout(10000),
            },
          );
          expect(stream.status).to.equal(200);
          reader = stream.body!.getReader();
          let frames = '';
          const until = async (value: string) => {
            while (!frames.includes(value)) {
              const chunk = await reader!.read();
              expect(chunk.done).to.equal(false);
              frames += new TextDecoder().decode(chunk.value);
            }
          };
          await until('\n\n');
          const endpoint = new URL(frames.match(/data: (.+)/)![1], base);
          expect(endpoint.searchParams.get('token')).to.equal(
            queryAuth ? keys[0] : null,
          );
          const bareEndpoint = new URL(endpoint);
          bareEndpoint.searchParams.delete('token');
          const post = (
            key?: string,
            method = 'initialize',
            target = bareEndpoint,
          ) =>
            fetch(target, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(key ? { Authorization: `Bearer ${key}` } : {}),
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: method === 'initialize' ? 1 : 2,
                method,
                params:
                  method === 'initialize'
                    ? {
                        protocolVersion: '2025-11-25',
                        capabilities: {},
                        clientInfo: { name: 'sse', version: '1' },
                      }
                    : {},
              }),
            });
          const missing = await post();
          expect(missing.status).to.equal(401);
          expect(await missing.json()).to.have.nested.property(
            'error.code',
            -32000,
          );
          if (oauth)
            expect(missing.headers.get('www-authenticate')).to.include(
              'resource_metadata=',
            );
          const other = await post(keys[1]);
          expect(other.status).to.equal(404);
          expect(await other.text()).to.equal(
            '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}',
          );
          expect(
            (
              await post(
                queryAuth ? undefined : keys[0],
                'initialize',
                endpoint,
              )
            ).status,
          ).to.equal(202);
          await until('"id":1');
          expect(
            (
              await post(
                queryAuth ? undefined : keys[0],
                'tools/list',
                endpoint,
              )
            ).status,
          ).to.equal(202);
          await until('"tools"');
        } finally {
          await reader?.cancel().catch(() => {});
          child.kill('SIGTERM');
          await exited;
        }
        for (const key of keys) expect(output).not.to.include(key);
        expect(output).not.to.include(encodeURIComponent(keys[0]));
        expect(output).not.to.include('key:');
      });
    }
  }

  it('preserves OAuth refresh and registration bodies and limits only registration POSTs per address', async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let refreshInputs: Record<string, string> | undefined;
    const upstream = createHttpServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/auth/v1/oauth/token') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      refreshInputs = Object.fromEntries(new URLSearchParams(body));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          access_token: 'refreshed-access-token',
          refresh_token: 'rotated-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'email profile',
        }),
      );
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamPort = (upstream.address() as { port: number }).port;
    const child = spawn(process.execPath, ['build/src/index.js'], {
      env: {
        ...process.env,
        TRANSPORT: 'httpStream',
        PORT: String(port),
        OAUTH_ENABLED: 'true',
        MCP_BASE_URL: base,
        SUPABASE_URL: `http://127.0.0.1:${upstreamPort}`,
        SUPABASE_OAUTH_CLIENT_ID: 'test',
        SUPABASE_OAUTH_CLIENT_SECRET: 'test',
        REDIS_URL: '',
        OAUTH_REGISTER_RATE_LIMIT_PER_HOUR: '2',
        AMPLITUDE_API_KEY: '',
        ANALYTICS_ENABLED: 'false',
      },
      stdio: 'ignore',
    });
    const exited = once(child, 'exit');
    const post = (ip: string) =>
      fetch(`${base}/oauth/register`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
        headers: { 'content-type': 'application/json', 'x-real-ip': ip },
        body: JSON.stringify({
          redirect_uris: ['http://localhost:33418/cb'],
          client_name: 'integration',
        }),
      });
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          ready = (await fetch(`${base}/health`)).ok;
        } catch {
          /* starting */
        }
        if (ready || child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(ready, 'OAuth server starts').to.equal(true);
      const refreshed = await fetch(`${base}/oauth/token`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'refresh+token/with=reserved&characters',
          client_id: 'integration-client',
          scope: 'email profile',
        }),
      });
      expect(refreshed.status).to.equal(200);
      expect(await refreshed.json()).to.deep.equal({
        access_token: 'refreshed-access-token',
        refresh_token: 'rotated-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'email profile',
      });
      expect(refreshInputs).to.deep.equal({
        grant_type: 'refresh_token',
        refresh_token: 'refresh+token/with=reserved&characters',
        scope: 'email profile',
      });
      for (let i = 0; i < 3; i++)
        await fetch(`${base}/oauth/register`, {
          headers: { 'x-real-ip': '9.9.9.9' },
        });
      const first = await post('9.9.9.9');
      expect(first.status).to.equal(201);
      expect(await first.json())
        .to.have.property('redirect_uris')
        .that.deep.equals(['http://localhost:33418/cb']);
      expect((await post('9.9.9.9')).status).to.equal(201);
      const denied = await post('9.9.9.9');
      expect(denied.status).to.equal(429);
      expect(denied.headers.get('retry-after')).to.match(/^\d+$/);
      expect(denied.headers.get('cache-control')).to.equal('no-store');
      expect(await denied.json()).to.deep.equal({
        error: 'too_many_requests',
        error_description: 'Too many client registrations from this address',
      });
      expect((await post('8.8.8.8')).status).to.equal(201);
    } finally {
      child.kill('SIGTERM');
      await exited;
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
        upstream.closeAllConnections();
      });
    }
  });

  it('preserves legacy SSE initialization and tool POST bodies', async () => {
    const port = await freePort();
    server = new FastMCP({ name: 'legacy-sse-test', version: '1.0.0' });
    server.addTool({
      name: 'echo',
      description: 'Returns the submitted value',
      parameters: z.object({ value: z.string() }),
      execute: async ({ value }) => value,
    });
    const client = new Client({ name: 'legacy-sse-client', version: '1.0.0' });
    try {
      await server.start({
        transportType: 'httpStream',
        httpStream: { port, host: '127.0.0.1' },
      });
      await client.connect(
        new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              signal:
                init?.method === 'POST'
                  ? AbortSignal.any([
                      ...(init?.signal ? [init.signal] : []),
                      AbortSignal.timeout(3000),
                    ])
                  : init?.signal,
            }),
        }),
        { timeout: 3000 },
      );
      expect(client.getServerVersion()?.name).to.equal('legacy-sse-test');
      expect(
        await client.callTool({
          name: 'echo',
          arguments: { value: 'legacy POST body + & = ✓' },
        }),
      ).to.deep.equal({
        content: [{ type: 'text', text: 'legacy POST body + & = ✓' }],
      });
    } finally {
      await client.close();
      await server.stop();
    }
  });

  afterEach(async () => {
    sinon.restore();
  });

  for (const authorization of [undefined, 'Bearer', 'Bearer ', 'bearer']) {
    it(`serves OAuth discovery for an empty credential ${JSON.stringify(authorization)}`, async () => {
      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      server = new FastMCP({
        name: 'discovery-test',
        version: '1.0.0',
        auth: new OAuthProvider({
          baseUrl: base,
          clientId: 'test',
          clientSecret: 'test',
          authorizationEndpoint: 'http://127.0.0.1:9/authorize',
          tokenEndpoint: 'http://127.0.0.1:9/token',
          scopes: ['email'],
        }),
        authenticate: (request) =>
          resolveBrowserlessRequestAuth(request, mockConfig),
      });
      try {
        await server.start({
          transportType: 'httpStream',
          httpStream: { port, host: '127.0.0.1' },
        });
        const challenge = await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(authorization === undefined ? {} : { authorization }),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'discovery-test', version: '1.0.0' },
            },
          }),
        });
        expect(challenge.status).to.equal(401);
        const metadataUrl = challenge.headers
          .get('www-authenticate')
          ?.match(/resource_metadata="([^"]+)"/)?.[1];
        expect(metadataUrl, 'challenge advertises metadata').to.be.a('string');
        expect(new URL(metadataUrl!).origin).to.equal(base);
        const metadata = await fetch(metadataUrl!);
        expect(metadata.status, 'advertised metadata resolves').to.equal(200);
        expect(await metadata.json()).to.deep.include({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ['email'],
        });
      } finally {
        await server.stop();
      }
    });
  }

  it('returns 400 without an OAuth challenge for invalid attach IDs with a valid token', async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    server = new FastMCP({
      name: 'invalid-attach-test',
      version: '0.1.0',
      auth: new OAuthProvider({
        baseUrl: base,
        clientId: 'test',
        clientSecret: 'test',
        authorizationEndpoint: 'http://127.0.0.1:9/authorize',
        tokenEndpoint: 'http://127.0.0.1:9/token',
        scopes: ['email'],
      }),
      authenticate: (request) =>
        resolveBrowserlessRequestAuth(request, mockConfig),
    });
    try {
      await server.start({
        transportType: 'httpStream',
        httpStream: { port, host: '127.0.0.1' },
      });
      for (const [query, headers] of [
        ['?browserlessSessionId=browser%0Aid', {}],
        ['', { 'x-browserless-session-id': 'browser\tid' }],
      ] as const) {
        const response = await fetch(`${base}/mcp${query}`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer valid-key',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'invalid-attach-test', version: '1' },
            },
          }),
        });
        expect(response.status).to.equal(400);
        expect(response.headers.get('www-authenticate')).to.equal(null);
        expect(await response.text()).to.include('session ID');
      }
    } finally {
      await server.stop();
    }
  });

  it('starts with upload roots unset and permits re-upload from the default download directory', async () => {
    const originalDownload = process.env.BROWSERLESS_DOWNLOAD_DIR;
    const originalUpload = process.env.BROWSERLESS_UPLOAD_DIRS;
    delete process.env.BROWSERLESS_DOWNLOAD_DIR;
    delete process.env.BROWSERLESS_UPLOAD_DIRS;
    const owner = downloadOwner('local-fixture-token');
    let record: Awaited<ReturnType<typeof storeDownload>> | undefined;
    server = new FastMCP({ name: 'upload-config-test', version: '0.1.0' });
    try {
      const config = getConfig();
      expect(config.uploadDirs).to.deep.equal([
        join(tmpdir(), 'browserless-mcp-downloads'),
      ]);
      await server.start({
        transportType: 'httpStream',
        httpStream: { port: await freePort() },
      });
      record = await storeDownload(
        'fixture.txt',
        'text/plain',
        Buffer.from('default-root-fixture'),
        owner,
      );
      expect(dirname(record.path)).to.equal(config.uploadDirs[0]);
      const file: Record<string, unknown> = { path: record.path };
      await normalizeUploadCommand(
        { method: 'uploadFile', params: { files: [file] } },
        'stdio',
        undefined,
        'local-fixture-token',
      );
      expect(Buffer.from(file.content as string, 'base64').toString()).to.equal(
        'default-root-fixture',
      );
    } finally {
      if (originalDownload === undefined)
        delete process.env.BROWSERLESS_DOWNLOAD_DIR;
      else process.env.BROWSERLESS_DOWNLOAD_DIR = originalDownload;
      if (originalUpload === undefined)
        delete process.env.BROWSERLESS_UPLOAD_DIRS;
      else process.env.BROWSERLESS_UPLOAD_DIRS = originalUpload;
      if (record) {
        consumeDownload(record.id, owner);
        await rm(record.path, { force: true });
      }
      await server.stop();
    }
  });

  it('emits attribution for a real streamable-HTTP session', async () => {
    const port = await freePort();
    const authenticatedServer = new FastMCP<BrowserlessSession>({
      name: 'attribution-test',
      version: '0.1.0',
      authenticate: (request) =>
        resolveBrowserlessRequestAuth(request, mockConfig),
    });
    const analytics = new AnalyticsHelper(false);
    const fire = sinon.stub(analytics, 'fireToolRequest');
    defineTool(authenticatedServer, mockConfig, analytics, {
      name: 'test_tool',
      description: 'Local attribution test',
      parameters: z.object({}),
      run: async () => 'ok',
      format: () => [{ type: 'text', text: 'ok' }],
    });
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    try {
      await authenticatedServer.start({
        transportType: 'httpStream',
        httpStream: { port },
      });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://localhost:${port}/mcp`),
          {
            requestInit: {
              headers: {
                Authorization: `Bearer ${'a'.repeat(24)}`,
                'User-Agent': 'Attribution-Probe/2.3',
              },
            },
          },
        ),
      );
      expect(
        await client.callTool({ name: 'test_tool', arguments: {} }),
      ).to.deep.equal({ content: [{ type: 'text', text: 'ok' }] });
      expect(fire.calledOnce).to.be.true;
      expect(fire.firstCall.args[2]).to.include({
        source: 'mcp_client',
        client_name: 'test-client',
        client_version: '0.0.0',
        auth_method: 'api_key_header',
        transport: 'streamable-http',
        user_agent: 'Attribution-Probe/2.3',
        user_agent_family: 'attribution-probe',
        client_family: 'other',
        usage_mode: 'unknown',
      });
    } finally {
      await client.close();
      await authenticatedServer.stop();
    }
  });

  it('creates a fully configured server with all components', () => {
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });

    registerSmartScraperTool(server, mockConfig);
    registerApiDocsResource(server, mockConfig);
    registerStatusResource(server, mockConfig);
    registerScrapeUrlPrompt(server);
    registerExtractContentPrompt(server);

    // If we get here without errors, the server is properly configured
    expect(server).to.exist;
  });

  it('rejects unsafe API URL overrides on file routes', async () => {
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });
    registerUploadRoute(server, mockConfig);
    registerDownloadRoute(server, mockConfig);
    const app = server.getApp();

    for (const [method, path] of [
      ['POST', '/upload'],
      ['GET', '/download/missing'],
    ] as const) {
      const response = await app.request(`http://example.test${path}`, {
        method,
        headers: {
          authorization: 'Bearer token',
          'x-browserless-api-url': 'http://127.0.0.1:9999',
        },
      });
      expect(response.status).to.equal(400);
      expect(await response.json()).to.deep.equal({
        ok: false,
        error: 'Invalid x-browserless-api-url',
      });
    }
  });

  it('rejects unauthenticated file transfer routes', async () => {
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });
    registerUploadRoute(server, mockConfig);
    registerDownloadRoute(server, mockConfig);

    const upload = new FormData();
    upload.set('file', new File(['data'], 'fixture.txt'));
    expect(
      (
        await server
          .getApp()
          .request('/upload', { method: 'POST', body: upload })
      ).status,
    ).to.equal(401);
    expect(
      (await server.getApp().request('/download/anything')).status,
    ).to.equal(401);
  });

  it('starts and stops cleanly in httpStream mode', async () => {
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });
    registerSmartScraperTool(server, mockConfig);

    await server.start({
      transportType: 'httpStream',
      httpStream: { port: 0 },
    });

    // Server should be running
    expect(server.serverState).to.equal('running');

    await server.stop();
    expect(server.serverState).to.equal('stopped');
  });

  // patches/fastmcp+4.4.0.patch makes it `{ listChanged: true }`. Fails if a bump drops it.
  it('advertises tools.listChanged so clients auto-refresh the tool list', async () => {
    const port = await freePort();
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });
    registerSmartScraperTool(server, mockConfig);
    await server.start({ transportType: 'httpStream', httpStream: { port } });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
    );
    try {
      await client.connect(transport);
      const caps = client.getServerCapabilities();
      expect(caps?.tools).to.deep.include({ listChanged: true });
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });

  it('rejects disallowed httpStream overrides during authentication', async () => {
    const port = await freePort();
    server = new FastMCP<BrowserlessSession>({
      name: 'browserless-mcp',
      version: '0.1.0',
      authenticate: (request) =>
        resolveBrowserlessRequestAuth(request, mockConfig),
    });
    await server.start({ transportType: 'httpStream', httpStream: { port } });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
      {
        requestInit: {
          headers: {
            authorization: 'Bearer token',
            'x-browserless-api-url': 'http://127.0.0.1:9999',
          },
        },
      },
    );
    try {
      let error: unknown;
      try {
        await client.connect(transport);
      } catch (cause) {
        error = cause;
      }
      expect(error).to.be.instanceOf(Error);
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });

  it('retains an allowed httpStream override in the authenticated session', async () => {
    const port = await freePort();
    server = new FastMCP<BrowserlessSession>({
      name: 'browserless-mcp',
      version: '0.1.0',
      authenticate: (request) =>
        resolveBrowserlessRequestAuth(request, mockConfig),
    });
    server.addTool({
      name: 'session_api_url',
      description: 'Returns the authenticated API URL for testing.',
      parameters: z.object({}),
      execute: async (_args, context) => context.session?.apiUrl ?? '',
    });
    await server.start({ transportType: 'httpStream', httpStream: { port } });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
      {
        requestInit: {
          headers: {
            authorization: 'Bearer token',
            'x-browserless-api-url': 'https://production-lon.browserless.io',
          },
        },
      },
    );
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'session_api_url',
        arguments: {},
      });
      expect(result.content).to.deep.equal([
        {
          type: 'text',
          text: 'https://production-lon.browserless.io',
        },
      ]);
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
