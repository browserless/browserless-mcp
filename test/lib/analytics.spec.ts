import { expect } from 'chai';
import sinon from 'sinon';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { AnalyticsHelper } from '../../src/lib/analytics.js';
import { djb2 } from '../../src/lib/utils.js';

// send() rejects tokens shorter than 20 chars (consumer contract)
const TOKEN = 'test-token-0123456789abcdef';

describe('AnalyticsHelper', () => {
  let sqsSendStub: sinon.SinonStub;

  beforeEach(() => {
    sqsSendStub = sinon.stub(SQSClient.prototype, 'send');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('does not initialize when disabled', () => {
    const helper = new AnalyticsHelper(
      false,
      'https://sqs.example.com/queue',
      'us-east-1',
    );
    // send should return false since disabled
    return helper.send('Test Event', 123, { token: TOKEN }).then((result) => {
      expect(result).to.be.false;
      expect(sqsSendStub.called).to.be.false;
    });
  });

  it('exports one classified completion and a matching safe OTLP failure', async () => {
    const fetcher = sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response('{}'));
    const oldEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
      'http://127.0.0.1:4318/v1/logs';
    try {
      sqsSendStub.resolves({ Failed: [] });
      const helper = new AnalyticsHelper(
        true,
        'https://sqs.example.com/queue',
        'us-east-1',
      );
      helper.fireSkillRetrieval(
        TOKEN,
        {
          result: 'error',
          error_category: 'http_error',
          http_status: 429,
          domain: 'shop.example',
          request_id: '416e0409-25e2-4399-a3fa-6939f43a75e0',
          attempt: 1,
          duration_ms: 13,
          stage: 'fetch',
          ...{
            token: 'secret-token',
            url: 'https://secret/?password=secret',
            _prompt: 'secret prompt',
          },
        },
        'https://private/?token=secret',
      );
      await new Promise(setImmediate);
      expect(sqsSendStub.callCount).to.equal(1);
      const event = JSON.parse(
        sqsSendStub.firstCall.args[0].input.Entries[0].MessageBody,
      );
      expect(event.event_type).to.equal('Skill Retrieval Completed');
      expect(event.event_properties).to.include({
        token: TOKEN,
        source: 'unknown',
        result: 'error',
        http_status: 429,
      });
      expect(event.event_properties).not.to.have.property('skill_count');
      expect(event.event_properties).not.to.have.property('url');
      expect(event.event_properties).not.to.have.property('_prompt');
      expect(fetcher.callCount).to.equal(1);
      const payload = JSON.parse(fetcher.firstCall.args[1]?.body as string);
      const record = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
      expect(record.severityText).to.equal('WARN');
      const fields = Object.fromEntries(
        record.attributes.map(
          (a: {
            key: string;
            value: { stringValue?: string; intValue?: string };
          }) => [a.key, a.value.stringValue ?? Number(a.value.intValue)],
        ),
      );
      expect(fields).to.include({
        'event.name': 'skill.retrieval.failed',
        request_id: event.event_properties.request_id,
        http_status: 429,
        duration_ms: 13,
      });
      expect(JSON.stringify(payload)).not.to.match(
        /secret|password|prompt|token/,
      );
    } finally {
      if (oldEndpoint === undefined)
        delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = oldEndpoint;
    }
  });

  it('does not initialize when queue URL is missing', () => {
    const helper = new AnalyticsHelper(true, undefined, 'us-east-1');
    return helper.send('Test Event', 123, { token: TOKEN }).then((result) => {
      expect(result).to.be.false;
      expect(sqsSendStub.called).to.be.false;
    });
  });

  it('rate limits caught delivery failures and never recursively logs a failing exporter', async () => {
    sinon.useFakeTimers({ now: Date.now() + 120_000, toFake: ['Date'] });
    const fetcher = sinon
      .stub(globalThis, 'fetch')
      .rejects(new Error('secret transport failure'));
    const oldEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
      'http://127.0.0.1:4318/v1/logs';
    try {
      sqsSendStub.rejects(new Error('secret queue failure'));
      const helper = new AnalyticsHelper(
        true,
        'https://sqs.example.com/queue',
        'us-east-1',
      );
      for (let i = 0; i < 3; i++)
        helper.fireSkillRetrieval(
          TOKEN,
          {
            result: 'miss',
            skill_count: 0,
            domain: 'shop.example',
            request_id: '416e0409-25e2-4399-a3fa-6939f43a75e0',
            attempt: 1,
            duration_ms: 9,
            stage: 'validate',
          },
          'mcp_client',
        );
      await new Promise(setImmediate);
      expect(sqsSendStub.callCount).to.equal(9);
      expect(fetcher.callCount).to.equal(1);
      expect(String(fetcher.firstCall.args[1]?.body)).to.include(
        'skill.telemetry.delivery_failed',
      );
      expect(String(fetcher.firstCall.args[1]?.body)).to.include(
        'Skill Retrieval Completed',
      );
      expect(String(fetcher.firstCall.args[1]?.body)).not.to.include('secret');
    } finally {
      if (oldEndpoint === undefined)
        delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = oldEndpoint;
    }
  });

  it('sends event to SQS when enabled and configured', async () => {
    sqsSendStub.resolves({ Failed: [] });

    const helper = new AnalyticsHelper(
      true,
      'https://sqs.example.com/queue',
      'us-east-1',
    );
    const result = await helper.send('MCP Tool Request', 12345, {
      token: TOKEN,
      tool: 'browserless_smartscraper',
      url: 'https://example.com',
    });

    expect(result).to.be.true;
    expect(sqsSendStub.calledOnce).to.be.true;

    const command = sqsSendStub.firstCall.args[0];
    expect(command).to.be.instanceOf(SendMessageBatchCommand);
    expect(command.input.QueueUrl).to.equal('https://sqs.example.com/queue');

    const entries = command.input.Entries;
    expect(entries).to.have.length(1);

    const event = JSON.parse(entries[0].MessageBody);
    expect(event.event_type).to.equal('MCP Tool Request');
    expect(event.session_id).to.equal(12345);
    expect(event.event_properties.token).to.equal(TOKEN);
    expect(event.event_properties.tool).to.equal('browserless_smartscraper');
    expect(event.event_properties.url).to.equal('https://example.com');
    expect(event.time).to.be.a('number');
    expect(event.insert_id).to.be.a('string');
  });

  it('rejects events whose token is missing or shorter than 20 chars', async () => {
    const helper = new AnalyticsHelper(
      true,
      'https://sqs.example.com/queue',
      'us-east-1',
    );
    expect(await helper.send('Test Event', 123, { token: 'abc' })).to.be.false;
    expect(await helper.send('Test Event', 123, { token: '' })).to.be.false;
    expect(sqsSendStub.called).to.be.false;
  });

  it('returns false when SQS reports failed entries', async () => {
    sqsSendStub.resolves({
      Failed: [{ Id: 'msg-1', Code: 'InternalError', SenderFault: false }],
    });

    const helper = new AnalyticsHelper(
      true,
      'https://sqs.example.com/queue',
      'us-east-1',
    );
    const result = await helper.send('Test Event', 123, { token: TOKEN });

    expect(result).to.be.false;
  });

  it('retries on SQS errors and returns false after exhausting retries', async () => {
    sqsSendStub.rejects(new Error('Network error'));

    const helper = new AnalyticsHelper(
      true,
      'https://sqs.example.com/queue',
      'us-east-1',
    );
    const result = await helper.send('Test Event', 123, { token: TOKEN });

    expect(result).to.be.false;
    // 3 retries
    expect(sqsSendStub.callCount).to.equal(3);
  });

  it('succeeds on retry after initial failure', async () => {
    sqsSendStub
      .onFirstCall()
      .rejects(new Error('Temporary failure'))
      .onSecondCall()
      .resolves({ Failed: [] });

    const helper = new AnalyticsHelper(
      true,
      'https://sqs.example.com/queue',
      'us-east-1',
    );
    const result = await helper.send('Test Event', 123, { token: TOKEN });

    expect(result).to.be.true;
    expect(sqsSendStub.callCount).to.equal(2);
  });

  it('does not re-initialize if already initialized', () => {
    const helper = new AnalyticsHelper(
      true,
      'https://sqs.example.com/queue',
      'us-east-1',
    );
    // Call initialize again — should be a no-op
    helper.initialize('https://other.example.com/queue', 'eu-west-1');

    sqsSendStub.resolves({ Failed: [] });
    return helper.send('Test Event', 123, { token: TOKEN }).then(() => {
      const command = sqsSendStub.firstCall.args[0];
      // Should still use the original queue URL
      expect(command.input.QueueUrl).to.equal('https://sqs.example.com/queue');
    });
  });
});

describe('djb2', () => {
  it('returns a consistent hash for the same input', () => {
    const hash1 = djb2('test-token');
    const hash2 = djb2('test-token');
    expect(hash1).to.equal(hash2);
  });

  it('returns different hashes for different inputs', () => {
    const hash1 = djb2('token-a');
    const hash2 = djb2('token-b');
    expect(hash1).to.not.equal(hash2);
  });

  it('returns an unsigned 32-bit integer', () => {
    const hash = djb2('any-string');
    expect(hash).to.be.at.least(0);
    expect(hash).to.be.at.most(0xffffffff);
  });
});
