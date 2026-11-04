import { expect } from 'chai';
import sinon from 'sinon';
import { exportLogRecord, type LogSeverity } from '../../src/lib/otlp-log.js';
import { logSkillEvent } from '../../src/lib/skill-telemetry.js';

describe('operator log transport', () => {
  let previous: NodeJS.ProcessEnv;
  beforeEach(() => {
    previous = { ...process.env };
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_ENABLED;
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.TRANSPORT;
  });
  afterEach(() => {
    process.env = previous;
    sinon.restore();
  });
  const record = (severity: LogSeverity = 'WARN') =>
    exportLogRecord({
      scope: 'session-requests',
      event: 'request-test',
      severity,
      attributes: { flag: true, count: 7, text: 'test' },
    });

  it('encodes attributes and severities at the configured endpoint', async () => {
    const fetcher = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(null));
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
      'http://127.0.0.1:9/explicit';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9/base';
    for (const [severity, number] of [
      ['INFO', 9],
      ['WARN', 13],
      ['ERROR', 17],
    ] as const) {
      await record(severity);
      expect(fetcher.lastCall.args[0]).to.equal('http://127.0.0.1:9/explicit');
      const scope = JSON.parse(fetcher.lastCall.args[1]!.body as string)
        .resourceLogs[0].scopeLogs[0];
      expect(scope.scope.name).to.equal('session-requests');
      expect(scope.logRecords[0]).to.include({
        severityNumber: number,
        severityText: severity,
      });
      expect(scope.logRecords[0].attributes).to.deep.equal([
        { key: 'flag', value: { boolValue: true } },
        { key: 'count', value: { intValue: '7' } },
        { key: 'text', value: { stringValue: 'test' } },
        { key: 'event.name', value: { stringValue: 'request-test' } },
      ]);
    }
  });

  it('gates the base fallback and tolerates endpoint failures', async () => {
    const fetcher = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(null, { status: 500 }));
    await record();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9/base/';
    for (const [enabled, transport] of [
      ['false', 'httpStream'],
      ['true', 'stdio'],
    ]) {
      process.env.OTEL_ENABLED = enabled;
      process.env.TRANSPORT = transport;
      await record();
    }
    expect(fetcher.callCount).to.equal(0);
    process.env.TRANSPORT = 'httpStream';
    await record();
    expect(fetcher.firstCall.args[0]).to.equal(
      'http://127.0.0.1:9/base/v1/logs',
    );
    fetcher.throws(new Error('unavailable'));
    await record();
    fetcher.restore();
    await record();
  });

  it('honors the normalized hosted opt-out for skill log fallback', async () => {
    const fetcher = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response(null));
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9/base/';
    process.env.OTEL_ENABLED = 'true';
    process.env.TRANSPORT = 'httpStream';
    for (const disabled of ['true', 'TRUE', ' \tTrUe\n']) {
      process.env.OTEL_SDK_DISABLED = disabled;
      await logSkillEvent('skill.retrieval.failed', { domain: 'shop.example' });
      await logSkillEvent('skill.telemetry.delivery_failed', {});
      expect(fetcher.callCount, JSON.stringify(disabled)).to.equal(0);
    }
    for (const disabled of [undefined, 'false', '']) {
      if (disabled === undefined) delete process.env.OTEL_SDK_DISABLED;
      else process.env.OTEL_SDK_DISABLED = disabled;
      await logSkillEvent('skill.retrieval.failed', {});
      expect(fetcher.lastCall.args[0]).to.equal(
        'http://127.0.0.1:9/base/v1/logs',
      );
    }
    expect(fetcher.callCount).to.equal(3);

    // The separately configured logs endpoint remains an independent opt-in.
    process.env.OTEL_SDK_DISABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
      'http://127.0.0.1:9/explicit';
    await logSkillEvent('skill.retrieval.failed', {});
    expect(fetcher.callCount).to.equal(4);
    expect(fetcher.lastCall.args[0]).to.equal('http://127.0.0.1:9/explicit');
  });

  it('shares the sixteen-export limit with skill records and releases slots', async () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://127.0.0.1:9/v1/logs';
    let resolve!: (value: Response) => void;
    const fetcher = sinon.stub(globalThis, 'fetch').returns(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const pending = [
      logSkillEvent('skill.retrieval.failed', {}),
      ...Array.from({ length: 16 }, () => record()),
    ];
    expect(fetcher.callCount).to.equal(16);
    resolve(new Response(null));
    await Promise.all(pending);
    fetcher.resolves(new Response(null));
    await record();
    expect(fetcher.callCount).to.equal(17);
  });
});
