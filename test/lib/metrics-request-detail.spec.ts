import { expect } from 'chai';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  DataPointType,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import * as recorders from '../../src/lib/metrics-recorders.js';
import {
  noteMissingStoreContext,
  resetSessionRequestLog,
} from '../../src/lib/session-request-log.js';

describe('request metric details', () => {
  it('adds counter detail without changing duration attributes', async () => {
    const captured: ResourceMetrics[] = [];
    const reader = new PeriodicExportingMetricReader({
      exportIntervalMillis: 2 ** 31 - 1,
      exporter: {
        export: (data, done) => {
          captured.push(data);
          done({ code: 0 });
        },
        forceFlush: async () => {},
        shutdown: async () => {},
        selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
      },
    });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    try {
      recorders.createSyncInstruments();
      const record = recorders.recordMcpRequest;
      record('session_mismatch', 1, 'GET', {
        reason: 'unknown_session',
        cursor: 'prior_process',
      });
      record('rejected', 2, 'POST', { reason: 'missing_credentials' });
      record('authenticated', 3, 'DELETE');
      resetSessionRequestLog();
      noteMissingStoreContext('full');
      noteMissingStoreContext('full');
      await reader.forceFlush();
      const all = captured.flatMap((r) =>
        r.scopeMetrics.flatMap((s) => s.metrics),
      );
      const context = all.find(
        (m) =>
          m.descriptor.name === 'browserless.mcp.event_store.context_missing',
      );
      expect(context?.dataPointType).to.equal(DataPointType.SUM);
      expect(context?.dataPoints[0].value).to.equal(2);
      expect(
        all
          .find((m) => m.descriptor.name === 'browserless.mcp.requests')
          ?.dataPoints.map((p) => p.attributes),
      ).to.deep.equal([
        {
          outcome: 'session_mismatch',
          method: 'GET',
          reason: 'unknown_session',
          cursor: 'prior_process',
        },
        { outcome: 'rejected', method: 'POST', reason: 'missing_credentials' },
        { outcome: 'authenticated', method: 'DELETE' },
      ]);
      const duration = all.find(
        (m) => m.descriptor.name === 'browserless.mcp.auth.duration',
      );
      expect(duration?.dataPointType).to.equal(DataPointType.HISTOGRAM);
      expect(duration?.dataPoints.map((p) => p.attributes)).to.deep.equal([
        { outcome: 'session_mismatch', method: 'GET' },
        { outcome: 'rejected', method: 'POST' },
        { outcome: 'authenticated', method: 'DELETE' },
      ]);
    } finally {
      await new Promise<void>((resolve) => setImmediate(resolve));
      resetSessionRequestLog();
      await provider.shutdown();
      metrics.disable();
      recorders.resetSyncInstruments();
    }
  });
});
