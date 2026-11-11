import { expect } from 'chai';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { hashToken } from '../../src/lib/utils.js';
import { classifyCursor } from '../../src/lib/session-request-log.js';

const deadUrl = 'http://127.0.0.1:9';
const keys = ['a'.repeat(24), 'b'.repeat(24)];
const invalidJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.dGVzdA';
const notFound =
  '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}';
const missingToken =
  'No Browserless API token provided. ' +
  'Pass it as Authorization: Bearer <token> header, ' +
  '?token= query parameter, or authenticate via OAuth.';
const responseHeaders = {
  connection: 'keep-alive',
  'content-type': 'application/json',
  'keep-alive': 'timeout=5',
  'transfer-encoding': 'chunked',
};

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('Session request response compatibility', () => {
  for (const compliant of [false, true]) {
    it(`preserves response contracts with compliance=${compliant}`, async function () {
      this.timeout(45000);
      const sink = createServer((request, response) => {
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
      sink.listen(0, '127.0.0.1');
      await once(sink, 'listening');
      const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/v1/logs`;
      let baseline: unknown[] | undefined;
      try {
        for (const endpoint of [sinkUrl, undefined, deadUrl]) {
          const port = await freePort();
          const base = `http://127.0.0.1:${port}`;
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            TRANSPORT: 'httpStream',
            PORT: String(port),
            MCP_COMPLIANCE_MODE: String(compliant),
            BROWSERLESS_API_SERVER: deadUrl,
            BROWSERLESS_MAX_RETRIES: '0',
            BROWSERLESS_API_URL: deadUrl,
            SUPABASE_URL: deadUrl,
            SUPABASE_SERVICE_ROLE_KEY: '',
            BROWSERLESS_TOKEN: '',
            OAUTH_ENABLED: 'false',
            REDIS_URL: '',
            AMPLITUDE_API_KEY: '',
            ANALYTICS_ENABLED: 'false',
          };
          delete env.OTEL_ENABLED;
          delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
          delete env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
          if (endpoint) env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = endpoint;
          const child = spawn(process.execPath, ['build/src/index.js'], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const exited = once(child, 'exit');
          let output = '';
          child.stdout.on('data', (chunk) => {
            output += chunk;
          });
          child.stderr.on('data', (chunk) => {
            output += chunk;
          });
          const request = (
            method: string,
            sid: string,
            token?: string,
            initialize = false,
          ) =>
            fetch(`${base}/mcp`, {
              method,
              signal: AbortSignal.timeout(5000),
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'mcp-protocol-version': '2025-11-25',
                ...(method === 'GET' && !token
                  ? { 'Last-Event-ID': '_GET_stream_1_0_x' }
                  : {}),
                ...(sid ? { 'mcp-session-id': sid } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              ...(method === 'POST'
                ? {
                    body: JSON.stringify({
                      jsonrpc: '2.0',
                      id: 17,
                      method: initialize ? 'initialize' : 'tools/list',
                      params: initialize
                        ? {
                            protocolVersion: '2025-11-25',
                            capabilities: {},
                            clientInfo: {
                              name: 'response-contract',
                              version: '1',
                            },
                          }
                        : {},
                    }),
                  }
                : {}),
            });
          try {
            let ready = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              try {
                const health = await fetch(`${base}/health`, {
                  signal: AbortSignal.timeout(1000),
                });
                ready = health.ok;
                await health.body?.cancel();
              } catch {
                /* starting */
              }
              if (ready || child.exitCode !== null) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(ready, 'server starts').to.equal(true);
            const initialized = await request('POST', '', keys[0], true);
            expect(initialized.status).to.equal(200);
            const sid = initialized.headers.get('mcp-session-id');
            expect(sid).to.be.a('string').and.not.empty;
            await initialized.text();
            const responses: unknown[] = [];
            for (const method of ['GET', 'POST', 'DELETE']) {
              for (const scenario of [
                { sid: sid!, token: keys[1], status: 404 },
                { sid: sid!, token: undefined, status: 401 },
                { sid: sid!, token: invalidJwt, status: 401 },
                { sid: 'unknown-session', token: keys[0], status: 404 },
                { sid: 'unknown-session', token: undefined, status: 401 },
              ]) {
                const response = await request(
                  method,
                  scenario.sid,
                  scenario.token,
                );
                const body = await response.text();
                const headers = Object.fromEntries(
                  [...response.headers].filter(([name]) => name !== 'date'),
                );
                expect(response.status, method).to.equal(scenario.status);
                expect(headers, method).to.deep.equal(responseHeaders);
                if (scenario.status === 404) expect(body).to.equal(notFound);
                else {
                  const parsed = JSON.parse(body);
                  expect(parsed).to.have.nested.property('error.code', -32000);
                  expect(parsed.id).to.equal(method === 'POST' ? 17 : null);
                  if (!scenario.token) {
                    expect(body).to.equal(
                      `{"error":{"code":-32000,"message":"${missingToken}"},"id":${method === 'POST' ? 17 : 'null'},"jsonrpc":"2.0"}`,
                    );
                    expect(parsed).to.deep.equal({
                      jsonrpc: '2.0',
                      id: method === 'POST' ? 17 : null,
                      error: { code: -32000, message: missingToken },
                    });
                  }
                }
                responses.push({ status: response.status, body, headers });
              }
            }
            if (baseline) expect(responses).to.deep.equal(baseline);
            else baseline = responses;
            const listed = await request('POST', sid!, keys[0]);
            expect(listed.status).to.equal(200);
            await listed.text();
            const deleted = await request('DELETE', sid!, keys[0]);
            expect(deleted.status).to.equal(200);
            await deleted.text();
          } finally {
            child.kill('SIGTERM');
            await exited;
            for (const value of [...keys, invalidJwt, 'key:']) {
              expect(
                output.includes(value),
                'child output omits credentials',
              ).to.equal(false);
            }
          }
        }
      } finally {
        sink.closeAllConnections();
        await new Promise<void>((resolve) => sink.close(() => resolve()));
      }
    });
  }
});

type Attributes = Record<string, string | number | boolean>;
type OtlpRecord = {
  attributes: {
    key: string;
    value: { stringValue?: string; intValue?: string; boolValue?: boolean };
  }[];
};
type OtlpPayload = {
  resourceLogs: { scopeLogs: { logRecords: OtlpRecord[] }[] }[];
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const principalRef = (key: string) =>
  hashToken(`key:${createHash('sha256').update(key).digest('hex')}`);

async function expectEmptyStream(response: Response): Promise<void> {
  expect(response.status).to.equal(200);
  expect(response.headers.get('content-type')).to.equal('text/event-stream');
  const reader = response.body!.getReader();
  try {
    // SSE remains open; absence of replay bytes is the observable contract.
    const chunk = await Promise.race([
      reader.read(),
      pause(200).then(() => undefined),
    ]);
    expect(chunk?.value?.byteLength ?? 0).to.equal(0);
  } finally {
    await reader.cancel();
  }
}

async function withLogServer(
  compliant: boolean,
  run: (fixture: {
    base: string;
    records: Attributes[];
    privateValues: string[];
    request: (
      method: string,
      sid?: string,
      token?: string,
      cursor?: string,
      initialize?: boolean,
    ) => Promise<Response>;
    open: (token: string) => Promise<string>;
    expectCount: (count: number) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const payloads: string[] = [];
  const records: Attributes[] = [];
  const privateValues = [...keys, invalidJwt, 'key:'];
  let malformedPayload = false;
  const sink = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    payloads.push(body);
    try {
      const payload = JSON.parse(body) as OtlpPayload;
      for (const resource of payload.resourceLogs) {
        for (const scope of resource.scopeLogs) {
          for (const record of scope.logRecords) {
            records.push(
              Object.fromEntries(
                record.attributes.map(({ key, value }) => [
                  key,
                  value.stringValue ??
                    value.boolValue ??
                    Number(value.intValue),
                ]),
              ),
            );
          }
        }
      }
    } catch {
      malformedPayload = true;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  sink.listen(0, '127.0.0.1');
  await once(sink, 'listening');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRANSPORT: 'httpStream',
    PORT: String(port),
    MCP_COMPLIANCE_MODE: String(compliant),
    BROWSERLESS_API_SERVER: deadUrl,
    BROWSERLESS_API_URL: deadUrl,
    BROWSERLESS_MAX_RETRIES: '0',
    SUPABASE_URL: deadUrl,
    SUPABASE_SERVICE_ROLE_KEY: '',
    BROWSERLESS_TOKEN: '',
    OAUTH_ENABLED: 'false',
    REDIS_URL: '',
    AMPLITUDE_API_KEY: '',
    ANALYTICS_ENABLED: 'false',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/v1/logs`,
  };
  delete env.OTEL_ENABLED;
  delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const child = spawn(process.execPath, ['build/src/index.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const request = (
    method: string,
    sid = '',
    token?: string,
    cursor?: string,
    initialize = false,
  ) => {
    if (sid) privateValues.push(sid);
    if (cursor) privateValues.push(cursor);
    return fetch(`${base}/mcp`, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        'user-agent': 'Session-Contract/1.0',
        'x-real-ip': '192.0.2.8',
        ...(sid ? { 'mcp-session-id': sid } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cursor ? { 'Last-Event-ID': cursor } : {}),
      },
      ...(method === 'POST'
        ? {
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 17,
              method: initialize ? 'initialize' : 'tools/list',
              params: initialize
                ? {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'log-contract', version: '1' },
                  }
                : {},
            }),
          }
        : {}),
    });
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const health = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        ready = health.ok;
        await health.body?.cancel();
      } catch {
        /* starting */
      }
      if (ready || child.exitCode !== null) break;
      await pause(50);
    }
    expect(ready, 'server starts').to.equal(true);
    await run({
      base,
      records,
      privateValues,
      request,
      open: async (token) => {
        const response = await request('POST', '', token, undefined, true);
        expect(response.status).to.equal(200);
        const sid = response.headers.get('mcp-session-id');
        expect(sid).to.be.a('string').and.not.empty;
        privateValues.push(sid!);
        await response.text();
        return sid!;
      },
      expectCount: async (count) => {
        // Observe the full delivery window to also catch duplicate records.
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) await pause(25);
        expect(records).to.have.length(count);
      },
    });
  } finally {
    child.kill('SIGTERM');
    await exited;
    sink.closeAllConnections();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    expect(malformedPayload, 'sink receives OTLP JSON').to.equal(false);
    for (const value of privateValues) {
      expect(
        payloads.some((body) => body.includes(value)),
        'records omit raw identifiers',
      ).to.equal(false);
    }
    for (const value of [...keys, invalidJwt, 'key:']) {
      expect(output.includes(value), 'child output omits credentials').to.equal(
        false,
      );
    }
  }
}

function expectCommon(
  record: Attributes,
  compliant: boolean,
  sid: string,
  method: string,
  cursorKind = 'none',
) {
  expect(record).to.include({
    method,
    surface: compliant ? 'connector' : 'full',
    has_last_event_id: cursorKind !== 'none',
    cursor_kind: cursorKind,
    session_ref: hashToken(sid),
    ip: '192.0.2.8',
    user_agent: 'Session-Contract/1.0',
    user_agent_family: 'session-contract',
  });
  expect(record.reason).to.be.a('string').and.not.empty;
  for (const [name, value] of Object.entries(record)) {
    if (name.endsWith('_ref')) expect(value).to.match(/^[a-f0-9]{16}$/);
  }
}

describe('Session request diagnostic contracts', function () {
  this.timeout(30000);
  it('does not record retired endpoints as session refusals', async () => {
    await withLogServer(false, async ({ base, records }) => {
      for (const [method, path] of [
        ['GET', '/sse'],
        ['POST', '/messages?sessionId=retired'],
      ]) {
        const response = await fetch(base + path, {
          method,
          headers: { Authorization: `Bearer ${keys[0]}` },
          signal: AbortSignal.timeout(3000),
        });
        await response.body?.cancel();
        expect(response.status).to.equal(404);
      }
      expect(records).to.deep.equal([]);
    });
  });

  for (const compliant of [false, true]) {
    it(`records one principal decision per method with compliance=${compliant}`, async () => {
      await withLogServer(
        compliant,
        async ({ open, request, records, expectCount }) => {
          const sid = await open(keys[0]);
          for (const method of ['GET', 'POST', 'DELETE']) {
            const response = await request(method, sid, keys[1]);
            expect(response.status).to.equal(404);
            expect(await response.text()).to.equal(notFound);
          }
          await expectCount(3);
          expect(records.map((record) => record.method).sort()).to.deep.equal([
            'DELETE',
            'GET',
            'POST',
          ]);
          for (const record of records) {
            expectCommon(record, compliant, sid, String(record.method));
            expect(record).to.include({
              'event.name': 'browserless.mcp.session.request_refused',
              reason: 'principal_mismatch',
              auth_method: 'api_key_header',
              presenter_ref: principalRef(keys[1]),
              owner_ref: principalRef(keys[0]),
            });
            expect(record.presenter_ref).not.to.equal(record.owner_ref);
          }
        },
      );
    });

    it(`records missing and invalid credentials with compliance=${compliant}`, async () => {
      await withLogServer(
        compliant,
        async ({ open, request, records, expectCount }) => {
          const sid = await open(keys[0]);
          const missing = await request(
            'GET',
            sid,
            undefined,
            '_GET_stream_1_0_x',
          );
          expect(missing.status).to.equal(401);
          await missing.text();
          for (const method of ['GET', 'POST', 'DELETE']) {
            const response = await request(method, sid, invalidJwt);
            expect(response.status).to.equal(401);
            expect(await response.json()).to.have.nested.property(
              'error.code',
              -32000,
            );
          }
          await expectCount(4);
          const missingRecords = records.filter(
            (record) => record.reason === 'missing_credentials_live_session',
          );
          expect(missingRecords).to.have.length(1);
          expectCommon(missingRecords[0], compliant, sid, 'GET', 'malformed');
          const invalid = records.filter(
            (record) => record.reason === 'invalid_credentials_live_session',
          );
          expect(invalid.map((record) => record.method).sort()).to.deep.equal([
            'DELETE',
            'GET',
            'POST',
          ]);
          for (const record of invalid)
            expectCommon(record, compliant, sid, String(record.method));
          for (const record of records)
            expect(record['event.name']).to.equal(
              'browserless.mcp.session.request_refused',
            );
        },
      );
    });

    it(`records retained request cursor decisions with compliance=${compliant}`, async () => {
      await withLogServer(
        compliant,
        async ({ open, request, records, expectCount, privateValues }) => {
          const sidA = await open(keys[0]);
          const sidB = await open(keys[0]);
          const sidC = await open(keys[1]);
          const listed = await request('POST', sidA, keys[0]);
          expect(listed.status).to.equal(200);
          const cursor = (await listed.text()).match(/^id: (.+)$/m)?.[1];
          expect(cursor, 'POST returns a retained event id').to.be.a('string')
            .and.not.empty;
          privateValues.push(cursor!);
          for (const [sid, token, samePrincipal] of [
            [sidB, keys[0], true],
            [sidC, keys[1], false],
          ] as const) {
            const response = await request('GET', sid, token, cursor);
            await expectEmptyStream(response);
            await expectCount(samePrincipal ? 1 : 2);
            const record = records.at(-1)!;
            expectCommon(record, compliant, sid, 'GET', 'request');
            expect(record).to.include({
              'event.name': 'browserless.mcp.event_store.replay_refused',
              reason: 'cursor_context_mismatch',
              cursor_session_ref: hashToken(sidA),
              presenter_ref: principalRef(token),
              owner_ref: principalRef(keys[0]),
              same_principal: samePrincipal,
            });
            expect(record.cursor_age_ms).to.be.a('number').and.at.least(0);
          }
          const own = await request('GET', sidA, keys[0], cursor);
          expect(own.status).to.equal(200);
          await own.body?.cancel();
          await expectCount(2);
        },
      );
    });

    it(`omits routine misses with compliance=${compliant}`, async () => {
      await withLogServer(compliant, async ({ open, request, expectCount }) => {
        const sid = await open(keys[0]);
        for (const method of ['GET', 'POST', 'DELETE']) {
          for (const token of [keys[0], undefined]) {
            const response = await request(method, 'unknown-session', token);
            expect(response.status).to.equal(token ? 404 : 401);
            await response.text();
          }
        }
        const initialized = await request(
          'POST',
          '',
          undefined,
          undefined,
          true,
        );
        expect(initialized.status).to.equal(401);
        await initialized.text();
        const priorCursor =
          '12345678-1234-1234-1234-123456789abc_1000000000000_0_abcdef';
        expect(classifyCursor(priorCursor)).to.equal('prior_process');
        const prior = await request('GET', sid, keys[0], priorCursor);
        await expectEmptyStream(prior);
        await expectCount(0);
      });
    });
  }

  it('retains request context through the full SDK tool lifecycle', async () => {
    await withLogServer(
      false,
      async ({ base, records, privateValues, expectCount }) => {
        const client = new Client({
          name: 'session-contract-sdk',
          version: '1',
        });
        const transport = new StreamableHTTPClientTransport(
          new URL(`${base}/mcp`),
          {
            requestInit: { headers: { Authorization: `Bearer ${keys[0]}` } },
          },
        );
        try {
          await client.connect(transport);
          if (transport.sessionId) privateValues.push(transport.sessionId);
          expect(
            (await client.listTools()).tools.map((tool) => tool.name),
          ).to.include('browserless_sessions');
          const result = await client.callTool({
            name: 'browserless_sessions',
            arguments: { action: 'active' },
          });
          expect(result.isError).to.equal(true);
        } finally {
          await client.close();
        }
        await expectCount(0);
        expect(
          records.filter(
            (record) =>
              record['event.name'] ===
              'browserless.mcp.event_store.context_missing',
          ),
        ).to.have.length(0);
      },
    );
  });
});
