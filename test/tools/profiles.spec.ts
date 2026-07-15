import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerProfilesTool } from '../../src/tools/profiles.js';
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

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('browserless_profiles tool', () => {
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
    registerProfilesTool(server, mockConfig);
    return addToolSpy.firstCall.args[0].execute;
  }

  it('registers the tool on the server', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    expect(() => registerProfilesTool(server, mockConfig)).to.not.throw();
  });

  it('GETs /profiles and lists each profile by name', async () => {
    fetchStub.resolves(
      jsonResponse([
        {
          id: 'bp_1',
          name: 'github',
          cookieCount: 12,
          originCount: 3,
          lastUsedAt: '2026-07-14T00:00:00.000Z',
          createdAt: '2026-07-10T00:00:00.000Z',
          updatedAt: '2026-07-10T00:00:00.000Z',
        },
        {
          id: 'bp_2',
          name: 'vanta',
          cookieCount: 0,
          originCount: 1,
          lastUsedAt: null,
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        },
      ]),
    );

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute({}, mockContext);

    const [url, options] = fetchStub.firstCall.args;
    expect(url).to.include('/profiles');
    expect(url).to.include('token=test-token');
    expect(options.method).to.equal('GET');

    const text = (result as { content: Content[] }).content[0] as {
      text: string;
    };
    expect(text.text).to.include('Saved Profiles (2)');
    expect(text.text).to.include('github');
    expect(text.text).to.include('vanta');
    expect(text.text).to.include('never used');
  });

  it('passes limit/offset as query params', async () => {
    fetchStub.resolves(jsonResponse([]));

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    await execute({ limit: 5, offset: 10 }, mockContext);

    const [url] = fetchStub.firstCall.args;
    expect(url).to.include('limit=5');
    expect(url).to.include('offset=10');
  });

  it('reports an empty list clearly', async () => {
    fetchStub.resolves(jsonResponse([]));

    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const execute = getToolExecute(server);

    const result = await execute({}, mockContext);

    const text = (result as { content: Content[] }).content[0] as {
      text: string;
    };
    expect(text.text).to.include('No saved profiles');
  });
});
