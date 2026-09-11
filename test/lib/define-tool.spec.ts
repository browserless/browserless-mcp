import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { defineTool } from '../../src/lib/define-tool.js';
import { AnalyticsHelper } from '../../src/lib/analytics.js';
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
  sessionId: undefined,
  client: { version: undefined },
};

type Def = Parameters<typeof defineTool<{ url?: string }, unknown>>[3];

const register = (def: Partial<Def>) => {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const addToolSpy = sinon.spy(server, 'addTool');
  const analytics = new AnalyticsHelper(false);
  const fire = sinon.stub(analytics, 'fireToolRequest');
  const skill = sinon.stub(analytics, 'fireSkill');

  defineTool<{ url?: string }, unknown>(server, mockConfig, analytics, {
    name: 'test_tool',
    description: 'test',
    parameters: z.object({ url: z.string().optional() }),
    run: async () => ({}),
    format: () => [{ type: 'text' as const, text: 'ok' }],
    ...def,
  } as Def);

  return {
    execute: addToolSpy.firstCall.args[0].execute,
    fire,
    skill,
    props: () => fire.firstCall.args[2] as Record<string, unknown>,
  };
};

const rejects = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  expect.fail('should have thrown');
};

describe('defineTool analytics', () => {
  beforeEach(() => mockContext.reportProgress.resetHistory());
  afterEach(() => sinon.restore());

  it('preserves structured thrown status without guessing its origin or leaking text', async () => {
    const { execute, props } = register({
      run: async () => {
        throw Object.assign(
          new Error('<html>password=secret ' + 'x'.repeat(600)),
          {
            status: 403,
            code: 'FORBIDDEN',
          },
        );
      },
    });
    await rejects(execute({}, mockContext as never));
    expect(props()).to.include({
      error_reason: 'forbidden',
      error_source: 'unknown',
      error_code: 'FORBIDDEN',
      error_status_code: 403,
      error_status_origin: 'unknown',
    });
    expect(props()).not.to.have.property('status_code');
    expect(props().error_message).to.be.a('string').with.length.at.most(500);
    expect(JSON.stringify(props())).not.to.match(/secret|<html>|xxx/);
  });

  it('omits stale diagnostic properties on success', async () => {
    const { execute, props } = register({
      analyticsProps: () => ({
        success: true,
        error_reason: 'timeout',
        error_source: 'transport',
        error_code: 'ETIMEDOUT',
        error_message: 'private',
        failed_method: 'goto',
        failed_command_index: 1,
        error_status_code: 503,
        error_status_origin: 'api',
      }),
    });
    await execute({}, mockContext as never);
    expect(
      Object.keys(props()).filter(
        (k) => k.startsWith('error_') || k.startsWith('failed_'),
      ),
    ).to.deep.equal([]);
  });

  it('retains API status on a thrown HTTP response without emitting its body', async () => {
    sinon.stub(globalThis, 'fetch').resolves(
      new Response('{"code":"UNAUTHORIZED","message":"Bearer private"}', {
        status: 401,
      }),
    );
    const { execute, props } = register({
      run: async ({ client }) => client.search({ query: 'test' }),
    });
    await rejects(execute({}, mockContext as never));
    expect(props()).to.include({
      error_reason: 'unauthorized',
      error_source: 'api',
      error_status_code: 401,
      error_status_origin: 'api',
      error_code: 'UNAUTHORIZED',
    });
    expect(JSON.stringify(props())).not.to.include('private');
  });

  it('does not change coarse classification when retaining a new upstream code', async () => {
    sinon
      .stub(globalThis, 'fetch')
      .resolves(new Response('{"code":"BROWSER_CRASHED"}', { status: 403 }));
    const { execute, props } = register({
      run: async ({ client }) => client.search({ query: 'test' }),
    });
    await rejects(execute({}, mockContext as never));
    expect(props()).to.include({
      error_code: 'BROWSER_CRASHED',
      error_category: 'user_error',
    });
  });

  it('emits session attribution without leaking authentication credentials', async () => {
    const { execute, fire, skill, props } = register({
      run: async ({ analytics, token, mcpSource }) => {
        analytics?.fireSkill(token, { skill_id: 'forms', ...mcpSource });
        return {};
      },
    });
    const token = 'private-session-token-value';
    await execute({}, {
      ...mockContext,
      session: {
        token,
        apiUrl: mockConfig.browserlessApiUrl,
        authMethod: 'api_key_header',
        transport: 'sse',
        userAgent: 'python-httpx/0.28',
      },
      client: { version: { name: 'mcp', version: '0.1.0' } },
    } as never);
    const attribution = {
      source: 'mcp_client',
      client_name: 'mcp',
      client_version: '0.1.0',
      auth_method: 'api_key_header',
      transport: 'sse',
      user_agent: 'python-httpx/0.28',
      user_agent_family: 'python-httpx',
      client_family: 'sdk_default',
      usage_mode: 'deployed',
    };
    expect(fire.calledOnce).to.be.true;
    expect(props()).to.include({
      ...attribution,
      success: true,
      analytics_version: 2,
    });
    expect(props().duration_ms).to.be.a('number');
    expect(skill.firstCall.args[1]).to.include(attribution);
    expect(Object.values(props())).not.to.include(token);
    expect(
      Object.values(props()).some(
        (value) => typeof value === 'string' && value.startsWith('eyJ'),
      ),
    ).to.be.false;
    expect(props()).not.to.have.property('authorization');
  });

  it('rejects a disallowed session apiUrl before running the tool', async () => {
    const run = sinon.stub().resolves({});
    const fetchStub = sinon.stub(globalThis, 'fetch');
    const { execute, fire, props } = register({ run });

    const err = await rejects(
      execute({}, {
        ...mockContext,
        session: { token: 'token', apiUrl: 'http://127.0.0.1:9999' },
      } as never),
    );

    expect(err).to.be.instanceOf(UserError);
    expect(run.called).to.be.false;
    expect(fetchStub.called).to.be.false;
    expect(mockContext.reportProgress.called).to.be.false;
    expect(fire.calledOnce).to.be.true;
    expect(props()).to.include({
      success: false,
      error_category: 'user_error',
      analytics_version: 2,
      api_url: mockConfig.browserlessApiUrl,
    });
  });

  it('passes an allowed session apiUrl to the tool', async () => {
    const run = sinon.stub().resolves({});
    const { execute } = register({ run });

    await execute({}, {
      ...mockContext,
      session: {
        token: 'token',
        apiUrl: 'https://production-lon.browserless.io',
      },
    } as never);

    expect(run.firstCall.args[0].apiUrl).to.equal(
      'https://production-lon.browserless.io',
    );
  });

  it('fires exactly one enriched event on success', async () => {
    const { execute, fire, props } = register({
      analyticsProps: () => ({ pages: 3 }),
    });

    await execute({}, mockContext as never);

    expect(fire.calledOnce).to.be.true;
    expect(props()).to.include({
      success: true,
      analytics_version: 2,
      pages: 3,
    });
    expect(props().duration_ms).to.be.a('number');
    expect(props()).to.not.have.property('error_category');
  });

  it('fires for tools without analyticsProps', async () => {
    const { execute, fire, props } = register({});

    await execute({}, mockContext as never);

    expect(fire.calledOnce).to.be.true;
    expect(props().success).to.be.true;
  });

  it('fires once and rethrows when run throws', async () => {
    const { execute, fire, props } = register({
      run: async () => {
        throw new Error('Server error 502: upstream is down');
      },
    });

    const err = await rejects(execute({}, mockContext as never));
    expect(err.message).to.include('Server error 502');
    expect(fire.calledOnce).to.be.true;
    expect(props()).to.include({
      success: false,
      error_category: 'api_error',
      analytics_version: 2,
    });
  });

  it('classifies a UserError thrown by validateUrl as user_error', async () => {
    const { execute, fire, props } = register({
      validateUrl: () => {
        throw new UserError('Invalid URL protocol "ftp:".');
      },
    });

    await rejects(execute({ url: 'ftp://x' }, mockContext as never));
    expect(fire.calledOnce).to.be.true;
    expect(props().error_category).to.equal('user_error');
    expect(props()).to.include({
      error_reason: 'invalid_params',
      error_source: 'validation',
    });
    expect(props()).not.to.have.property('failed_command_index');
  });

  it('classifies network failures', async () => {
    const { execute, props } = register({
      run: async () => {
        throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:3000');
      },
    });

    await rejects(execute({}, mockContext as never));
    expect(props().error_category).to.equal('network');
  });

  it('normalizes `ok` to `success` and derives the category from status_code', async () => {
    const { execute, props } = register({
      analyticsProps: () => ({ ok: false, status_code: 422 }),
    });

    await execute({}, mockContext as never);

    expect(props()).to.include({
      ok: false,
      success: false,
      error_category: 'user_error',
    });
  });

  it('maps a 5xx status_code to api_error', async () => {
    const { execute, props } = register({
      analyticsProps: () => ({ ok: false, status_code: 503 }),
    });

    await execute({}, mockContext as never);

    expect(props().error_category).to.equal('api_error');
  });

  it('reports failure and keeps the run props when format throws', async () => {
    const { execute, fire, props } = register({
      analyticsProps: () => ({ ok: false, status_code: 500 }),
      format: () => {
        throw new UserError('Request failed');
      },
    });

    const err = await rejects(execute({}, mockContext as never));
    expect(err.message).to.include('Request failed');
    expect(fire.calledOnce).to.be.true;
    expect(props()).to.include({
      success: false,
      status_code: 500,
      error_category: 'api_error',
    });
  });

  it('reports failure when format throws on otherwise successful props', async () => {
    const { execute, fire, props } = register({
      analyticsProps: () => ({ pages: 3 }),
      format: () => {
        throw new UserError('Nothing to render');
      },
    });

    const err = await rejects(execute({}, mockContext as never));
    expect(err.message).to.include('Nothing to render');
    expect(fire.calledOnce).to.be.true;
    expect(props()).to.include({
      success: false,
      error_category: 'user_error',
      pages: 3,
    });
  });

  it('lets a tool self-emit once, enriched, and does not double-fire', async () => {
    const { execute, fire, props } = register({
      run: async ({ analytics, token }) => {
        analytics?.fireToolRequest(token, 'test_tool', { success: false });
        return {};
      },
      analyticsProps: () => ({ pages: 3 }),
    });

    await execute({}, mockContext as never);

    expect(fire.calledOnce).to.be.true;
    expect(props()).to.include({
      success: false,
      error_category: 'unknown',
      analytics_version: 2,
    });
    expect(props().duration_ms).to.be.a('number');
    expect(props()).to.not.have.property('pages');
  });

  it('leaves the skill stream unlatched and unenriched', async () => {
    const { execute, fire, skill } = register({
      run: async ({ analytics, token }) => {
        analytics?.fireSkill(token, { skill_id: 'forms' });
        return {};
      },
    });

    await execute({}, mockContext as never);

    expect(skill.calledOnceWithExactly('test-token', { skill_id: 'forms' })).to
      .be.true;
    expect(fire.calledOnce).to.be.true;
  });
});
