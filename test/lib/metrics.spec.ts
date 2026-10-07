import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { metrics, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { initTelemetry, normalizeOtlpBase } from '../../src/lib/metrics.js';
import {
  recordToolRequest,
  resetSyncInstruments,
} from '../../src/lib/metrics-recorders.js';

describe('metrics (OTLP telemetry)', () => {
  afterEach(() => {
    metrics.disable();
    logs.disable();
    trace.disable();
    resetSyncInstruments();
  });

  it('recordToolRequest never throws when telemetry is not started (stdio/disabled)', () => {
    expect(() =>
      recordToolRequest('browserless_scrape', true, 123),
    ).to.not.throw();
    expect(() =>
      recordToolRequest('browserless_agent', false, 0),
    ).to.not.throw();
  });

  it('normalizeOtlpBase strips trailing slashes so signal paths never double', () => {
    expect(normalizeOtlpBase('http://host:4318/')).to.equal('http://host:4318');
    expect(normalizeOtlpBase('http://host:4318//')).to.equal(
      'http://host:4318',
    );
    expect(normalizeOtlpBase('http://host:4318')).to.equal('http://host:4318');
    expect(normalizeOtlpBase('http://host:4318/v1')).to.equal(
      'http://host:4318/v1',
    );
  });

  it('bridges console on init, restores it on shutdown, and bounds the shutdown flush', async () => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const shutdown = initTelemetry({
      // Nothing is listening here: the exporter can never connect, so this
      // proves shutdown cannot hang on an unreachable collector.
      endpoint: 'http://127.0.0.1:59999',
      serviceName: 'browserless-mcp',
      serviceVersion: '0.0.0',
      getLiveSessionCount: () => 0,
    });
    try {
      expect(console.error).to.not.equal(originalError);
      expect(console.warn).to.not.equal(originalWarn);
    } finally {
      const start = Date.now();
      await shutdown();
      expect(Date.now() - start).to.be.lessThan(4000);
    }
    expect(console.error).to.equal(originalError);
    expect(console.warn).to.equal(originalWarn);
  });

  it('exports standard runtime metrics, application metrics and logs without enabling traces', async () => {
    const received: { path?: string; type?: string; body: Buffer }[] = [];
    const sink = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({
        path: req.url,
        type: req.headers['content-type'],
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    });
    sink.listen(0, '127.0.0.1');
    await once(sink, 'listening');
    const address = sink.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    const base = `http://127.0.0.1:${address.port}`;
    const previous = {
      OTEL_TRACES_EXPORTER: process.env.OTEL_TRACES_EXPORTER,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    };
    process.env.OTEL_TRACES_EXPORTER = 'otlp';
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `${base}/v1/traces`;
    let shutdown: (() => Promise<void>) | undefined;
    try {
      shutdown = initTelemetry({
        endpoint: `${base}/`,
        serviceName: 'telemetry-fixture',
        serviceVersion: '0.0.0',
        getLiveSessionCount: () => 3,
      });
      recordToolRequest('browserless_agent', false, 123, 'timeout');
      console.warn('telemetry-warning-fixture');
      trace.getTracer('fixture').startSpan('must-not-export').end();
      // Runtime delay metrics require at least five 10ms samples.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await shutdown();
      shutdown = undefined;

      expect(received.map((r) => r.path)).to.have.members([
        '/v1/metrics',
        '/v1/logs',
      ]);
      expect(
        received.every((r) => r.type === 'application/x-protobuf'),
      ).to.equal(true);
      const metricBody = received.find((r) => r.path === '/v1/metrics')!.body;
      for (const name of [
        'nodejs.eventloop.utilization',
        'nodejs.eventloop.delay.p99',
        'v8js.memory.heap.used',
        'browserless.mcp.sessions.live',
        'browserless.mcp.tool.requests',
      ]) {
        expect(metricBody.includes(name), `missing ${name}`).to.equal(true);
      }
      expect(metricBody.includes('browserless.mcp.eventloop')).to.equal(false);
      expect(
        received
          .find((r) => r.path === '/v1/logs')!
          .body.includes('telemetry-warning-fixture'),
      ).to.equal(true);
    } finally {
      await shutdown?.();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>((resolve) => sink.close(() => resolve()));
    }
  });

  it('index.ts gates telemetry on OTEL_ENABLED + httpStream, guarded so it cannot crash boot', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    expect(source).to.include("config.transport === 'httpStream'");
    // Master toggle matches the fleet convention (enterprise/workers).
    expect(source).to.include("process.env.OTEL_ENABLED === 'true'");
    expect(source).to.include('initTelemetry(');
    // The init is wrapped in try/catch — a telemetry failure must not abort boot.
    expect(source).to.match(/try\s*\{[\s\S]*?initTelemetry\(/);
    // And flushed on shutdown.
    expect(source).to.include('telemetryShutdown');
  });

  it('counts MCP requests on the authenticate hook, not the Hono fall-through app', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    // The Hono app from getApp() only sees non-/mcp fall-through routes, so the
    // request metrics must NOT live in a getApp().use('*') middleware.
    expect(source).to.not.match(/getApp\(\)\.use\(\s*['"]\*['"]/);
    // They belong on the authenticate hook (the one supported hook that observes
    // every POST /mcp), tracking in-flight + recording per request.
    const authStart = source.indexOf('const hybridAuthenticate');
    const authSlice = source.slice(authStart, authStart + 2000);
    expect(authStart, 'hybridAuthenticate not found').to.be.greaterThan(-1);
    expect(authSlice).to.include('mcpInFlightAdd(1)');
    expect(authSlice).to.include('recordMcpRequest(');
  });
});
