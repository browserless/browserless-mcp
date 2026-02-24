import { expect } from 'chai';
import sinon from 'sinon';
import { createApiClient } from '../../src/lib/api-client.js';
import type { McpConfig } from '../../src/config.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 60000,
};

const mockSuccessResponse = {
  ok: true,
  statusCode: 200,
  content: '<html>Hello</html>',
  contentType: 'text/html',
  headers: { 'content-type': 'text/html' },
  strategy: 'http-fetch',
  attempted: ['http-fetch'],
  message: null,
  screenshot: null,
  pdf: null,
  markdown: '# Hello',
  links: null,
};

describe('createApiClient', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('powerScrape', () => {
    it('sends correct request to the /power-scrape endpoint', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockSuccessResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.powerScrape({ url: 'https://example.com' });

      expect(fetchStub.calledOnce).to.be.true;
      const [url, options] = fetchStub.firstCall.args;
      expect(url).to.include('https://api.example.com/power-scrape');
      expect(url).to.include('token=test-token');
      expect(url).to.include('timeout=30000');
      expect(options.method).to.equal('POST');
      const body = JSON.parse(options.body);
      expect(body.url).to.equal('https://example.com');
      expect(body.formats).to.deep.equal(['markdown']);
    });

    it('returns parsed response', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockSuccessResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      const result = await client.powerScrape({
        url: 'https://example.com',
      });

      expect(result.ok).to.be.true;
      expect(result.strategy).to.equal('http-fetch');
      expect(result.markdown).to.equal('# Hello');
      expect(result.links).to.be.null;
    });

    it('uses custom timeout from params', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockSuccessResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.powerScrape({
        url: 'https://example.com',
        timeout: 5000,
      });

      const [url] = fetchStub.firstCall.args;
      expect(url).to.include('timeout=5000');
    });

    it('caches identical requests', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockSuccessResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.powerScrape({ url: 'https://example.com' });
      await client.powerScrape({ url: 'https://example.com' });

      expect(fetchStub.calledOnce).to.be.true;
    });

    it('does not cache different requests', async () => {
      fetchStub.callsFake(() =>
        Promise.resolve(
          new Response(JSON.stringify(mockSuccessResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const client = createApiClient(mockConfig);
      await client.powerScrape({ url: 'https://example.com' });
      await client.powerScrape({ url: 'https://other.com' });

      expect(fetchStub.calledTwice).to.be.true;
    });

    it('forwards formats array in request body', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockSuccessResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.powerScrape({
        url: 'https://example.com',
        formats: ['markdown', 'screenshot', 'pdf', 'links'],
      });

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body.formats).to.deep.equal([
        'markdown',
        'screenshot',
        'pdf',
        'links',
      ]);
    });

    it('throws on 500 errors', async () => {
      fetchStub.resolves(
        new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );

      const client = createApiClient(mockConfig);
      try {
        await client.powerScrape({ url: 'https://example.com' });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).to.include('Server error 500');
      }
    });
  });

  describe('getStatus', () => {
    it('returns ok when API is reachable', async () => {
      fetchStub.resolves(new Response('[]', { status: 200 }));

      const client = createApiClient(mockConfig);
      const status = await client.getStatus();

      expect(status.ok).to.be.true;
      expect(status.message).to.equal('Browserless API is reachable');
    });

    it('returns not ok on non-200 status', async () => {
      fetchStub.resolves(
        new Response('Unauthorized', { status: 401 }),
      );

      const client = createApiClient(mockConfig);
      const status = await client.getStatus();

      expect(status.ok).to.be.false;
      expect(status.message).to.include('401');
    });

    it('returns not ok on network error', async () => {
      fetchStub.rejects(new Error('ECONNREFUSED'));

      const client = createApiClient(mockConfig);
      const status = await client.getStatus();

      expect(status.ok).to.be.false;
      expect(status.message).to.include('ECONNREFUSED');
    });
  });
});
