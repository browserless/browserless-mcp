import { expect } from 'chai';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sinon from 'sinon';
import {
  amplitudeFailureReason,
  noteAmplitudeResult,
  noteAmplitudeSdkLog,
  flushAmplitudeDelivery,
} from '../../src/lib/amplitude-delivery.js';

describe('Amplitude delivery summaries', () => {
  let receiver: http.Server;
  let previous: NodeJS.ProcessEnv;
  let bodies: string[];
  let warnings: sinon.SinonStub;
  const records = () =>
    bodies.map((body) => {
      const record =
        JSON.parse(body).resourceLogs[0].scopeLogs[0].logRecords[0];
      expect(record.body.stringValue).to.equal(
        'browserless.mcp.amplitude.delivery_failed',
      );
      expect(record.severityText).to.equal('WARN');
      return Object.fromEntries(
        record.attributes.map(
          (a: {
            key: string;
            value: { stringValue?: string; intValue?: string };
          }) => [a.key, a.value.stringValue ?? Number(a.value.intValue)],
        ),
      );
    });
  const settle = async () => {
    for (let i = 0; i < 100 && bodies.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  beforeEach(async () => {
    previous = { ...process.env };
    bodies = [];
    warnings = sinon.stub(console, 'warn');
    receiver = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      bodies.push(body);
      res.end('{}');
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, '127.0.0.1', resolve),
    );
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/v1/logs`;
  });
  afterEach(async () => {
    flushAmplitudeDelivery();
    sinon.restore();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    process.env = previous;
  });

  it('keeps only a bounded, escaped and redacted reason', () => {
    const sentence = 'a short plain sentence '.repeat(10);
    for (const [input, expected] of [
      ['Invalid API key: abcdefABCDEF0123456789', 'Invalid API key'],
      ['Request missing required field', 'Request missing required field'],
      [
        'Invalid field values on some events',
        'Invalid field values on some events',
      ],
      ['bad token AbCdEfGh0123456789xyz here', 'bad token [redacted] here'],
      ['Invalid account alice@example.com', 'Invalid account [redacted]'],
      ['x\u0000y', 'x\\u0000y'],
      [sentence, sentence.slice(0, 80)],
      ['', 'unknown'],
      [undefined, 'unknown'],
      [42, 'unknown'],
      [{}, 'unknown'],
    ])
      expect(amplitudeFailureReason(input)).to.equal(expected);
  });

  it('groups failures by type, status and sanitized reason, not payload', async () => {
    for (const code of [200, 100]) noteAmplitudeResult({ code });
    flushAmplitudeDelivery();
    expect(warnings.called).to.equal(false);
    for (let i = 0; i < 3; i++)
      noteAmplitudeResult({
        event: { event_type: 'test event' },
        code: 400,
        message: 'Invalid API key: private-value-0123456789',
      });
    noteAmplitudeResult({
      event: { event_type: 'test event' },
      code: 500,
      message: 'unavailable',
    });
    noteAmplitudeResult({ event: { event_type: 7 }, code: 401 });
    noteAmplitudeResult({ event: { event_type: 'x'.repeat(100) }, code: 402 });
    flushAmplitudeDelivery();
    await settle();
    expect(records()).to.have.length(4);
    expect(records()[0]).to.include({
      event_type: 'test event',
      status: 400,
      reason: 'Invalid API key',
      count: 3,
      window_s: 60,
    });
    expect(records()[1]).to.include({ status: 500, count: 1 });
    expect(records()[2].event_type).to.equal('unknown');
    expect(records()[3].event_type).to.equal('x'.repeat(64));
    expect(warnings.callCount).to.equal(1);
    expect(warnings.firstCall.args.join(' ')).to.include('400: 3');
    expect(warnings.firstCall.args.join(' ')).not.to.match(
      /test event|Invalid API key|private-value/,
    );
    expect(bodies.join('')).not.to.include('private-value');
  });

  it('caps each burst at twelve keys plus a counted overflow', async () => {
    for (let i = 0; i < 1000; i++)
      noteAmplitudeResult({
        event: { event_type: `event ${i % 50}` },
        code: 400,
        message: 'bad request',
      });
    flushAmplitudeDelivery();
    await settle();
    expect(records()).to.have.length(13);
    expect(records().find((r) => r.event_type === 'other')).to.include({
      status: 0,
      reason: 'overflow',
      count: 760,
    });
    expect(records().reduce((n, r) => n + r.count, 0)).to.equal(1000);
    expect(warnings.callCount).to.equal(1);
  });

  it('starts a lazy sixty-second window and resets after flushing', async () => {
    const clock = sinon.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
    });
    try {
      noteAmplitudeSdkLog('error');
      noteAmplitudeSdkLog('warn');
      clock.tick(59_999);
      expect(warnings.called).to.equal(false);
      clock.tick(1);
      expect(warnings.firstCall.args[0]).to.include('SDK errors 1, warnings 1');
      flushAmplitudeDelivery();
      expect(warnings.callCount).to.equal(1);
      noteAmplitudeSdkLog('warn');
      clock.tick(60_000);
      expect(warnings.callCount).to.equal(2);
      expect(warnings.lastCall.args[0]).to.include('SDK errors 0, warnings 1');
      expect(bodies).to.have.length(0);
    } finally {
      clock.restore();
    }
  });
});
