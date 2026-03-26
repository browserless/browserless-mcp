import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerBqlTool } from '../../src/tools/bql.js';
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

describe('browserless_bql tool', () => {
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
    registerBqlTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerBqlTool(server, mockConfig)).to.not.throw();
  });

  it('returns JSON data on successful BQL query', async () => {
    const bqlResponse = {
      data: {
        goto: { status: 200, time: 123 },
        title: { title: 'Example Domain' },
      },
    };

    fetchStub.resolves(
      new Response(JSON.stringify(bqlResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        query: 'mutation { goto(url: "https://example.com") { status time } title { title } }',
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    expect(content).to.be.an('array');
    expect(content.length).to.be.at.least(2);

    const dataContent = content.find(
      (c) => c.type === 'text' && (c as { text: string }).text.includes('Example Domain'),
    );
    expect(dataContent).to.exist;

    const metadata = content.find(
      (c) => c.type === 'text' && (c as { text: string }).text.includes('Endpoint:'),
    );
    expect(metadata).to.exist;
    expect((metadata as { text: string }).text).to.include('/chromium/bql');
    expect((metadata as { text: string }).text).to.include('Status: 200');
  });

  it('sends query and variables in the request body', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        query: 'mutation ($myUrl: String!) { goto(url: $myUrl) { status } }',
        variables: { myUrl: 'https://example.com' },
        operationName: 'TestOp',
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/chromium/bql');
    expect(url).to.include('token=test-token');
    const body = JSON.parse(options.body);
    expect(body.query).to.include('goto');
    expect(body.variables).to.deep.equal({ myUrl: 'https://example.com' });
    expect(body.operationName).to.equal('TestOp');
  });

  it('uses /stealth/bql when stealth is true', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: { goto: { status: 200 } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      {
        query: 'mutation { goto(url: "https://example.com") { status } }',
        stealth: true,
      },
      mockContext,
    );

    expect(fetchStub.calledOnce).to.be.true;
    const [url] = fetchStub.firstCall.args;
    expect(url).to.include('/stealth/bql');
  });

  it('throws UserError on non-2xx response', async () => {
    fetchStub.resolves(
      new Response(
        JSON.stringify({
          errors: [{ message: 'Syntax Error: Unexpected token' }],
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    try {
      await execute(
        { query: 'invalid query' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('BQL query failed');
      expect((err as Error).message).to.include('Syntax Error');
    }
  });

  it('throws UserError when no token is provided', async () => {
    const noTokenConfig = { ...mockConfig, browserlessToken: undefined };
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const addToolSpy = sinon.spy(server, 'addTool');
    registerBqlTool(server, noTokenConfig);
    const execute = addToolSpy.firstCall.args[0].execute;

    try {
      await execute(
        { query: 'mutation { title { title } }' },
        mockContext,
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).to.be.instanceOf(UserError);
      expect((err as Error).message).to.include('No Browserless API token');
    }
  });

  it('returns screenshot as image content block', async () => {
    const screenshotBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';
    const bqlResponse = {
      data: {
        goto: { status: 200 },
        screenshot: { base64: screenshotBase64 },
      },
    };

    fetchStub.resolves(
      new Response(JSON.stringify(bqlResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        query: 'mutation { goto(url: "https://example.com") { status } screenshot { base64 } }',
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const imageBlock = content.find((c) => c.type === 'image');
    expect(imageBlock).to.exist;
    expect((imageBlock as { data: string }).data).to.equal(screenshotBase64);
    expect((imageBlock as { mimeType: string }).mimeType).to.equal('image/png');
  });

  it('includes partial errors alongside data', async () => {
    const bqlResponse = {
      data: {
        goto: { status: 200 },
      },
      errors: [{ message: 'Field "nonexistent" not found' }],
    };

    fetchStub.resolves(
      new Response(JSON.stringify(bqlResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute(
      {
        query: 'mutation { goto(url: "https://example.com") { status } nonexistent { data } }',
      },
      mockContext,
    );

    const content = (result as { content: Content[] }).content;
    const errorBlock = content.find(
      (c) => c.type === 'text' && (c as { text: string }).text.includes('partial errors'),
    );
    expect(errorBlock).to.exist;
    expect((errorBlock as { text: string }).text).to.include('Field "nonexistent" not found');
  });

  it('reports progress during execution', async () => {
    fetchStub.resolves(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute(
      { query: 'mutation { title { title } }' },
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
