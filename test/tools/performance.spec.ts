import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { readFile } from 'node:fs/promises';
import {
  clearSession,
  downloadOwner,
  getDownload,
} from '../../src/lib/download-store.js';
import { registerDownloadRoute } from '../../src/resources/download-route.js';
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
  oauthRegisterRateLimitPerHour: 300,
  supabaseUrl: '',
  supabaseOAuthClientId: '',
  supabaseOAuthClientSecret: '',
  supabaseServiceRoleKey: '',
  mcpBaseUrl: '',
  oauthAllowedRedirectUriPatterns: [],
};

const mockContext = {
  reportProgress: sinon.stub().resolves(),
  signal: new AbortController().signal,
  log: {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  },
  session: undefined,
  sessionId: 'performance-test',
  client: { version: undefined },
  streamContent: sinon.stub().resolves(),
  elicit: sinon.stub().resolves({ action: 'cancel' }),
};

describe('browserless_performance tool', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
    mockContext.reportProgress.resetHistory();
  });

  afterEach(() => {
    clearSession(mockContext.sessionId);
    sinon.restore();
  });

  function getToolExecute(server: FastMCP, config = mockConfig) {
    const addToolSpy = sinon.spy(server, 'addTool');
    registerPerformanceTool(server, config);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerPerformanceTool(server, mockConfig)).to.not.throw();
  });

  it('returns Lighthouse scores and lab metrics on successful audit', async () => {
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
          'largest-contentful-paint': { displayValue: '1.2 s' },
          'total-blocking-time': { numericValue: 0 },
          'cumulative-layout-shift': { numericValue: 0 },
          'speed-index': { displayValue: '0.9 s' },
          'server-response-time': { displayValue: 'Root document took 120 ms' },
          'total-byte-weight': { displayValue: 'Total size was 150 KiB' },
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

    const metrics = content[1] as { text: string };
    expect(metrics.text).to.include('Lighthouse Lab Metrics');
    for (const line of [
      'FCP: 0.8 s',
      'LCP: 1.2 s',
      'TBT: 0 ms',
      'CLS: 0',
      'Speed Index: 0.9 s',
      'Initial server response time: Root document took 120 ms',
      'Total transfer size: Total size was 150 KiB',
    ]) {
      expect(metrics.text).to.include(line);
    }
    expect(metrics.text).to.include('INP is not measured');

    // Full JSON is available on disk without being included in MCP content.
    const downloadBlock = content[2] as { type: string; text: string };
    const path = downloadBlock.text.split('\n')[1].split(' (')[0];
    const record = getDownload(path, downloadOwner('test-token'))!;
    expect(record.mimeType).to.equal('application/json');
    expect(JSON.parse(await readFile(path, 'utf8'))).to.deep.equal(
      lighthouseData.data,
    );
    expect(downloadBlock.text).to.include('jq');
    expect(downloadBlock.text).to.include(
      'Do not read or paste the entire JSON',
    );
    expect(downloadBlock.text).to.not.include('"audits":');

    // Final block: metadata
    const metadata = content[3] as { type: string; text: string };
    expect(metadata.text).to.include('URL: https://example.com/');
    expect(metadata.text).to.include('Lighthouse Version: 13.0.3');
  });

  it('keeps large audit details out of context while preserving the complete UTF-8 report', async () => {
    const data = {
      categories: { performance: { title: 'Performance', score: null } },
      audits: { details: 'large-audit-payload-✓'.repeat(20_000) },
    };
    fetchStub.resolves(new Response(JSON.stringify({ data, type: 'json' })));
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const result = await getToolExecute(server)(
      { url: 'https://example.com/' },
      mockContext,
    );
    const content = (result as { content: Content[] }).content as {
      text: string;
    }[];
    expect(JSON.stringify(result).length).to.be.lessThan(3000);
    expect(JSON.stringify(result)).to.not.include('large-audit-payload');
    expect(content[0].text).to.include('Performance: N/A');
    const path = content[2].text.split('\n')[1].split(' (')[0];
    expect(JSON.parse(await readFile(path, 'utf8'))).to.deep.equal(data);
    expect(getDownload(path, downloadOwner('other-token'))).to.be.undefined;
  });

  it('marks missing, failed, and non-finite metrics unavailable', async () => {
    const data = {
      categories: { performance: { score: null } },
      audits: {
        'first-contentful-paint': {
          scoreDisplayMode: 'error',
          displayValue: 'Misleading timing',
        },
        'largest-contentful-paint': {
          scoreDisplayMode: 'notApplicable',
          numericValue: 0,
        },
        'total-blocking-time': { numericValue: null },
        'cumulative-layout-shift': { displayValue: '' },
        'speed-index': { numericValue: 1200 },
        'total-byte-weight': { numericValue: 1024 },
      },
    };
    fetchStub.resolves(new Response(JSON.stringify({ data, type: 'json' })));
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const result = await getToolExecute(server)(
      { url: 'https://example.com/' },
      mockContext,
    );
    const text = JSON.stringify(result);
    for (const label of [
      'FCP',
      'LCP',
      'TBT',
      'CLS',
      'Initial server response time',
    ]) {
      expect(text).to.include(`${label}: Unavailable`);
    }
    expect(text).to.include('Speed Index: 1200 ms');
    expect(text).to.include('Total transfer size: 1024 bytes');
    expect(text).to.not.include('Misleading timing');
  });

  it('does not add lab metrics when performance audits are excluded', async () => {
    const data = {
      categories: { seo: { title: 'SEO', score: 1 } },
      audits: {},
    };
    fetchStub.resolves(new Response(JSON.stringify({ data, type: 'json' })));
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const result = await getToolExecute(server)(
      { url: 'https://example.com/', categories: ['seo'] },
      mockContext,
    );
    expect(JSON.stringify(result)).to.include('SEO: 100/100');
    expect(JSON.stringify(result)).to.not.include('Lighthouse Lab Metrics');
  });

  it('includes metrics from custom audits without category scores', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          data: {
            audits: { 'first-contentful-paint': { displayValue: '1 s' } },
          },
          type: 'json',
        }),
      ),
    );
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const result = await getToolExecute(server)(
      { url: 'https://example.com/' },
      mockContext,
    );
    expect(JSON.stringify(result)).to.include('FCP: 1 s');
  });

  it('serves HTTP reports once and only to the invocation token', async () => {
    const config = {
      ...mockConfig,
      transport: 'httpStream' as const,
      mcpBaseUrl: 'https://mcp.example.com',
    };
    const data = { audits: { privateDetails: 'full report' } };
    fetchStub.resolves(new Response(JSON.stringify({ data, type: 'json' })));
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    registerDownloadRoute(server, config);
    const execute = getToolExecute(server, config);
    const token = 'session token&value';
    const result = await execute(
      { url: 'https://example.com/' },
      { ...mockContext, session: { token } },
    );
    const text = JSON.stringify(result);
    const id = text.match(/\/download\/([0-9a-f]{32})/)![1];
    expect(text).to.include(`?token=${encodeURIComponent(token)}`);
    expect(text).to.not.include('privateDetails');
    expect(text).to.include('download to disk first');
    expect(
      (await server.getApp().request(`/download/${id}?token=test-token`))
        .status,
    ).to.equal(404);
    const response = await server
      .getApp()
      .request(`/download/${id}?token=${encodeURIComponent(token)}`);
    expect(response.status).to.equal(200);
    expect(response.headers.get('content-type')).to.include('application/json');
    expect(await response.json()).to.deep.equal(data);
    expect(
      (
        await server
          .getApp()
          .request(`/download/${id}?token=${encodeURIComponent(token)}`)
      ).status,
    ).to.equal(404);
  });

  it('removes report handles when the MCP session ends', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' })),
    );
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const result = await getToolExecute(server)(
      { url: 'https://example.com/' },
      mockContext,
    );
    const content = (result as { content: Content[] }).content as {
      text: string;
    }[];
    const path = content[0].text.split('\n')[1].split(' (')[0];
    expect(getDownload(path, downloadOwner('test-token'))).to.exist;
    clearSession(mockContext.sessionId);
    expect(getDownload(path, downloadOwner('test-token'))).to.be.undefined;
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

  it('sends the Lighthouse desktop preset when device is desktop', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { url: 'https://example.com/', device: 'desktop' },
      mockContext,
    );

    const body = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(body.config.extends).to.equal('lighthouse:default');
    expect(body.config.settings.formFactor).to.equal('desktop');
    expect(body.config.settings.screenEmulation).to.deep.equal({
      mobile: false,
      width: 1350,
      height: 940,
      deviceScaleFactor: 1,
      disabled: false,
    });
    expect(body.config.settings.throttling.cpuSlowdownMultiplier).to.equal(1);
    expect(body.config.settings.emulatedUserAgent).to.not.include('Mobile');
  });

  it('sends the Lighthouse mobile preset when device is mobile', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { url: 'https://example.com/', device: 'mobile' },
      mockContext,
    );

    const body = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(body.config.settings.formFactor).to.equal('mobile');
    expect(body.config.settings.screenEmulation.mobile).to.be.true;
    expect(body.config.settings.throttling.cpuSlowdownMultiplier).to.equal(4);
    expect(body.config.settings.emulatedUserAgent).to.include('Mobile');
  });

  it('forwards a custom config, letting device and categories override its settings', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com/',
        device: 'desktop',
        categories: ['performance'],
        config: {
          settings: {
            formFactor: 'mobile',
            onlyCategories: ['seo'],
            onlyAudits: ['first-contentful-paint'],
          },
        },
      },
      mockContext,
    );

    const body = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(body.config.extends).to.equal('lighthouse:default');
    expect(body.config.settings.onlyAudits).to.deep.equal([
      'first-contentful-paint',
    ]);
    expect(body.config.settings.formFactor).to.equal('desktop');
    expect(body.config.settings.onlyCategories).to.deep.equal(['performance']);
  });

  it('sends a custom config as-is when no device or categories are set', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const config = {
      extends: 'lighthouse:default',
      settings: { onlyAudits: ['unminified-css'] },
    };
    await execute({ url: 'https://example.com/', config }, mockContext);

    const body = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(body.config).to.deep.equal(config);
  });

  it('omits config when no device, categories or config are set', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute({ url: 'https://example.com/' }, mockContext);

    const body = JSON.parse(fetchStub.firstCall.args[1].body);
    expect(body).to.not.have.property('config');
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

  it('includes device in metadata when specified', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {}, type: 'json' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com/', device: 'desktop' },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const metadata = content[content.length - 1] as {
      type: string;
      text: string;
    };
    expect(metadata.text).to.include('Device: desktop');
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
