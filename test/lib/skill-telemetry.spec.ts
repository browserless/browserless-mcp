import { expect } from 'chai';
import { createServer } from 'node:http';
import { once } from 'node:events';
import sinon from 'sinon';
import {
  logSkillEvent,
  retrievalSchema,
  skillSource,
} from '../../src/lib/skill-telemetry.js';

describe('skill telemetry contract', () => {
  const completion = {
    result: 'miss',
    skill_count: 0,
    domain: 'shop.example',
    request_id: '416e0409-25e2-4399-a3fa-6939f43a75e0',
    attempt: 1,
    duration_ms: 17,
    stage: 'validate',
    http_status: 200,
  };

  it('rejects incompatible results, unbounded identities, and sensitive domain values', () => {
    expect(retrievalSchema.safeParse(completion).success).to.equal(true);
    for (const change of [
      { result: 'hit' },
      { skill_count: -1 },
      { request_id: 'secret request' },
      { domain: 'https://shop.example/path?token=secret' },
      { domain: 'a'.repeat(254) },
      { duration_ms: Infinity },
      { duration_ms: -1 },
      { attempt: 101 },
      { http_status: 600 },
      { run_id: 'secret run' },
      { result: 'error', error_category: 'raw response' },
    ])
      expect(
        retrievalSchema.safeParse({ ...completion, ...change }).success,
        JSON.stringify(change),
      ).to.equal(false);
    const parsed = retrievalSchema.parse({
      ...completion,
      token: 'secret',
      _prompt: 'secret',
      body: 'secret',
    });
    expect(parsed).to.deep.equal(completion);
    expect(skillSource('mcp_client')).to.equal('mcp_client');
    expect(skillSource('private client name')).to.equal('unknown');
  });

  it('delivers OTLP JSON to a local HTTP sink and isolates non-2xx responses without retry', async () => {
    const received: { path?: string; contentType?: string; body: string }[] =
      [];
    const sink = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      received.push({
        path: req.url,
        contentType: req.headers['content-type'],
        body,
      });
      res.writeHead(503).end('{}');
    });
    sink.listen(0, '127.0.0.1');
    await once(sink, 'listening');
    const address = sink.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing test listener');
    const previous = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `http://127.0.0.1:${address.port}/v1/logs`;
    try {
      await logSkillEvent('skill.retrieval.failed', {
        request_id: completion.request_id,
        domain: completion.domain,
        result: 'error',
        error_category: 'http_error',
        http_status: 429,
        duration_ms: 17,
        attempt: 1,
        stage: 'fetch',
        source: 'mcp_client',
      });
      expect(received).to.have.length(1);
      expect(received[0]).to.include({
        path: '/v1/logs',
        contentType: 'application/json',
      });
      const resource = JSON.parse(received[0].body).resourceLogs[0];
      expect(resource.resource.attributes).to.deep.equal([
        { key: 'service.name', value: { stringValue: 'browserless-mcp' } },
      ]);
      const record = resource.scopeLogs[0].logRecords[0];
      expect(record).to.include({ severityNumber: 13, severityText: 'WARN' });
      expect(record.attributes).to.deep.include({
        key: 'event.name',
        value: { stringValue: 'skill.retrieval.failed' },
      });
      expect(record.attributes).to.deep.include({
        key: 'http_status',
        value: { intValue: '429' },
      });
    } finally {
      if (previous === undefined)
        delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = previous;
      sink.close();
      await once(sink, 'close');
    }
  });

  it('bounds concurrent exports and disables transport when no endpoint is configured', async () => {
    const previous = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    const fetcher = sinon.stub(globalThis, 'fetch');
    let resolve!: (response: Response) => void;
    fetcher.returns(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    try {
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      await logSkillEvent('skill.retrieval.failed', {});
      expect(fetcher.callCount).to.equal(0);
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT =
        'http://127.0.0.1:4318/v1/logs';
      const exports = Array.from({ length: 25 }, () =>
        logSkillEvent('skill.retrieval.failed', {}),
      );
      expect(fetcher.callCount).to.equal(16);
      resolve(new Response('{}'));
      await Promise.all(exports);
    } finally {
      fetcher.restore();
      if (previous === undefined)
        delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = previous;
    }
  });
});
