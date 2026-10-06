import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import {
  recordToolRequest,
  initTelemetry,
  normalizeOtlpBase,
} from '../../src/lib/metrics.js';

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

  it('index.ts starts telemetry only in httpStream mode, guarded so it cannot crash boot', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    expect(source).to.include("config.transport === 'httpStream'");
    expect(source).to.include('initTelemetry(');
    // The init is wrapped in try/catch — a telemetry failure must not abort boot.
    expect(source).to.match(/try\s*\{[\s\S]*?initTelemetry\(/);
    // And flushed on shutdown.
    expect(source).to.include('telemetryShutdown');
  });
});
