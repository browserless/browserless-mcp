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
  recordMcpRequest,
  recordGcPause,
  mcpInFlightAdd,
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
    mcpInFlightAdd(2);
    recordToolRequest('browserless_scrape', true, 123);
    recordToolRequest('browserless_scrape', false, 45, 'target_website');
    recordUpstreamCall('goto', true, 200);
    recordRedisOp('get', true, 3);
    recordRedisError();
    recordSessionLifetime('mcp', 60_000);
    recordSessionLifetime('agent', 120_000);
    recordMcpRequest('authenticated', 15);
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
    'browserless.mcp.eventloop.delay.p50_ms',
    'browserless.mcp.eventloop.delay.p99_ms',
    'browserless.mcp.eventloop.utilization',
    'browserless.mcp.process.memory_bytes',
    'browserless.mcp.process.active_resources',
    'browserless.mcp.process.uptime_seconds',
    'browserless.mcp.requests.in_flight',
    'browserless.mcp.sessions.live',
    'browserless.mcp.sessions.tracked',
    'browserless.mcp.sessions.in_flight_exec',
    'browserless.mcp.agent.sessions.active',
    'browserless.mcp.agent.sessions.pending',
    'browserless.mcp.agent.commands.in_flight',
    'browserless.mcp.sessions.reaped',
    'browserless.mcp.agent.sessions.swept',
    'browserless.mcp.tool.requests',
    'browserless.mcp.tool.duration_ms',
    'browserless.mcp.agent.upstream.duration_ms',
    'browserless.mcp.redis.op.duration_ms',
    'browserless.mcp.redis.errors',
    'browserless.mcp.session.lifetime_ms',
    'browserless.mcp.requests',
    'browserless.mcp.request.duration_ms',
    'browserless.mcp.gc.pause_ms',
    'browserless.mcp.accounts.active',
    'browserless.mcp.account.requests',
  ];

  it('exports every expected metric name and nothing less', () => {
    const names = new Set(all().map((m) => m.descriptor.name));
    for (const n of EXPECTED)
      expect(names.has(n), `missing ${n}`).to.equal(true);
  });

  it('uses the correct instrument kind per metric', () => {
    const gauges = [
      'browserless.mcp.eventloop.utilization',
      'browserless.mcp.sessions.live',
      'browserless.mcp.requests.in_flight',
      'browserless.mcp.agent.sessions.pending',
      'browserless.mcp.process.uptime_seconds',
    ];
    for (const g of gauges)
      expect(byName(g)?.dataPointType, g).to.equal(DataPointType.GAUGE);

    const histograms = [
      'browserless.mcp.tool.duration_ms',
      'browserless.mcp.agent.upstream.duration_ms',
      'browserless.mcp.redis.op.duration_ms',
      'browserless.mcp.session.lifetime_ms',
      'browserless.mcp.request.duration_ms',
      'browserless.mcp.gc.pause_ms',
    ];
    for (const h of histograms)
      expect(byName(h)?.dataPointType, h).to.equal(DataPointType.HISTOGRAM);

    for (const c of [
      'browserless.mcp.sessions.reaped',
      'browserless.mcp.agent.sessions.swept',
      'browserless.mcp.tool.requests',
      'browserless.mcp.redis.errors',
      'browserless.mcp.requests',
    ]) {
      const m = byName(c);
      expect(m?.dataPointType, c).to.equal(DataPointType.SUM);
      if (m?.dataPointType === DataPointType.SUM)
        expect(m.isMonotonic, c).to.equal(true);
    }
  });

  it('splits process.memory_bytes across rss/heap_used/heap_total/external in bytes', () => {
    const mem = byName('browserless.mcp.process.memory_bytes');
    expect(mem?.descriptor.unit).to.equal('By');
    const types = new Set(
      mem?.dataPoints.map((d) => d.attributes.type as string) ?? [],
    );
    for (const t of ['rss', 'heap_used', 'heap_total', 'external'])
      expect(types.has(t), t).to.equal(true);
  });

  it('tags tool metrics with tool + success, and error_category on failures only', () => {
    const req = byName('browserless.mcp.tool.requests');
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
    const up = byName('browserless.mcp.agent.upstream.duration_ms');
    expect(up?.dataPoints[0]?.attributes.method).to.equal('goto');
    const redis = byName('browserless.mcp.redis.op.duration_ms');
    expect(redis?.dataPoints[0]?.attributes.op).to.equal('get');
    const req = byName('browserless.mcp.requests');
    expect(
      req?.dataPoints.some((d) => d.attributes.outcome === 'authenticated'),
    ).to.equal(true);
    const life = byName('browserless.mcp.session.lifetime_ms');
    const kinds = new Set(life?.dataPoints.map((d) => d.attributes.kind) ?? []);
    expect(kinds.has('mcp')).to.equal(true);
    expect(kinds.has('agent')).to.equal(true);
    expect(
      byName('browserless.mcp.requests.in_flight')?.dataPoints[0]?.value,
    ).to.equal(2);
  });

  it('tracks distinct accounts and the top talkers by hashed token (no raw token)', () => {
    expect(
      byName('browserless.mcp.accounts.active')?.dataPoints[0]?.value,
    ).to.equal(2);
    const acct = byName('browserless.mcp.account.requests');
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
