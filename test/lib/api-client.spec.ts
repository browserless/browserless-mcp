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
  analyticsEnabled: false,
  sqsRegion: 'us-east-1',
  oauthEnabled: false,
  supabaseUrl: '',
  supabaseOAuthClientId: '',
  supabaseOAuthClientSecret: '',
  supabaseServiceRoleKey: '',
  mcpBaseUrl: '',
  oauthAllowedRedirectUriPatterns: [],
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
    it('sends correct request to the /smart-scrape endpoint', async () => {
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
      expect(url).to.include('https://api.example.com/smart-scrape');
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
      expect(result.cacheHit).to.be.false;
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
      const first = await client.powerScrape({ url: 'https://example.com' });
      const second = await client.powerScrape({ url: 'https://example.com' });

      expect(fetchStub.calledOnce).to.be.true;
      expect(first.cacheHit).to.be.false;
      expect(second.cacheHit).to.be.true;
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

    it('isolates cache entries by profile', async () => {
      fetchStub.callsFake(() =>
        Promise.resolve(
          new Response(JSON.stringify(mockSuccessResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      const client = createApiClient(mockConfig);
      const first = await client.powerScrape({
        url: 'https://example.com',
        profile: 'user-a',
      });
      const second = await client.powerScrape({
        url: 'https://example.com',
        profile: 'user-b',
      });
      const third = await client.powerScrape({
        url: 'https://example.com',
        profile: 'user-a',
      });
      const fourth = await client.powerScrape({
        url: 'https://example.com',
      });

      expect(fetchStub.callCount).to.equal(3);
      expect(first.cacheHit).to.be.false;
      expect(second.cacheHit).to.be.false;
      expect(third.cacheHit).to.be.true;
      expect(fourth.cacheHit).to.be.false;
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

  describe('runFunction', () => {
    it('sends correct request to the /function endpoint', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify({ books: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.runFunction({
        code: 'export default async ({ page }) => ({ data: {}, type: "application/json" })',
        context: { page: 1 },
      });

      expect(fetchStub.calledOnce).to.be.true;
      const [url, options] = fetchStub.firstCall.args;
      expect(url).to.include('https://api.example.com/function');
      expect(url).to.include('token=test-token');
      expect(options.method).to.equal('POST');
      const body = JSON.parse(options.body);
      expect(body.code).to.be.a('string');
      expect(body.context).to.deep.equal({ page: 1 });
    });

    it('returns GenericApiResult with text data for JSON responses', async () => {
      fetchStub.resolves(
        new Response('{"result":"ok"}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      const result = await client.runFunction({ code: 'test' });

      expect(result.ok).to.be.true;
      expect(result.statusCode).to.equal(200);
      expect(result.isBinary).to.be.false;
      expect(result.data).to.equal('{"result":"ok"}');
      expect(result.contentType).to.equal('application/json');
    });

    it('returns GenericApiResult with base64 data for binary responses', async () => {
      const pdfBuffer = Buffer.from('fake-pdf');
      fetchStub.resolves(
        new Response(pdfBuffer, {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        }),
      );

      const client = createApiClient(mockConfig);
      const result = await client.runFunction({ code: 'test' });

      expect(result.ok).to.be.true;
      expect(result.isBinary).to.be.true;
      expect(result.data).to.equal(pdfBuffer.toString('base64'));
    });

    it('does not include context when not provided', async () => {
      fetchStub.resolves(
        new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.runFunction({ code: 'test' });

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body).to.not.have.property('context');
    });
  });

  describe('download', () => {
    it('sends correct request to the /download endpoint', async () => {
      fetchStub.resolves(
        new Response('csv,data', {
          status: 200,
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="data.csv"',
          },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.download({ code: 'test-code' });

      expect(fetchStub.calledOnce).to.be.true;
      const [url] = fetchStub.firstCall.args;
      expect(url).to.include('https://api.example.com/download');
    });

    it('returns content-disposition header', async () => {
      fetchStub.resolves(
        new Response('csv,data', {
          status: 200,
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="data.csv"',
          },
        }),
      );

      const client = createApiClient(mockConfig);
      const result = await client.download({ code: 'test-code' });

      expect(result.contentDisposition).to.include('data.csv');
      expect(result.isBinary).to.be.false;
      expect(result.data).to.equal('csv,data');
    });
  });

  describe('exportPage', () => {
    it('sends correct request to the /export endpoint', async () => {
      fetchStub.resolves(
        new Response('<html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.exportPage({
        url: 'https://example.com',
        gotoOptions: { waitUntil: 'networkidle0' },
        bestAttempt: true,
      });

      expect(fetchStub.calledOnce).to.be.true;
      const [url, options] = fetchStub.firstCall.args;
      expect(url).to.include('https://api.example.com/export');
      expect(url).to.include('token=test-token');
      const body = JSON.parse(options.body);
      expect(body.url).to.equal('https://example.com');
      expect(body.gotoOptions).to.deep.equal({ waitUntil: 'networkidle0' });
      expect(body.bestAttempt).to.be.true;
    });

    it('returns HTML content as text', async () => {
      fetchStub.resolves(
        new Response('<html><body>Hello</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
      );

      const client = createApiClient(mockConfig);
      const result = await client.exportPage({ url: 'https://example.com' });

      expect(result.ok).to.be.true;
      expect(result.isBinary).to.be.false;
      expect(result.data).to.include('Hello');
    });

    it('returns binary content as base64 for ZIP', async () => {
      const zipBuffer = Buffer.from('PK-fake-zip');
      fetchStub.resolves(
        new Response(zipBuffer, {
          status: 200,
          headers: { 'Content-Type': 'application/zip' },
        }),
      );

      const client = createApiClient(mockConfig);
      const result = await client.exportPage({
        url: 'https://example.com',
        includeResources: true,
      });

      expect(result.ok).to.be.true;
      expect(result.isBinary).to.be.true;
      expect(result.data).to.equal(zipBuffer.toString('base64'));
    });

    it('does not include optional fields when not provided', async () => {
      fetchStub.resolves(
        new Response('<html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.exportPage({ url: 'https://example.com' });

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body).to.have.property('url');
      expect(body).to.not.have.property('gotoOptions');
      expect(body).to.not.have.property('bestAttempt');
      expect(body).to.not.have.property('includeResources');
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
        await client.exportPage({ url: 'https://example.com' });
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

  describe('search', () => {
    const mockSearchResponse = {
      success: true,
      totalResults: 2,
      data: {
        web: [
          { title: 'Result 1', url: 'https://example.com/1', description: 'First' },
          { title: 'Result 2', url: 'https://example.com/2', description: 'Second' },
        ],
      },
    };

    it('sends correct request to the /search endpoint', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockSearchResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.search({ query: 'test query' });

      expect(fetchStub.calledOnce).to.be.true;
      const [url, options] = fetchStub.firstCall.args;
      expect(url).to.include('https://api.example.com/search');
      expect(url).to.include('token=test-token');
      expect(options.method).to.equal('POST');
      const body = JSON.parse(options.body);
      expect(body.query).to.equal('test query');
    });

    it('returns search response with results', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockSearchResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      const result = await client.search({ query: 'test' });

      expect(result.success).to.be.true;
      expect(result.totalResults).to.equal(2);
      expect(result.data.web).to.have.length(2);
    });

    it('includes optional parameters in request', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockSearchResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.search({
        query: 'test',
        limit: 5,
        lang: 'es',
        sources: ['web', 'news'],
        categories: ['github'],
      });

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body.limit).to.equal(5);
      expect(body.lang).to.equal('es');
      expect(body.sources).to.deep.equal(['web', 'news']);
      expect(body.categories).to.deep.equal(['github']);
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
        await client.search({ query: 'test' });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).to.include('Server error 500');
      }
    });
  });

  describe('map', () => {
    const mockMapResponse = {
      success: true,
      links: [
        { url: 'https://example.com/', title: 'Home' },
        { url: 'https://example.com/about', title: 'About' },
      ],
    };

    it('sends correct request to the /map endpoint', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockMapResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.map({ url: 'https://example.com' });

      expect(fetchStub.calledOnce).to.be.true;
      const [url, options] = fetchStub.firstCall.args;
      expect(url).to.include('https://api.example.com/map');
      expect(url).to.include('token=test-token');
      expect(options.method).to.equal('POST');
      const body = JSON.parse(options.body);
      expect(body.url).to.equal('https://example.com');
    });

    it('returns map response with links', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockMapResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      const result = await client.map({ url: 'https://example.com' });

      expect(result.success).to.be.true;
      expect(result.links).to.have.length(2);
      expect(result.links![0].url).to.equal('https://example.com/');
    });

    it('includes optional parameters in request', async () => {
      fetchStub.resolves(
        new Response(JSON.stringify(mockMapResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const client = createApiClient(mockConfig);
      await client.map({
        url: 'https://example.com',
        search: 'products',
        limit: 100,
        sitemap: 'only',
        includeSubdomains: false,
      });

      const body = JSON.parse(fetchStub.firstCall.args[1].body);
      expect(body.search).to.equal('products');
      expect(body.limit).to.equal(100);
      expect(body.sitemap).to.equal('only');
      expect(body.includeSubdomains).to.be.false;
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
        await client.map({ url: 'https://example.com' });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).to.include('Server error 500');
      }
    });
  });
});
