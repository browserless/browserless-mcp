import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import { LiveURLParamsSchema } from '../../src/tools/live-url.js';
import { registerLiveURLTool } from '../../src/tools/live-url.js';
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
  client: { version: undefined },
  streamContent: sinon.stub().resolves(),
  elicit: sinon.stub().resolves({ action: 'cancel' }),
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('browserless_live_url', () => {
  let fetchStub: sinon.SinonStub;
  const state = {
    status: 'open',
    reason: null,
    interactable: true,
    viewerCount: 2,
    expiresAt: 12345,
  };
  beforeEach(() => {
    fetchStub = sinon.stub(globalThis, 'fetch');
  });
  afterEach(() => sinon.restore());

  function tool(maxRetries = 0) {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const spy = sinon.spy(server, 'addTool');
    registerLiveURLTool(server, { ...mockConfig, maxRetries });
    return spy.firstCall.args[0];
  }
  const params = { browserId: 'browser/123', liveURLId: 'live?123' };
  const path = 'https://api.example.com/browser/browser%2F123/live';

  it('forwards all create options, preserving false, and returns IDs', async () => {
    const response = { liveURL: 'https://example.com/live', liveURLId: 'id' };
    fetchStub.resolves(jsonResponse(response));
    const options = {
      interactable: false,
      timeout: 5000,
      quality: 100,
      type: 'png' as const,
      resizable: false,
      showBrowserInterface: false,
      instructions: 'Verify.',
    };
    const result = await tool().execute(
      { action: 'create', ...params, ...options },
      mockContext,
    );
    const [url, init] = fetchStub.firstCall.args;
    expect(url).to.equal(path + '?token=test-token');
    expect(init.method).to.equal('POST');
    expect(JSON.parse(init.body)).to.deep.equal(options);
    expect(JSON.parse((result as any).content[0].text)).to.deep.equal(response);
  });

  it('leaves defaults to server', async () => {
    fetchStub.resolves(jsonResponse({ liveURL: 'url', liveURLId: 'id' }));
    await tool().execute(
      { action: 'create', browserId: params.browserId },
      mockContext,
    );
    expect(JSON.parse(fetchStub.firstCall.args[1].body)).to.deep.equal({});
  });

  it('GETs encoded IDs and returns every status field, including ended links', async () => {
    for (const status of ['open', 'expired', 'closed']) {
      const response = {
        ...state,
        status,
        reason:
          status === 'open'
            ? null
            : status === 'expired'
              ? 'timeout'
              : 'closed',
      };
      fetchStub.resolves(jsonResponse(response));
      const result = await tool().execute(
        { action: 'status', ...params },
        mockContext,
      );
      expect(JSON.parse((result as any).content[0].text)).to.deep.equal(
        response,
      );
      expect(fetchStub.lastCall.args[0]).to.equal(
        path + '/live%3F123?token=test-token',
      );
      expect(fetchStub.lastCall.args[1].method).to.equal('GET');
      expect(fetchStub.lastCall.args[1].body).to.equal(undefined);
    }
  });

  it('DELETE handles 204 without parsing JSON', async () => {
    fetchStub.resolves(new Response(null, { status: 204 }));
    const result = await tool().execute(
      { action: 'close', ...params },
      mockContext,
    );
    expect(fetchStub.firstCall.args[0]).to.equal(
      path + '/live%3F123?token=test-token',
    );
    expect(fetchStub.firstCall.args[1].method).to.equal('DELETE');
    expect(JSON.parse((result as any).content[0].text)).to.deep.equal({
      closed: true,
    });
  });

  it('uses session token and approved host override', async () => {
    fetchStub.resolves(jsonResponse(state));
    await tool().execute(
      { action: 'status', ...params },
      {
        ...mockContext,
        session: {
          token: 'session-token',
          apiUrl: 'https://production-lon.browserless.io',
        },
      },
    );
    expect(fetchStub.firstCall.args[0]).to.equal(
      'https://production-lon.browserless.io/browser/browser%2F123/live/live%3F123?token=session-token',
    );
  });

  it('rejects missing IDs and incompatible PNG quality before fetching', async () => {
    for (const input of [
      { action: 'status', browserId: 'b' },
      { action: 'close', browserId: 'b' },
      { action: 'create', browserId: 'b', type: 'png', quality: 70 },
    ]) {
      try {
        await tool().execute(input as any, mockContext);
        expect.fail('Expected error');
      } catch (error) {
        expect((error as Error).message).to.match(/liveURLId|PNG/);
      }
    }
    expect(fetchStub.called).to.be.false;
    for (const options of [
      { timeout: 0 },
      { timeout: 1.5 },
      { quality: 0 },
      { quality: 101 },
      { type: 'gif' },
      { interactable: 'yes' },
    ]) {
      expect(
        LiveURLParamsSchema.safeParse({
          action: 'create',
          browserId: 'b',
          ...options,
        }).success,
      ).to.be.false;
    }
  });

  it('retries transient status failures', async () => {
    const clock = sinon.useFakeTimers();
    fetchStub
      .onFirstCall()
      .resolves(new Response('Temporary failure', { status: 500 }));
    fetchStub.onSecondCall().resolves(jsonResponse(state));
    const pending = tool(1).execute(
      { action: 'status', ...params },
      mockContext,
    );
    await clock.tickAsync(1000);
    await pending;
    expect(fetchStub.calledTwice).to.be.true;
  });

  it('surfaces API failures and never retries mutations or 4xx', async () => {
    for (const action of ['create', 'close', 'status'] as const) {
      for (const status of action === 'status'
        ? [400, 401, 404]
        : [400, 401, 404, 500]) {
        fetchStub.resetHistory();
        fetchStub.callsFake(async () => new Response('Denied', { status }));
        try {
          await tool(2).execute({ action, ...params }, mockContext);
          expect.fail('Expected error');
        } catch (error) {
          expect((error as Error).message).to.include(String(status));
        }
        expect(fetchStub.calledOnce).to.be.true;
      }
    }
  });
});
