import { expect } from 'chai';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  DataPointType,
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { registerRuntimeInstruments } from '../../src/lib/metrics.js';
import {
  createSyncInstruments,
  recordToolRequest,
  recordUpstreamCall,
  recordRedisOp,
  recordRedisError,
  recordSessionLifetime,
  recordHttpRequest,
  recordGcPause,
  httpInFlightAdd,
  noteAccountRequest,
  collectAccountWindow,
} from '../../src/lib/metrics-recorders.js';

// Collect the exact instruments the server registers through an in-memory reader
// and assert the full exported inventory + each instrument's kind/attributes.
// This is the regression guard for the metric contract: a dropped metric, a
// gauge flipped to a counter, or a missing attribute fails here.
describe('metrics shape (full exported inventory)', () => {
  let provider: MeterProvider;
  const captured: ResourceMetrics[] = [];

  before(async () => {
    const exporter: PushMetricExporter = {
      export: (rm, cb) => {
        captured.push(rm);
        cb({ code: 0 });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
      selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    };
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 2 ** 31 - 1,
    });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);

    registerRuntimeInstruments(() => 2);
    createSyncInstruments();
    httpInFlightAdd(2);
    recordToolRequest('browserless_scrape', true, 123);
    recordToolRequest('browserless_scrape', false, 45, 'target_website');
    recordUpstreamCall('goto', true, 200);
    recordRedisOp('get', true, 3);
    recordRedisError();
    recordSessionLifetime('mcp', 60_000);
    recordSessionLifetime('agent', 120_000);
    recordHttpRequest(200, 15);
    recordGcPause(1.5); // production records these from the PerformanceObserver
    noteAccountRequest('token-aaa');
    noteAccountRequest('token-aaa');
    noteAccountRequest('token-bbb'); // 2 distinct accounts; aaa is the top talker

    await new Promise((r) => setTimeout(r, 40));
    await reader.forceFlush();
  });

  after(async () => {
    await provider.shutdown();
    metrics.disable();
  });

  const all = (): MetricData[] =>
    captured.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
  const byName = (n: string): MetricData | undefined =>
    all().find((m) => m.descriptor.name === n);

  const EXPECTED = [
    'mcp.eventloop.delay.p50_ms',
    'mcp.eventloop.delay.p99_ms',
    'mcp.eventloop.utilization',
    'mcp.process.memory_bytes',
    'mcp.process.active_resources',
    'mcp.process.uptime_seconds',
    'mcp.http.in_flight',
    'mcp.sessions.live',
    'mcp.sessions.tracked',
    'mcp.sessions.in_flight_exec',
    'mcp.agent.sessions.active',
    'mcp.agent.sessions.pending',
    'mcp.agent.commands.in_flight',
    'mcp.sessions.reaped',
    'mcp.agent.sessions.swept',
    'mcp.tool.requests',
    'mcp.tool.duration_ms',
    'mcp.agent.upstream.duration_ms',
    'mcp.redis.op.duration_ms',
    'mcp.redis.errors',
    'mcp.session.lifetime_ms',
    'mcp.http.requests',
    'mcp.http.duration_ms',
    'mcp.gc.pause_ms',
    'mcp.accounts.active',
    'mcp.account.requests',
  ];

  it('exports every expected metric name and nothing less', () => {
    const names = new Set(all().map((m) => m.descriptor.name));
    for (const n of EXPECTED)
      expect(names.has(n), `missing ${n}`).to.equal(true);
  });

  it('uses the correct instrument kind per metric', () => {
    const gauges = [
      'mcp.eventloop.utilization',
      'mcp.sessions.live',
      'mcp.http.in_flight',
      'mcp.agent.sessions.pending',
      'mcp.process.uptime_seconds',
    ];
    for (const g of gauges)
      expect(byName(g)?.dataPointType, g).to.equal(DataPointType.GAUGE);

    const histograms = [
      'mcp.tool.duration_ms',
      'mcp.agent.upstream.duration_ms',
      'mcp.redis.op.duration_ms',
      'mcp.session.lifetime_ms',
      'mcp.http.duration_ms',
      'mcp.gc.pause_ms',
    ];
    for (const h of histograms)
      expect(byName(h)?.dataPointType, h).to.equal(DataPointType.HISTOGRAM);

    for (const c of [
      'mcp.sessions.reaped',
      'mcp.agent.sessions.swept',
      'mcp.tool.requests',
      'mcp.redis.errors',
      'mcp.http.requests',
    ]) {
      const m = byName(c);
      expect(m?.dataPointType, c).to.equal(DataPointType.SUM);
      if (m?.dataPointType === DataPointType.SUM)
        expect(m.isMonotonic, c).to.equal(true);
    }
  });

  it('splits process.memory_bytes across rss/heap_used/heap_total/external in bytes', () => {
    const mem = byName('mcp.process.memory_bytes');
    expect(mem?.descriptor.unit).to.equal('By');
    const types = new Set(
      mem?.dataPoints.map((d) => d.attributes.type as string) ?? [],
    );
    for (const t of ['rss', 'heap_used', 'heap_total', 'external'])
      expect(types.has(t), t).to.equal(true);
  });

  it('tags tool metrics with tool + success, and error_category on failures only', () => {
    const req = byName('mcp.tool.requests');
    const ok = req?.dataPoints.find(
      (d) =>
        d.attributes.tool === 'browserless_scrape' &&
        d.attributes.success === true,
    );
    expect(ok?.value).to.equal(1);
    expect(ok?.attributes.error_category).to.equal(undefined);
    const fail = req?.dataPoints.find(
      (d) =>
        d.attributes.tool === 'browserless_scrape' &&
        d.attributes.success === false,
    );
    expect(fail?.attributes.error_category).to.equal('target_website');
  });

  it('tags the new upstream / redis / http / lifetime metrics correctly', () => {
    const up = byName('mcp.agent.upstream.duration_ms');
    expect(up?.dataPoints[0]?.attributes.method).to.equal('goto');
    const redis = byName('mcp.redis.op.duration_ms');
    expect(redis?.dataPoints[0]?.attributes.op).to.equal('get');
    const http = byName('mcp.http.requests');
    expect(http?.dataPoints.some((d) => d.attributes.status === 200)).to.equal(
      true,
    );
    const life = byName('mcp.session.lifetime_ms');
    const kinds = new Set(life?.dataPoints.map((d) => d.attributes.kind) ?? []);
    expect(kinds.has('mcp')).to.equal(true);
    expect(kinds.has('agent')).to.equal(true);
    expect(byName('mcp.http.in_flight')?.dataPoints[0]?.value).to.equal(2);
  });

  it('tracks distinct accounts and the top talkers by hashed token (no raw token)', () => {
    expect(byName('mcp.accounts.active')?.dataPoints[0]?.value).to.equal(2);
    const acct = byName('mcp.account.requests');
    // Every series is labelled by a hashed account id — never a raw token.
    expect(
      acct?.dataPoints.every(
        (d) => typeof d.attributes.account_hash === 'string',
      ),
    ).to.equal(true);
    expect(
      acct?.dataPoints.every(
        (d) => !String(d.attributes.account_hash).includes('token-'),
      ),
    ).to.equal(true);
    // The top talker (aaa) made 2 requests this window.
    expect(acct?.dataPoints.some((d) => d.value === 2)).to.equal(true);
  });

  it('caps the account window so a distinct-token flood cannot grow it unbounded', () => {
    // before()'s forceFlush drained the window; accountsEnabled is still on.
    for (let i = 0; i < 10_050; i++) noteAccountRequest('flood-token-' + i);
    noteAccountRequest('flood-token-0'); // an already-counted account still increments
    const w = collectAccountWindow();
    expect(w.active).to.be.at.most(10_000); // bounded despite 10050 distinct tokens
    expect(w.active).to.be.greaterThan(0);
  });
});
