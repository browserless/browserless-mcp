import { expect } from 'chai';
import { metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  InMemoryLogRecordExporter,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  DataPointType,
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { registerApplicationInstruments } from '../../src/lib/metrics.js';
import {
  createSyncInstruments,
  recordToolRequest,
  recordUpstreamCall,
  recordRedisOp,
  recordRedisError,
  recordSessionLifetime,
  recordMcpRequest,
  mcpInFlightAdd,
  noteAccountRequest,
  collectAccountWindow,
  resetSyncInstruments,
} from '../../src/lib/metrics-recorders.js';

// Collect the exact instruments the server registers through an in-memory reader
// and assert the full exported inventory + each instrument's kind/attributes.
// This is the regression guard for the metric contract: a dropped metric, a
// gauge flipped to a counter, or a missing attribute fails here.
describe('metrics shape (full exported inventory)', () => {
  let provider: MeterProvider;
  let reader: PeriodicExportingMetricReader;
  let loggerProvider: LoggerProvider;
  const logExporter = new InMemoryLogRecordExporter();
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
    reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 2 ** 31 - 1,
    });
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    loggerProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
    });
    logs.setGlobalLoggerProvider(loggerProvider);

    registerApplicationInstruments(() => 2);
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
    noteAccountRequest('token-aaa');
    noteAccountRequest('token-aaa');
    noteAccountRequest('token-bbb'); // 2 distinct accounts; aaa is the top talker

    await new Promise((r) => setTimeout(r, 40));
    await reader.forceFlush();
  });

  after(async () => {
    await provider.shutdown();
    await loggerProvider.shutdown();
    metrics.disable();
    logs.disable();
    mcpInFlightAdd(-2);
    resetSyncInstruments();
  });

  const all = (): MetricData[] =>
    captured.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
  const byName = (n: string): MetricData | undefined =>
    all().find((m) => m.descriptor.name === n);

  const EXPECTED = [
    'browserless.mcp.process.memory_bytes',
    'browserless.mcp.process.uptime_seconds',
    'browserless.mcp.auth.in_flight',
    'browserless.mcp.sessions.live',
    'browserless.mcp.sessions.tracked',
    'browserless.mcp.sessions.in_flight_exec',
    'browserless.mcp.agent.sessions.active',
    'browserless.mcp.agent.sessions.pending',
    'browserless.mcp.agent.commands.in_flight',
    'browserless.mcp.sessions.reaped',
    'browserless.mcp.agent.sessions.swept',
    'browserless.mcp.tool.requests',
    'browserless.mcp.tool.duration',
    'browserless.mcp.agent.upstream.duration',
    'browserless.mcp.redis.op.duration',
    'browserless.mcp.redis.errors',
    'browserless.mcp.session.cleanup.age',
    'browserless.mcp.requests',
    'browserless.mcp.auth.duration',
    'browserless.mcp.accounts.active',
  ];

  it('exports every expected metric name and nothing less', () => {
    const names = new Set(all().map((m) => m.descriptor.name));
    for (const n of EXPECTED)
      expect(names.has(n), `missing ${n}`).to.equal(true);
  });

  it('uses the correct instrument kind per metric', () => {
    const gauges = [
      'browserless.mcp.sessions.live',
      'browserless.mcp.auth.in_flight',
      'browserless.mcp.agent.sessions.pending',
      'browserless.mcp.process.uptime_seconds',
    ];
    for (const g of gauges)
      expect(byName(g)?.dataPointType, g).to.equal(DataPointType.GAUGE);

    const histograms = [
      'browserless.mcp.tool.duration',
      'browserless.mcp.agent.upstream.duration',
      'browserless.mcp.redis.op.duration',
      'browserless.mcp.session.cleanup.age',
      'browserless.mcp.auth.duration',
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

  it('exports duration values in seconds, converting millisecond inputs exactly once', () => {
    for (const [name, expected] of [
      ['browserless.mcp.tool.duration', [0.123, 0.045]],
      ['browserless.mcp.agent.upstream.duration', [0.2]],
      ['browserless.mcp.redis.op.duration', [0.003]],
      ['browserless.mcp.session.cleanup.age', [60, 120]],
      ['browserless.mcp.auth.duration', [0.015]],
    ] as const) {
      const metric = byName(name);
      expect(metric?.descriptor.unit, name).to.equal('s');
      expect(metric?.dataPointType, name).to.equal(DataPointType.HISTOGRAM);
      if (metric?.dataPointType === DataPointType.HISTOGRAM)
        expect(
          metric.dataPoints.map((p) => p.value.sum),
          name,
        ).to.have.members(expected);
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
    expect(req?.descriptor.unit).to.equal('{request}');
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
    const up = byName('browserless.mcp.agent.upstream.duration');
    expect(up?.dataPoints[0]?.attributes.method).to.equal('goto');
    const redis = byName('browserless.mcp.redis.op.duration');
    expect(redis?.dataPoints[0]?.attributes.op).to.equal('get');
    const req = byName('browserless.mcp.requests');
    expect(req?.descriptor.unit).to.equal('{request}');
    expect(
      req?.dataPoints.some((d) => d.attributes.outcome === 'authenticated'),
    ).to.equal(true);
    const life = byName('browserless.mcp.session.cleanup.age');
    const kinds = new Set(life?.dataPoints.map((d) => d.attributes.kind) ?? []);
    expect(kinds.has('mcp')).to.equal(true);
    expect(kinds.has('agent')).to.equal(true);
    expect(
      byName('browserless.mcp.auth.in_flight')?.dataPoints[0]?.value,
    ).to.equal(2);
  });

  it('logs bounded top accounts per window without retaining old account series', async () => {
    expect(
      byName('browserless.mcp.accounts.active')?.dataPoints[0]?.value,
    ).to.equal(2);
    expect(byName('browserless.mcp.account.requests')).to.equal(undefined);
    await loggerProvider.forceFlush();
    const first = logExporter.getFinishedLogRecords();
    expect(first).to.have.length(1);
    expect(first[0].body).to.have.property('active_accounts', 2);
    expect(first[0].body).to.have.nested.property('top_accounts[0].count', 2);
    expect(first[0].body)
      .to.have.nested.property('top_accounts[0].hash')
      .that.matches(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(first[0].body)).not.to.include('token-');

    noteAccountRequest('token-ccc');
    await reader.forceFlush();
    await loggerProvider.forceFlush();
    const second = logExporter.getFinishedLogRecords();
    expect(second).to.have.length(2);
    expect(second[1].body).to.have.property('active_accounts', 1);
    expect(second[1].body).to.have.property('top_accounts').with.length(1);
    expect(second[1].body).to.have.nested.property('top_accounts[0].count', 1);
    expect(second[1].body).not.to.deep.equal(first[0].body);

    await reader.forceFlush();
    await loggerProvider.forceFlush();
    expect(logExporter.getFinishedLogRecords()).to.have.length(2);
    const latest = captured.at(-1)!.scopeMetrics.flatMap((s) => s.metrics);
    expect(
      latest.find(
        (m) => m.descriptor.name === 'browserless.mcp.accounts.active',
      )?.dataPoints[0].value,
    ).to.equal(0);
    expect(
      latest.some((m) =>
        m.dataPoints.some((p) => 'account_hash' in p.attributes),
      ),
    ).to.equal(false);
  });

  it('caps the account window so a distinct-token flood cannot grow it unbounded', () => {
    // before()'s forceFlush drained the window; accountsEnabled is still on.
    for (let i = 0; i < 10_050; i++) noteAccountRequest('flood-token-' + i);
    noteAccountRequest('flood-token-0'); // an already-counted account still increments
    const w = collectAccountWindow();
    expect(w.active).to.be.at.most(10_000); // bounded despite 10050 distinct tokens
    expect(w.active).to.be.greaterThan(0);
    expect(w.top).to.have.length(20);
    expect(w.top[0].count).to.equal(2);
  });
});
