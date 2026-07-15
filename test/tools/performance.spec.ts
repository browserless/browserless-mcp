import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerPerformanceTool } from '../../src/tools/performance.js';
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
  complianceMode: false,
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

describe('browserless_performance tool', () => {
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
    registerPerformanceTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerPerformanceTool(server, mockConfig)).to.not.throw();
  });

  it('returns Lighthouse scores on successful audit', async () => {
    const lighthouseData = {
      data: {
        lighthouseVersion: '13.0.3',
        requestedUrl: 'https://example.com/',
        categories: {
          performance: { title: 'Performance', score: 0.95 },
          accessibility: { title: 'Accessibility', score: 0.88 },
          seo: { title: 'SEO', score: 1.0 },
        },
        audits: {
          'first-contentful-paint': {
            title: 'First Contentful Paint',
            score: 1,
            displayValue: '0.8 s',
          },
        },
      },
      type: 'json',
    };

    fetchStub.resolves(
      new Response(JSON.stringify(lighthouseData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute({ url: 'https://example.com/' }, mockContext);

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');
    expect(content.length).to.be.at.least(2);

    // First block: category scores summary
    const summary = content[0] as { type: string; text: string };
    expect(summary.type).to.equal('text');
    expect(summary.text).to.include('Lighthouse Scores');
    expect(summary.text).to.include('Performance: 95/100');
    expect(summary.text).to.include('Accessibility: 88/100');
    expect(summary.text).to.include('SEO: 100/100');

    // Second block: full JSON data
    const jsonBlock = content[1] as { type: string; text: string };
    expect(jsonBlock.text).to.include('first-contentful-paint');
    expect(jsonBlock.text).to.include('lighthouseVersion');

    // Third block: metadata
    const metadata = content[2] as { type: string; text: string };
    expect(metadata.text).to.include('URL: https://example.com/');
    expect(metadata.text).to.include('Lighthouse Version: 13.0.3');
  });

  it('sends url and config with categories in the request body', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { url: 'https://example.com/', categories: ['performance', 'seo'] },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/performance');
    expect(url).to.include('token=test-token');
    const body = JSON.parse(options.body);
    expect(body.url).to.equal('https://example.com/');
    expect(body.config).to.deep.equal({
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance', 'seo'],
      },
    });
  });

  it('sends budgets in the request body', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const budgets = [
      { resourceSizes: [{ resourceType: 'script', budget: 300 }] },
    ];
    await execute({ url: 'https://example.com/', budgets }, mockContext);

    expect(fetchStub.calledOnce).to.be.true;
    const body = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(body.budgets).to.deep.equal(budgets);
  });

  it('throws UserError when no token is provided', async () => {
    const noTokenConfig = { ...mockConfig, browserlessToken: undefined };
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const addToolSpy = sinon.spy(server, 'addTool');
    registerPerformanceTool(server, noTokenConfig);
    const execute = addToolSpy.firstCall.args[0].execute;

    try {
      await execute({ url: 'https://example.com/' }, mockContext);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('No Browserless API token');
    }
  });

  it('throws UserError for invalid URL protocol', async () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute({ url: 'ftp://example.com/' }, mockContext);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Invalid URL protocol');
    }
  });

  it('reports progress during execution', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute({ url: 'https://example.com/' }, mockContext);

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

  it('includes categories in metadata when specified', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com/', categories: ['accessibility'] },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const metadata = content[content.length - 1] as {
      type: string;
      text: string;
    };
    expect(metadata.text).to.include('Categories: accessibility');
  });

  it('does not include profile in the outbound URL when omitted', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute({ url: 'https://example.com/' }, mockContext);

    expect(fetchStub.calledOnce).to.be.true;
    const [url] = fetchStub.firstCall.args;
    expect(url).to.not.include('profile=');
  });

  it('forwards profile as a query parameter to /performance', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { url: 'https://example.com/', profile: 'my-login' },
      mockContext,
    );

    const [url] = fetchStub.firstCall.args;
    expect(url).to.include('profile=my-login');
  });

  it('URL-encodes the profile name', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { url: 'https://example.com/', profile: 'profile with spaces' },
      mockContext,
    );

    const [url] = fetchStub.firstCall.args;
    expect(url).to.include('profile=profile+with+spaces');
  });

  it('throws UserError when the profile does not exist', async () => {
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
        { url: 'https://example.com/', profile: 'missing' },
        mockContext,
      );
      expect.fail('expected UserError');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('Profile "missing"');
      expect((err as Error).message).to.include('Browserless.saveProfile');
    }
  });
});
