import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { initTelemetry, normalizeOtlpBase } from '../../src/lib/metrics.js';
import { recordToolRequest } from '../../src/lib/metrics-recorders.js';

describe('metrics (OTLP telemetry)', () => {
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
