import { expect } from 'chai';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = 'synthetic-session-open-key-0123456789abcdef';
const keyFingerprint = createHash('sha256')
  .update(token)
  .digest('hex')
  .slice(0, 16);
const deadUrl = 'http://127.0.0.1:9';
const eventName = 'browserless.mcp.session.open';
type Attributes = Record<string, string | number | boolean>;
type LogRecord = {
  severityText?: string;
  severityNumber?: number;
  attributes: {
    key: string;
    value: { stringValue?: string; intValue?: string; boolValue?: boolean };
  }[];
};
type QueueEvent = {
  event_type: string;
  event_properties: Record<string, unknown>;
};

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function attributes(record: LogRecord): Attributes {
  return Object.fromEntries(
    record.attributes.map(({ key, value }) => [
      key,
      value.stringValue ?? value.boolValue ?? Number(value.intValue),
    ]),
  );
}

async function withServer(
  options: {
    compliant?: boolean;
    queueFails?: boolean;
    hostileAttribution?: boolean;
  },
  run: (fixture: {
    base: string;
    records: LogRecord[];
    events: QueueEvent[];
    settle: () => Promise<void>;
    output: () => string;
    queueRequests: () => number;
    connect: (
      transport: 'sse' | 'streamable-http',
      name: string,
    ) => Promise<Client>;
  }) => Promise<void>,
): Promise<void> {
  const clients: Client[] = [];
  const payloads: string[] = [];
  const records: LogRecord[] = [];
  const events: QueueEvent[] = [];
  const sinkErrors: string[] = [];
  let queueRequests = 0;
  const sink = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('content-type', 'application/json');
    try {
      if (request.url === '/v1/logs') {
        payloads.push(body);
        const payload = JSON.parse(body) as {
          resourceLogs: { scopeLogs: { logRecords: LogRecord[] }[] }[];
        };
        for (const resource of payload.resourceLogs)
          for (const scope of resource.scopeLogs)
            records.push(...scope.logRecords);
        response.end('{}');
      } else {
        queueRequests++;
        expect(request.headers['x-amz-target']).to.equal(
          'AmazonSQS.SendMessageBatch',
        );
        expect(request.headers['content-type']).to.include(
          'application/x-amz-json',
        );
        const batch = JSON.parse(body) as {
          QueueUrl: string;
          Entries: { Id: string; MessageBody: string }[];
        };
        expect(new URL(batch.QueueUrl).hostname).to.equal('127.0.0.1');
        expect(batch.Entries).not.to.be.empty;
        for (const entry of batch.Entries)
          events.push(JSON.parse(entry.MessageBody) as QueueEvent);
        if (options.queueFails) {
          response.writeHead(500);
          response.end(
            JSON.stringify({ __type: 'InternalError', message: 'Unavailable' }),
          );
        } else {
          response.end(
            JSON.stringify({
              Successful: batch.Entries.map((entry) => ({
                Id: entry.Id,
                MessageId: entry.Id,
                MD5OfMessageBody: createHash('md5')
                  .update(entry.MessageBody)
                  .digest('hex'),
              })),
              Failed: [],
            }),
          );
        }
      }
    } catch (error) {
      sinkErrors.push(String(error));
      response.writeHead(400);
      response.end('{}');
    }
  });
  sink.listen(0, '127.0.0.1');
  await once(sink, 'listening');
  const sinkBase = `http://127.0.0.1:${(sink.address() as AddressInfo).port}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TRANSPORT: 'httpStream',
    PORT: String(port),
    MCP_COMPLIANCE_MODE: String(options.compliant ?? false),
    BROWSERLESS_API_SERVER: deadUrl,
    BROWSERLESS_API_URL: deadUrl,
    BROWSERLESS_MAX_RETRIES: '0',
    SUPABASE_URL: deadUrl,
    SUPABASE_SERVICE_ROLE_KEY: '',
    BROWSERLESS_TOKEN: '',
    OAUTH_ENABLED: 'false',
    REDIS_URL: '',
    AMPLITUDE_API_KEY: '',
    ANALYTICS_ENABLED: 'true',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${sinkBase}/v1/logs`,
    SQS_QUEUE_URL: `${sinkBase}/queue`,
    SQS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL: sinkBase,
    AWS_ENDPOINT_URL_SQS: sinkBase,
    AWS_ACCESS_KEY_ID: 'synthetic-access-key',
    AWS_SECRET_ACCESS_KEY: 'synthetic-secret-key',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_MAX_ATTEMPTS: '1',
  };
  delete env.AWS_SESSION_TOKEN;
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
      await delay(50);
    }
    expect(ready, 'server starts').to.equal(true);
    await run({
      base,
      records,
      events,
      // Keep clients open while ready hooks and queue delivery settle.
      settle: () => delay(2000),
      output: () => output,
      queueRequests: () => queueRequests,
      connect: async (transport, name) => {
        const client = await connect(
          base,
          transport,
          name,
          options.hostileAttribution,
        );
        clients.push(client);
        return client;
      },
    });
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    sink.closeAllConnections();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    expect(sinkErrors, 'local sinks accept the wire protocols').to.deep.equal(
      [],
    );
    expect(output, 'child output omits the raw key').not.to.include(token);
    for (const payload of payloads)
      expect(payload, 'OTLP omits the raw key').not.to.include(token);
    for (const record of records)
      for (const key of ['token', 'user_agent', 'identityToken', 'userId'])
        expect(attributes(record)).not.to.have.property(key);
  }
}

async function connect(
  base: string,
  transport: 'sse' | 'streamable-http',
  name: string,
  hostileAttribution = false,
) {
  const client = new Client({ name, version: '1.0.0' });
  try {
    await client.connect(
      transport === 'sse'
        ? new SSEClientTransport(
            new URL(
              `${base}/sse?token=${token}${hostileAttribution ? `&mcpSource=${token}` : ''}`,
            ),
            {
              requestInit: {
                headers: hostileAttribution ? { 'User-Agent': token } : {},
              },
            },
          )
        : new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            requestInit: {
              headers: {
                Authorization: `Bearer ${token}`,
                ...(hostileAttribution
                  ? { 'User-Agent': token, 'x-browserless-mcp-source': token }
                  : {}),
              },
            },
          }),
      { timeout: 5000 },
    );
    expect((await client.listTools()).tools).not.to.be.empty;
    // A second request must not publish another session-open event.
    expect((await client.listTools()).tools).not.to.be.empty;
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

function expectOpen(
  records: LogRecord[],
  transport: string,
  authMethod: string,
  name?: string,
) {
  expect(records).to.have.length(1);
  const record = records[0];
  expect(record.severityText).to.equal('INFO');
  expect(record.severityNumber).to.equal(9);
  const props = attributes(record);
  expect(props).to.include({
    'event.name': eventName,
    transport,
    auth_method: authMethod,
    key_fp: keyFingerprint,
  });
  expect(props).not.to.have.property('account_id');
  if (name !== undefined) expect(props.client_name).to.equal(name);
  return props;
}

describe('Session opening telemetry', function () {
  this.timeout(30000);

  it('initializes query-authenticated SSE and publishes one session event', async () => {
    await withServer(
      {},
      async ({ connect, records, events, settle, output }) => {
        await connect('sse', 'probe-sse');
        await settle();
        const props = expectOpen(records, 'sse', 'api_key_query', 'probe-sse');
        expect(events).to.have.length(1);
        expect(events[0].event_type).to.equal('MCP Session Started');
        expect(events[0].event_properties).to.include({
          token,
          transport: props.transport,
          auth_method: props.auth_method,
          key_fp: props.key_fp,
          client_name: props.client_name,
        });
        expect(events[0].event_properties).not.to.have.property('account_id');
        expect(output()).to.include('Client connected:');
      },
    );
  });

  it('logs header-authenticated streamable initialization without queue events', async () => {
    await withServer(
      {},
      async ({ connect, records, events, settle, output, queueRequests }) => {
        await connect('streamable-http', 'probe-streamable');
        await settle();
        expectOpen(
          records,
          'streamable-http',
          'api_key_header',
          'probe-streamable',
        );
        expect(events).to.deep.equal([]);
        expect(queueRequests()).to.equal(0);
        expect(output()).to.include('Client connected:');
      },
    );
  });

  it('rejects unauthenticated SSE without session telemetry', async () => {
    await withServer(
      {},
      async ({ base, records, events, settle, queueRequests, output }) => {
        const response = await fetch(`${base}/sse`, {
          signal: AbortSignal.timeout(5000),
        });
        // Preserve the current authentication response; telemetry does not alter it.
        expect(response.status).to.equal(500);
        expect(response.headers.has('mcp-session-id')).to.equal(false);
        await response.text();
        await settle();
        expect(records).to.deep.equal([]);
        expect(events).to.deep.equal([]);
        expect(queueRequests()).to.equal(0);
        expect(output()).not.to.include('Client connected:');
      },
    );
  });

  for (const transport of ['sse', 'streamable-http'] as const) {
    it(`omits session telemetry in compliance mode over ${transport}`, async () => {
      await withServer(
        { compliant: true },
        async ({ connect, records, events, settle, queueRequests }) => {
          await connect(transport, 'probe-compliant');
          await settle();
          expect(records).to.deep.equal([]);
          expect(events).to.deep.equal([]);
          expect(queueRequests()).to.equal(0);
        },
      );
    });
  }

  for (const transport of ['sse', 'streamable-http'] as const) {
    it(`bounds hostile attribution over ${transport}`, async () => {
      const name = ('probe\n\r\t\u0000\u001b"\\' + 'x'.repeat(10000)).slice(
        0,
        10000,
      );
      await withServer(
        { hostileAttribution: true },
        async ({ connect, records, events, settle }) => {
          await connect(transport, name);
          await settle();
          const props = expectOpen(
            records,
            transport,
            transport === 'sse' ? 'api_key_query' : 'api_key_header',
          );
          expect(props).to.include({
            source: 'unknown',
            user_agent_family: 'unknown',
          });
          expect(props.client_name).to.be.a('string');
          const logged = String(props.client_name);
          expect(logged.length).to.be.within(1, 256);
          expect(logged).to.include('probe');
          expect(
            [...logged].some(
              (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
            ),
            'client name has no literal control characters',
          ).to.equal(false);
          if (transport === 'sse') {
            expect(events).to.have.length(1);
            expect(events[0].event_properties.client_name).to.equal(logged);
          } else expect(events).to.deep.equal([]);
        },
      );
    });
  }

  it('keeps initialization and tools available when the queue fails', async () => {
    await withServer(
      { queueFails: true },
      async ({ connect, records, settle, queueRequests }) => {
        const client = await connect('sse', 'probe-queue-failure');
        await settle();
        expect(queueRequests()).to.equal(3);
        expect((await client.listTools()).tools).not.to.be.empty;
        expectOpen(records, 'sse', 'api_key_query', 'probe-queue-failure');
      },
    );
  });
});
