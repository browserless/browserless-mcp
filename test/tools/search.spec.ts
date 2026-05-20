import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerSearchTool } from '../../src/tools/search.js';
import type { McpConfig } from '../../src/@types/types.js';

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

describe('browserless_search tool', () => {
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
    registerSearchTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerSearchTool(server, mockConfig)).to.not.throw();
  });

  it('returns web search results', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          totalResults: 2,
          data: {
            web: [
              {
                title: 'Result 1',
                url: 'https://example.com/1',
                description: 'First result',
              },
              {
                title: 'Result 2',
                url: 'https://example.com/2',
                description: 'Second result',
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute({ query: 'test query' }, mockContext);

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');
    expect(content.length).to.be.at.least(2);

    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('Web Results');
    expect(mainContent.text).to.include('Result 1');
    expect(mainContent.text).to.include('Result 2');
  });

  it('sends correct request to /search endpoint', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          totalResults: 0,
          data: {},
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        query: 'test query',
        limit: 5,
        lang: 'en',
        sources: ['web', 'news'],
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/search');
    expect(url).to.include('token=test-token');
    const body = JSON.parse(options.body);
    expect(body.query).to.equal('test query');
    expect(body.limit).to.equal(5);
    expect(body.lang).to.equal('en');
    expect(body.sources).to.deep.equal(['web', 'news']);
  });

  it('handles news results', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          totalResults: 1,
          data: {
            news: [
              {
                title: 'News Article',
                url: 'https://news.com/article',
                description: 'Breaking news',
                date: '2024-01-01',
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { query: 'news', sources: ['news'] },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('News Results');
    expect(mainContent.text).to.include('News Article');
  });

  it('handles image results', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          totalResults: 1,
          data: {
            images: [
              {
                title: 'Image',
                imageUrl: 'https://example.com/image.png',
                url: 'https://example.com',
                imageWidth: 800,
                imageHeight: 600,
              },
            ],
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { query: 'images', sources: ['images'] },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('Image Results');
    expect(mainContent.text).to.include('800x600');
  });

  it('throws UserError when search fails', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: false,
          totalResults: 0,
          data: {},
          error: 'Search service unavailable',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute({ query: 'test' }, mockContext);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Search failed');
    }
  });

  it('throws UserError when no token is provided', async () => {
    const noTokenConfig = { ...mockConfig, browserlessToken: undefined };
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const addToolSpy = sinon.spy(server, 'addTool');
    registerSearchTool(server, noTokenConfig);
    const execute = addToolSpy.firstCall.args[0].execute;

    try {
      await execute({ query: 'test' }, mockContext);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('No Browserless API token');
    }
  });

  it('reports progress during execution', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          success: true,
          totalResults: 0,
          data: {},
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute({ query: 'test' }, mockContext);

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
