import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerMapTool } from '../../src/tools/map.js';
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

describe('browserless_map tool', () => {
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
    registerMapTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerMapTool(server, mockConfig)).to.not.throw();
  });

  it('returns discovered URLs', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({
        success: true,
        links: [
          { url: 'https://example.com/', title: 'Home' },
          { url: 'https://example.com/about', title: 'About Us' },
          { url: 'https://example.com/contact', title: 'Contact' },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com' },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');
    expect(content.length).to.be.at.least(2);

    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('Site Map Results');
    expect(mainContent.text).to.include('3 URLs');
    expect(mainContent.text).to.include('https://example.com/');
    expect(mainContent.text).to.include('https://example.com/about');
  });

  it('sends correct request to /map endpoint', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({
        success: true,
        links: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com',
        search: 'products',
        limit: 50,
        sitemap: 'only',
        includeSubdomains: false,
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/map');
    expect(url).to.include('token=test-token');
    const body = JSON.parse(options.body);
    expect(body.url).to.equal('https://example.com');
    expect(body.search).to.equal('products');
    expect(body.limit).to.equal(50);
    expect(body.sitemap).to.equal('only');
    expect(body.includeSubdomains).to.be.false;
  });

  it('includes URL list in output', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({
        success: true,
        links: [
          { url: 'https://example.com/page1' },
          { url: 'https://example.com/page2' },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com' },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const urlListBlock = content.find((c: Content) => 
      c.type === 'text' && (c as { text: string }).text.includes('## URL List')
    ) as { type: string; text: string } | undefined;
    
    expect(urlListBlock).to.exist;
    expect(urlListBlock!.text).to.include('https://example.com/page1');
    expect(urlListBlock!.text).to.include('https://example.com/page2');
  });

  it('throws UserError when map fails', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({
        success: false,
        error: 'Unable to access site',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        { url: 'https://example.com' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Map failed');
    }
  });

  it('throws UserError for non-http protocol', async () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        { url: 'ftp://example.com' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('ftp:');
    }
  });

  it('throws UserError when no token is provided', async () => {
    const noTokenConfig = { ...mockConfig, browserlessToken: undefined };
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const addToolSpy = sinon.spy(server, 'addTool');
    registerMapTool(server, noTokenConfig);
    const execute = addToolSpy.firstCall.args[0].execute;

    try {
      await execute(
        { url: 'https://example.com' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('No Browserless API token');
    }
  });

  it('handles empty results', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({
        success: true,
        links: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com' },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('No URLs found');
  });

  it('reports progress during execution', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({
        success: true,
        links: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { url: 'https://example.com' },
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
