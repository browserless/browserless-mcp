import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerExportTool } from '../../src/tools/export.js';
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

describe('browserless_export tool', () => {
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
    registerExportTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerExportTool(server, mockConfig)).to.not.throw();
  });

  it('returns HTML content from an export', async () => {
    const htmlContent = '<html><body>Hello World</body></html>';
    fetchStub.resolves(
      new Response(htmlContent, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
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
    expect(mainContent.text).to.include('Hello World');

    const metadata = content[1] as { type: string; text: string };
    expect(metadata.text).to.include('URL: https://example.com');
    expect(metadata.text).to.include('Content-Type: text/html');
    expect(metadata.text).to.include('Status: 200');
  });

  it('sends correct request to /export endpoint', async () => {
    fetchStub.resolves(
      new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        url: 'https://example.com',
        gotoOptions: { waitUntil: 'networkidle0' },
        bestAttempt: true,
        includeResources: false,
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/export');
    expect(url).to.include('token=test-token');
    const body = JSON.parse(options.body);
    expect(body.url).to.equal('https://example.com');
    expect(body.gotoOptions).to.deep.equal({ waitUntil: 'networkidle0' });
    expect(body.bestAttempt).to.be.true;
    expect(body.includeResources).to.be.false;
  });

  it('handles PDF export with binary data', async () => {
    const pdfBuffer = Buffer.from('fake-pdf-binary');
    fetchStub.resolves(
      new Response(pdfBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="output.pdf"',
        },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com/document.pdf' },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('Exported');
    expect(mainContent.text).to.include('output.pdf');
    expect(mainContent.text).to.include(pdfBuffer.toString('base64'));
  });

  it('handles zip export when includeResources is set', async () => {
    const zipBuffer = Buffer.from('fake-zip-data');
    fetchStub.resolves(
      new Response(zipBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="example.com.zip"',
        },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        url: 'https://example.com',
        includeResources: true,
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const mainContent = content[0] as { type: string; text: string };
    expect(mainContent.text).to.include('application/zip');

    const metadata = content[1] as { type: string; text: string };
    expect(metadata.text).to.include('Resources: included (ZIP)');
  });

  it('throws UserError on failed export', async () => {
    fetchStub.resolves(
      new Response('Bad Request', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        { url: 'https://bad-url.example.com' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('400');
    }
  });

  it('throws UserError for non-http protocol', async () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        { url: 'ftp://example.com/file' },
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
    registerExportTool(server, noTokenConfig);
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

  it('reports progress during execution', async () => {
    fetchStub.resolves(
      new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
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

  it('uses hostname as default filename when no Content-Disposition', async () => {
    fetchStub.resolves(
      new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      { url: 'https://example.com/some/page' },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const metadata = content[1] as { type: string; text: string };
    expect(metadata.text).to.include('Filename: example.com');
  });
});
