import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerPowerScraperTool } from '../../src/tools/smartscraper.js';
import type { McpConfig } from '../../src/config.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
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

const makeSuccessResponse = (overrides = {}) => ({
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
  markdown: '# Hello World',
  links: null,
  ...overrides,
});

const makeFailResponse = (overrides = {}) => ({
  ok: false,
  statusCode: 403,
  content: null,
  contentType: null,
  headers: {},
  strategy: 'browser-fetch',
  attempted: ['http-fetch', 'browser-fetch'],
  message: 'Access denied',
  screenshot: null,
  pdf: null,
  markdown: null,
  links: null,
  ...overrides,
});

const mockContext = {
  reportProgress: sinon.stub().resolves(),
  log: {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  },
  session: undefined,
  client: { version: undefined },
  streamContent: sinon.stub().resolves(),
};

describe('browserless_smartscraper tool', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
    mockContext.reportProgress.resetHistory();
  });

  afterEach(() => {
    sinon.restore();
  });

  function getToolExecute(server: FastMCP) {
    const addToolSpy = sinon.spy(server, 'addTool');
    registerPowerScraperTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerPowerScraperTool(server, mockConfig)).to.not.throw();
  });

  it('returns markdown content on successful scrape', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify(makeSuccessResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        url: 'https://example.com',
        formats: ['markdown'],
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');

    const textBlocks = content.filter((c: Content) => c.type === 'text');
    expect(textBlocks.length).to.be.at.least(2);

    const mainContent = textBlocks[0] as { type: string; text: string };
    expect(mainContent.text).to.equal('# Hello World');

    const metadata = textBlocks[1] as { type: string; text: string };
    expect(metadata.text).to.include('Strategy: http-fetch');
    expect(metadata.text).to.include('Status: 200');
  });

  it('throws UserError on failed scrape', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify(makeFailResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        {
          url: 'https://blocked-site.com',
          formats: ['markdown'],
        },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Access denied');
      expect((err as Error).message).to.include('http-fetch');
    }
  });

  it('throws UserError for non-http protocols', async () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        {
          url: 'ftp://example.com/file',
          formats: ['markdown'],
        },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('ftp:');
    }
  });

  it('includes screenshot as image content block', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify(
          makeSuccessResponse({
            screenshot: 'iVBORw0KGgoAAAANSUhEUg==',
          }),
        ),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        url: 'https://example.com',
        formats: ['markdown', 'screenshot'],
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const imageBlocks = content.filter((c: Content) => c.type === 'image');
    expect(imageBlocks).to.have.length(1);
    const img = imageBlocks[0] as {
      type: string;
      data: string;
      mimeType: string;
    };
    expect(img.data).to.equal('iVBORw0KGgoAAAANSUhEUg==');
    expect(img.mimeType).to.equal('image/png');
  });

  it('includes PDF as text content block', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify(makeSuccessResponse({ pdf: 'JVBERi0xLjQK' })),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        url: 'https://example.com',
        formats: ['markdown', 'pdf'],
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const pdfBlock = content.find(
      (c: Content) =>
        c.type === 'text' &&
        (c as { text: string }).text.includes('PDF Document'),
    );
    expect(pdfBlock).to.exist;
    expect((pdfBlock as { text: string }).text).to.include('JVBERi0xLjQK');
  });

  it('includes links as text content block', async () => {
    const mockLinks = [
      'https://example.com/about',
      'https://example.com/contact',
    ];
    fetchStub.resolves(
      new Response(JSON.stringify(makeSuccessResponse({ links: mockLinks })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        url: 'https://example.com',
        formats: ['markdown', 'links'],
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const linksBlock = content.find(
      (c: Content) =>
        c.type === 'text' && (c as { text: string }).text.includes('Links (2)'),
    );
    expect(linksBlock).to.exist;
    const text = (linksBlock as { text: string }).text;
    expect(text).to.include('https://example.com/about');
    expect(text).to.include('https://example.com/contact');
  });

  it('falls back to raw HTML when markdown is null', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify(makeSuccessResponse({ markdown: null })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        url: 'https://example.com',
        formats: ['html'],
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.equal('<html>Hello</html>');
  });

  it('JSON-stringifies object content', async () => {
    const jsonContent = { title: 'Test', items: [1, 2, 3] };
    fetchStub.resolves(
      new Response(
        JSON.stringify(
          makeSuccessResponse({
            markdown: null,
            content: jsonContent,
            contentType: 'application/json',
          }),
        ),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        url: 'https://example.com/api',
        formats: ['html'],
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    const parsed = JSON.parse(mainContent.text);
    expect(parsed).to.deep.equal(jsonContent);
  });

  it('returns diagnostic message when both content and markdown are null', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify(
          makeSuccessResponse({
            markdown: null,
            content: null,
          }),
        ),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        url: 'https://example.com',
        formats: ['markdown'],
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('No page content returned');
    expect(mainContent.text).to.include('http-fetch');
  });

  it('does not include profile in the outbound URL when omitted', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify(makeSuccessResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com',
        formats: ['markdown'],
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url] = fetchStub.firstCall.args;
    expect(url).to.not.include('profile=');
  });

  it('forwards profile as a query parameter to /smart-scrape', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify(makeSuccessResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com',
        formats: ['markdown'],
        profile: 'my-login',
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url] = fetchStub.firstCall.args;
    expect(url).to.include('profile=my-login');
  });

  it('URL-encodes the profile name', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify(makeSuccessResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com',
        formats: ['markdown'],
        profile: 'profile with spaces',
      },
      mockContext,
    );

    const [url] = fetchStub.firstCall.args;
    expect(url).to.include('profile=profile+with+spaces');
  });

  it('throws UserError (not a property-access crash) when the profile does not exist', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({ error: 'Profile "missing" was not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        {
          url: 'https://example.com',
          formats: ['markdown'],
          profile: 'missing',
        },
        mockContext,
      );
      expect.fail('expected UserError');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Profile "missing"');
      expect((err as Error).message).to.not.include('attempted');
      expect((err as Error).message).to.not.include('Cannot read properties');
    }
  });

  it('reports progress during execution', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify(makeSuccessResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com',
        formats: ['markdown'],
      },
      mockContext,
    );

    expect(mockContext.reportProgress.calledTwice).to.be.true;
    expect(mockContext.reportProgress.firstCall.args[0]).to.deep.equal({
      progress: 0,
      total: 100,
    });
    expect(mockContext.reportProgress.secondCall.args[0]).to.deep.equal({
      progress: 100,
      total: 100,
    });
  });
});

describe('UserError', () => {
  it('is importable from fastmcp', () => {
    expect(UserError).to.be.a('function');
    const err = new UserError('test error');
    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.equal('test error');
  });
});
