import { expect } from 'chai';
import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';
import sinon from 'sinon';
import { UserError } from 'fastmcp';

import type { McpConfig } from '../../src/@types/types.js';
import { DEFAULT_API_SERVER_URL } from '../../src/config.js';
import { LogsParamsSchema, registerLogsTool } from '../../src/tools/logs.js';

const mockConfig: McpConfig = {
  browserlessToken: 'secret-token',
  browserlessApiUrl: 'https://runtime.example.com',
  apiServerUrl: 'https://accounts.example.com',
  apiServerExplicitlyConfigured: true,
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
  elicit: sinon.stub().resolves({ action: 'cancel' }),
};

const response = (entries: unknown[], nextCursor: string | null = null) =>
  new Response(
    JSON.stringify({ data: { requestLogs: { entries, nextCursor } } }),
    { headers: { 'Content-Type': 'application/json' } },
  );

const captureTool = (analytics?: unknown, config: McpConfig = mockConfig) => {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const addTool = sinon.spy(server, 'addTool');
  registerLogsTool(server, config, analytics as never);
  return addTool.firstCall.args[0];
};

describe('browserless_logs tool', () => {
  beforeEach(() => mockContext.reportProgress.resetHistory());
  afterEach(() => sinon.restore());

  it('registers as a read-only idempotent tool', () => {
    const tool = captureTool();
    expect(tool.name).to.equal('browserless_logs');
    expect(tool.annotations).to.deep.include({
      title: 'Browserless Request Logs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('forwards every filter unchanged as GraphQL variables', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(response([]));
    const params = {
      startTime: '2026-08-15T00:00:00.000Z',
      endTime: '2026-08-15T01:00:00.000Z',
      limit: 5,
      requestId: 'request-1',
      url: 'https://example.com/path',
      eventNames: ['request.failed', 'bql.query.failed'],
      outcome: 'failed',
      apiKeyId: 'key-1',
      endpoint: '/chromium/bql',
      category: 'browserless_refused',
      reason: 'concurrency_limit',
      levels: ['ERROR', 'WARN'],
      order: 'DESC',
      cursor: 'cursor-1',
    };

    await captureTool().execute(params, mockContext);

    const [url, init] = fetchStub.firstCall.args as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(url).to.equal(`${mockConfig.apiServerUrl}/graphql`);
    expect(body.variables).to.deep.equal({
      ...params,
      apiToken: 'secret-token',
    });
  });

  it('rejects invalid limits and too many event names at the schema boundary', () => {
    expect(LogsParamsSchema.safeParse({ limit: 0 }).success).to.equal(false);
    expect(LogsParamsSchema.safeParse({ limit: 101 }).success).to.equal(false);
    expect(LogsParamsSchema.safeParse({ limit: 1.5 }).success).to.equal(false);
    expect(
      LogsParamsSchema.safeParse({
        eventNames: Array.from({ length: 21 }, (_, i) => `event.${i}`),
      }).success,
    ).to.equal(false);
  });

  it('documents both endpoint shapes and every failure category', () => {
    expect(LogsParamsSchema.shape.endpoint.description).to.include(
      'MCP Client',
    );
    expect(LogsParamsSchema.shape.endpoint.description).to.include('CLI Agent');
    expect(LogsParamsSchema.shape.endpoint.description).to.include(
      '/chromium/bql',
    );
    expect(LogsParamsSchema.shape.category.description).to.include(
      'client_closed',
    );
  });

  it('refuses to send a self-hosted token to the default hosted account API', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(response([]));
    const unsafeConfig = {
      ...mockConfig,
      apiServerUrl: DEFAULT_API_SERVER_URL,
      apiServerExplicitlyConfigured: false,
    } as McpConfig;

    try {
      await captureTool(undefined, unsafeConfig).execute({}, mockContext);
      expect.fail('Expected a UserError');
    } catch (error) {
      expect(error).to.be.instanceOf(UserError);
      expect((error as Error).message).to.include('BROWSERLESS_API_SERVER');
    }
    expect(fetchStub.called).to.equal(false);
  });

  it('allows the default hosted account API for a Browserless cloud runtime', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(response([]));
    const hostedConfig = {
      ...mockConfig,
      browserlessApiUrl: 'https://production-sfo.browserless.io',
      apiServerUrl: DEFAULT_API_SERVER_URL,
      apiServerExplicitlyConfigured: false,
    } as McpConfig;

    await captureTool(undefined, hostedConfig).execute({}, mockContext);

    expect(fetchStub.calledOnce).to.equal(true);
  });

  it('applies the fail-closed guard to a per-session runtime override', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(response([]));
    const hostedConfig = {
      ...mockConfig,
      browserlessApiUrl: 'https://production-sfo.browserless.io',
      apiServerUrl: DEFAULT_API_SERVER_URL,
      apiServerExplicitlyConfigured: false,
    } as McpConfig;
    const overrideContext = {
      ...mockContext,
      session: {
        token: 'secret-token',
        apiUrl: 'https://self-hosted.example.com',
      },
    };

    try {
      await captureTool(undefined, hostedConfig).execute({}, overrideContext);
      expect.fail('Expected a UserError');
    } catch (error) {
      expect(error).to.be.instanceOf(UserError);
    }
    expect(fetchStub.called).to.equal(false);
  });

  it('renders entries and explains how to use nextCursor', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      response(
        [
          {
            timestamp: '2026-08-15T00:00:01.000Z',
            level: 'error',
            endpoint: '/chromium/bql',
            category: 'target_error',
            reason: 'navigation_failed',
            message: 'Navigation failed',
            requestId: 'request-1',
          },
        ],
        'cursor-2',
      ),
    );

    const result = await captureTool().execute({ limit: 5 }, mockContext);
    const content = (result as { content: Content[] }).content;
    const text = (content[0] as { text: string }).text;
    expect(text).to.contain('error · /chromium/bql');
    expect(text).to.contain('target_error/navigation_failed');
    expect(text).to.contain('request `request-1`');
    expect(text).to.contain('cursor: "cursor-2"');
  });

  it('renders a plain message when no entries match', async () => {
    sinon.stub(globalThis, 'fetch').resolves(response([]));

    const result = await captureTool().execute({}, mockContext);
    const text = (
      (result as { content: Content[] }).content[0] as {
        text: string;
      }
    ).text;
    expect(text).to.match(/no request log entries matched/i);
  });

  it('preserves pagination guidance when an empty page has a cursor', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(response([], 'cursor-after-empty'));

    const result = await captureTool().execute({}, mockContext);
    const text = (
      (result as { content: Content[] }).content[0] as {
        text: string;
      }
    ).text;
    expect(text).to.match(/no request log entries matched/i);
    expect(text).to.contain('cursor: "cursor-after-empty"');
  });

  it('emits normal tool analytics without putting the token in event properties', async () => {
    sinon.stub(globalThis, 'fetch').resolves(response([]));
    const fireToolRequest = sinon.stub();

    await captureTool({ fireToolRequest, fireSkill: sinon.stub() }).execute(
      {},
      mockContext,
    );

    expect(fireToolRequest.calledOnce).to.equal(true);
    const properties = fireToolRequest.firstCall.args[2];
    expect(properties).not.to.have.property('token');
    expect(JSON.stringify(properties)).not.to.contain('secret-token');
  });
});
