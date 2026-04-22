import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerDownloadTool } from '../../src/tools/download.js';
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

describe('browserless_download tool', () => {
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
    registerDownloadTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerDownloadTool(server, mockConfig)).to.not.throw();
  });

  it('returns text content for text/csv download', async () => {
    const csvData = 'Title,Price\nBook A,10.00\nBook B,15.00';
    fetchStub.resolves(
      new Response(csvData, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="books.csv"',
        },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        code: 'export default async ({ page }) => { await page.goto("https://example.com"); }',
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');
    expect(content.length).to.be.at.least(2);

    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('Title,Price');

    const metadata = content[1] as { type: string; text: string };
    expect(metadata.text).to.include('Filename: books.csv');
    expect(metadata.text).to.include('Content-Type: text/csv');
  });

  it('sends code and context to /download endpoint', async () => {
    fetchStub.resolves(
      new Response('file data', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        code: 'export default async ({ page, context }) => { await page.goto(context.url); }',
        context: { url: 'https://filesamples.com' },
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/download');
    expect(url).to.include('token=test-token');
    const body = JSON.parse(options.body);
    expect(body.code).to.include('context');
    expect(body.context).to.deep.equal({ url: 'https://filesamples.com' });
  });

  it('handles binary file downloads with base64 encoding', async () => {
    const imageBuffer = Buffer.from('fake-png-data');
    fetchStub.resolves(
      new Response(imageBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Disposition': 'attachment; filename="screenshot.png"',
        },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { code: 'export default async ({ page }) => {}' },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('Downloaded file');
    expect(mainContent.text).to.include('screenshot.png');
    expect(mainContent.text).to.include(imageBuffer.toString('base64'));
  });

  it('throws UserError on failed download', async () => {
    fetchStub.resolves(
      new Response('No file downloaded', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        { code: 'export default async ({ page }) => {}' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('400');
    }
  });

  it('throws UserError when no token is provided', async () => {
    const noTokenConfig = { ...mockConfig, browserlessToken: undefined };
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const addToolSpy = sinon.spy(server, 'addTool');
    registerDownloadTool(server, noTokenConfig);
    const execute = addToolSpy.firstCall.args[0].execute;

    try {
      await execute(
        { code: 'export default async () => {}' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('No Browserless API token');
    }
  });

  it('uses default filename when Content-Disposition is absent', async () => {
    fetchStub.resolves(
      new Response('some data', {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { code: 'export default async () => {}' },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const metadata = content[1] as { type: string; text: string };
    expect(metadata.text).to.include('Filename: downloaded-file');
  });

  it('reports progress during execution', async () => {
    fetchStub.resolves(
      new Response('data', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { code: 'export default async () => {}' },
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
