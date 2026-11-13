import { expect } from 'chai';
import sinon from 'sinon';
import { Hono } from 'hono';
import type { IncomingMessage } from 'node:http';
import {
  authInputFromRequest,
  guardRouteAuth,
  presentsCredential,
  resolveBrowserlessAuth,
  resolveBrowserlessRequestAuth,
} from '../../src/lib/http-auth.js';
import { UnknownApiKeyError } from '../../src/lib/api-key-check.js';
import { InvalidApiUrlError } from '../../src/lib/api-url-guard.js';
import { clearResolverCache } from '../../src/lib/account-resolver.js';
import { isApiKeyCheck, stubApiKeyCheck } from '../helpers/api-key-check.js';

const config = {
  browserlessApiUrl: 'https://api.example.com',
  supabaseUrl: 'https://supabase.example.com',
  supabaseServiceRoleKey: 'service-role',
};

describe('resolveBrowserlessAuth', () => {
  afterEach(() => sinon.restore());

  it('rejects unsafe attach IDs from headers and decoded query parameters without resolving credentials', async () => {
    const fetch = sinon
      .stub(globalThis, 'fetch')
      .rejects(new Error('Unexpected credential lookup'));
    for (const char of [
      '\u0000',
      '\n',
      '\r',
      '\t',
      '\u001b',
      '\u0085',
      '\u202e',
      '\u200b',
      '\ufeff',
      '\u2028',
      '\u2029',
      '\u{e0001}',
    ]) {
      const id = 'browser' + char + 'id';
      for (const [headers, query] of [
        [{ 'x-browserless-session-id': id }, 'safe-browser'],
        [{}, id],
        [{ 'x-browserless-session-id': 'safe-browser' }, id],
      ] as const) {
        const input = authInputFromRequest({
          headers: { authorization: 'Bearer a.b.c', ...headers },
          url: '/mcp?browserlessSessionId=' + encodeURIComponent(query),
        });
        let error: unknown;
        try {
          await resolveBrowserlessAuth(input, config);
        } catch (caught) {
          error = caught;
        }
        expect(error).to.be.instanceOf(Response);
        expect((error as Response).status).to.equal(400);
        const body = await (error as Response).text();
        expect(body).to.include('session ID');
        expect(body).not.to.include(id);
      }
    }
    expect(fetch.called).to.equal(false);
    expect(
      (
        await resolveBrowserlessAuth(
          {
            authHeader: 'key',
            sessionIdHeader: 'browser-header',
            sessionIdQuery: 'browser-query',
          },
          config,
        )
      ).attachSessionId,
    ).to.equal('browser-header');
    expect(
      (
        await resolveBrowserlessAuth(
          { authHeader: 'key', sessionIdQuery: 'browser-query' },
          config,
        )
      ).attachSessionId,
    ).to.equal('browser-query');
  });

  it('distinguishes presented credentials without resolving them', () => {
    for (const [input, expected] of [
      [{}, false],
      [{ authHeader: 'Bearer ' }, false],
      [{ authHeader: 'Bearer' }, false],
      [{ authHeader: 'bearer' }, false],
      [{ authHeader: ' \tBeArEr\t ' }, false],
      [{ authHeader: '   ' }, false],
      [{ authHeader: 'Bearer abc' }, true],
      [{ authHeader: 'abc' }, true],
      [{ tokenQuery: 'x' }, true],
      [{ authHeader: 'Bearer header.payload.signature' }, true],
    ] as const)
      expect(presentsCredential(input)).to.equal(expected);
  });

  for (const [input, token, authMethod] of [
    [{ authHeader: 'Bearer header-key' }, 'header-key', 'api_key_header'],
    [{ authHeader: ' bearer\theader-key ' }, 'header-key', 'api_key_header'],
    [{ authHeader: 'BearerPrefix-key' }, 'BearerPrefix-key', 'api_key_header'],
    [{ authHeader: 'header-key' }, 'header-key', 'api_key_header'],
    [{ tokenQuery: 'query-key' }, 'query-key', 'api_key_query'],
    [
      { authHeader: 'Bearer', tokenQuery: 'query-key' },
      'query-key',
      'api_key_query',
    ],
    [
      { authHeader: 'Bearer header-key', tokenQuery: 'query-key' },
      'header-key',
      'api_key_header',
    ],
    [
      { authHeader: 'Bearer header.jwt.signature', tokenQuery: 'query-key' },
      'query-key',
      'api_key_query',
    ],
  ] as const) {
    it(`attributes the selected key for ${JSON.stringify(input)}`, async () => {
      expect(await resolveBrowserlessAuth(input, config)).to.include({
        token,
        authMethod,
      });
    });
  }

  it('attributes a verified JWT exchange as OAuth', async () => {
    const fetch = sinon.stub(globalThis, 'fetch');
    fetch.onFirstCall().resolves(
      new Response(
        JSON.stringify({
          id: 'user',
          app_metadata: { accountId: 'attribution-account', role: 'owner' },
        }),
      ),
    );
    fetch
      .onSecondCall()
      .resolves(
        new Response(
          JSON.stringify([
            { api_key: 'resolved-key', email: 'user@example.com' },
          ]),
        ),
      );
    const auth = await resolveBrowserlessAuth(
      { authHeader: `Bearer auth-attribution.${Date.now()}.signature` },
      config,
    );
    expect(auth).to.include({
      token: 'resolved-key',
      accountId: 'attribution-account',
      authMethod: 'oauth',
    });
    expect(fetch.firstCall.args[0]).to.include('/auth/v1/user');
    expect(fetch.secondCall.args[0]).to.include('/rest/v1/accounts');
  });

  for (const [requestPath, transport] of [
    ['/sse?token=x', 'sse'],
    ['/mcp?next=/sse', 'streamable-http'],
    [undefined, 'streamable-http'],
  ] as const) {
    it(`attributes transport for ${requestPath}`, async () => {
      expect(
        await resolveBrowserlessAuth(
          { tokenQuery: 'key', requestPath },
          config,
        ),
      ).to.include({ transport });
    });
  }

  it('sanitizes user agent before storing it on the session', async () => {
    expect(
      await resolveBrowserlessAuth(
        { tokenQuery: 'key', userAgentHeader: [' a/1 ', 'b/2'] },
        config,
      ),
    ).to.include({ userAgent: 'a/1' });
    expect(
      await resolveBrowserlessAuth(
        { tokenQuery: 'key', userAgentHeader: 'a'.repeat(500) },
        config,
      ),
    ).to.include({ userAgent: 'a'.repeat(200) });
  });

  it('accepts a plain API key from the Authorization header', async () => {
    const auth = await resolveBrowserlessAuth(
      { authHeader: 'Bearer plain-token' },
      config,
    );
    expect(auth.token).to.equal('plain-token');
    expect(auth.apiUrl).to.equal('https://api.example.com');
  });

  it('accepts a bare (non-Bearer) Authorization header', async () => {
    const auth = await resolveBrowserlessAuth(
      { authHeader: 'plain-token' },
      config,
    );
    expect(auth.token).to.equal('plain-token');
  });

  it('accepts a ?token= query param', async () => {
    const auth = await resolveBrowserlessAuth(
      { tokenQuery: 'query-token' },
      config,
    );
    expect(auth.token).to.equal('query-token');
  });

  it('honors an allowed api url override', async () => {
    const auth = await resolveBrowserlessAuth(
      {
        tokenQuery: 't',
        apiUrlHeader: 'https://production-lon.browserless.io',
      },
      config,
    );
    expect(auth.apiUrl).to.equal('https://production-lon.browserless.io');
  });

  it('rejects disallowed header and query api url overrides', async () => {
    for (const input of [
      { apiUrlHeader: 'https://eu.example.com' },
      { apiUrlHeader: '' },
      { browserlessUrlQuery: 'http://127.0.0.1:9999' },
    ]) {
      try {
        await resolveBrowserlessAuth({ tokenQuery: 't', ...input }, config);
        expect.fail('should have rejected the override');
      } catch (error) {
        expect(error).to.be.instanceOf(InvalidApiUrlError);
      }
    }
  });

  it('trusts the configured base when there is no override', async () => {
    const auth = await resolveBrowserlessAuth(
      { tokenQuery: 't' },
      { ...config, browserlessApiUrl: 'file:///operator-controlled' },
    );
    expect(auth.apiUrl).to.equal('file:///operator-controlled');
  });

  it('passes the mcp source through from header then query', async () => {
    const fromHeader = await resolveBrowserlessAuth(
      { tokenQuery: 't', sourceHeader: 'cli_agent', sourceQuery: 'autologin' },
      config,
    );
    expect(fromHeader.source).to.equal('cli_agent');

    const fromQuery = await resolveBrowserlessAuth(
      { tokenQuery: 't', sourceQuery: 'autologin' },
      config,
    );
    expect(fromQuery.source).to.equal('autologin');
  });

  it('retains the verified OAuth user identity with the shared account key', async () => {
    clearResolverCache();
    const jwt = 'header.payload.signature';
    const fetchStub = sinon.stub(globalThis, 'fetch');
    fetchStub.onFirstCall().resolves(
      new Response(
        JSON.stringify({
          id: 'user-123',
          app_metadata: { accountId: 'account-123', role: 'admin' },
        }),
        { status: 200 },
      ),
    );
    fetchStub
      .onSecondCall()
      .resolves(
        new Response(
          JSON.stringify([
            { api_key: 'shared-account-key', email: 'user@example.com' },
          ]),
          { status: 200 },
        ),
      );

    try {
      const auth = await resolveBrowserlessAuth(
        { authHeader: `Bearer ${jwt}` },
        config,
      );
      expect(auth).to.include({
        token: 'shared-account-key',
        accountId: 'account-123',
        userId: 'user-123',
        userRole: 'admin',
        identityToken: jwt,
      });
    } finally {
      sinon.restore();
      clearResolverCache();
    }
  });

  it('throws when no token is present', async () => {
    let threw = false;
    try {
      await resolveBrowserlessAuth({}, config);
    } catch (e) {
      threw = true;
      expect((e as Error).message).to.match(/No Browserless API token/);
    }
    expect(threw).to.be.true;
  });

  for (const authHeader of [
    'Bearer',
    'Bearer ',
    'bearer',
    ' \tBeArEr\t ',
    '   ',
  ]) {
    it(`rejects an empty credential ${JSON.stringify(authHeader)}`, async () => {
      let error: unknown;
      try {
        await resolveBrowserlessAuth({ authHeader }, config);
      } catch (caught) {
        error = caught;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(/No Browserless API token/);
    });
  }
});

describe('authInputFromRequest', () => {
  it('maps headers and query parameters without conflating their precedence', () => {
    const url =
      '/sse?token=q&browserlessUrl=https://y&browserlessSessionId=s2&mcpSource=script_builder';
    expect(
      authInputFromRequest({
        headers: {
          authorization: 'Bearer k',
          'x-browserless-api-url': 'https://x',
          'x-browserless-session-id': 's1',
          'x-browserless-mcp-source': 'cli_agent',
          'user-agent': ['ua/1', 'ua/2'],
        } as never,
        url,
      }),
    ).to.deep.equal({
      authHeader: 'Bearer k',
      tokenQuery: 'q',
      apiUrlHeader: 'https://x',
      browserlessUrlQuery: 'https://y',
      sessionIdHeader: 's1',
      sessionIdQuery: 's2',
      sourceHeader: 'cli_agent',
      sourceQuery: 'script_builder',
      userAgentHeader: ['ua/1', 'ua/2'],
      requestPath: url,
    });
  });

  it('maps absent headers and URL to ten absent inputs', () => {
    const input = authInputFromRequest({ headers: {}, url: undefined });
    expect(Object.keys(input)).to.have.length(10);
    expect(Object.values(input).every((value) => value === undefined)).to.be
      .true;
  });
});

describe('guardRouteAuth', () => {
  const app = new Hono();
  app.get('*', async (c) => {
    const auth = await guardRouteAuth(c, config);
    return auth instanceof Response ? auth : c.json(auth);
  });

  beforeEach(() => stubApiKeyCheck());
  afterEach(() => sinon.restore());

  it('retains the authenticated token for file ownership', async () => {
    const response = await app.request('http://example.test/', {
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(response.status).to.equal(200);
    expect(await response.json()).to.include({
      token: 'owner-token',
      apiUrl: config.browserlessApiUrl,
    });
  });

  it('returns 400 for an invalid api url override', async () => {
    const response = await app.request('http://example.test/', {
      headers: {
        authorization: 'Bearer token',
        'x-browserless-api-url': 'http://127.0.0.1:9999',
      },
    });
    expect(response.status).to.equal(400);
    expect(await response.json()).to.deep.equal({
      ok: false,
      error: 'Invalid x-browserless-api-url',
    });
  });

  it('still returns 401 without a token', async () => {
    const response = await app.request('http://example.test/');
    expect(response.status).to.equal(401);
    expect(await response.json()).to.deep.equal({
      ok: false,
      error: 'Unauthorized',
    });
  });
});

describe('API key check', () => {
  const app = new Hono();
  app.get('*', async (c) => {
    const auth = await guardRouteAuth(c, config);
    return auth instanceof Response ? auth : c.json(auth);
  });

  const request = (
    url: string,
    headers: Record<string, string> = {},
    method = 'POST',
  ) => ({ method, url, headers }) as unknown as IncomingMessage;

  const checks = (fetch: sinon.SinonStub) =>
    fetch.getCalls().filter((call) => isApiKeyCheck(call.args[0]));

  const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    return undefined;
  };

  afterEach(() => sinon.restore());

  for (const [label, req] of [
    ['header', request('/mcp', { authorization: 'Bearer junk-header' })],
    ['query', request('/mcp?token=junk-query')],
    [
      'header with an empty mcp-session-id',
      request('/mcp', {
        authorization: 'Bearer junk-empty-session',
        'mcp-session-id': '',
      }),
    ],
  ] as const) {
    it(`refuses an unknown ${label} key on a session-opening request`, async () => {
      const fetch = stubApiKeyCheck(401);
      expect(
        await rejection(resolveBrowserlessRequestAuth(req, config as never)),
      ).to.be.instanceOf(UnknownApiKeyError);
      expect(checks(fetch)).to.have.length(1);
      expect(checks(fetch)[0].args[0]).to.equal(
        config.browserlessApiUrl + '/active',
      );
    });
  }

  it('accepts a known key on a session-opening request', async () => {
    stubApiKeyCheck(204);
    expect(
      await resolveBrowserlessRequestAuth(
        request('/mcp', { authorization: 'Bearer good' }),
        config as never,
      ),
    ).to.include({ token: 'good', authMethod: 'api_key_header' });
  });

  it('lets a billing-blocked key open a session', async () => {
    stubApiKeyCheck(
      async () =>
        new Response(
          'Your account has run out of credits, please upgrade your plan (requestId: test)',
          { status: 401 },
        ),
    );
    expect(
      await resolveBrowserlessRequestAuth(
        request('/mcp', { authorization: 'Bearer out-of-credits' }),
        config as never,
      ),
    ).to.include({ token: 'out-of-credits' });
  });

  for (const [label, req] of [
    [
      'an mcp-session-id header',
      request('/mcp', {
        authorization: 'Bearer junk-live',
        'mcp-session-id': 'live-session',
      }),
    ],
    [
      'a legacy SSE message post',
      request('/messages?sessionId=live-session&token=junk-live'),
    ],
  ] as const) {
    it(`does not check the key on a request naming ${label}`, async () => {
      const fetch = stubApiKeyCheck(401);
      expect(
        await resolveBrowserlessRequestAuth(req, config as never),
      ).to.include({ token: 'junk-live' });
      expect(checks(fetch)).to.have.length(0);
    });
  }

  it('never checks a JWT or a missing token', async () => {
    const fetch = stubApiKeyCheck(401);
    fetch
      .withArgs(sinon.match(/\/auth\/v1\/user/))
      .resolves(new Response('{}', { status: 401 }));
    clearResolverCache();
    await rejection(
      resolveBrowserlessRequestAuth(
        request('/mcp', { authorization: 'Bearer header.payload.sig' }),
        config as never,
      ),
    );
    await rejection(
      resolveBrowserlessRequestAuth(request('/mcp'), config as never),
    );
    expect(checks(fetch)).to.have.length(0);
    clearResolverCache();
  });

  it('rejects a disallowed override before any key check', async () => {
    const fetch = stubApiKeyCheck(204);
    expect(
      await rejection(
        resolveBrowserlessRequestAuth(
          request('/mcp', {
            authorization: 'Bearer good',
            'x-browserless-api-url': 'http://127.0.0.1:9999',
          }),
          config as never,
        ),
      ),
    ).to.be.instanceOf(InvalidApiUrlError);
    expect(fetch.called).to.equal(false);
  });

  it('checks an allowed override against that API URL', async () => {
    const fetch = stubApiKeyCheck(204);
    await resolveBrowserlessRequestAuth(
      request('/mcp', {
        authorization: 'Bearer good',
        'x-browserless-api-url': 'https://production-lon.browserless.io',
      }),
      config as never,
    );
    expect(checks(fetch)[0].args[0]).to.equal(
      'https://production-lon.browserless.io/active',
    );
  });

  it('refuses an unknown key on file routes and admits a known one', async () => {
    const fetch = stubApiKeyCheck((key) =>
      key === 'good'
        ? new Response(null, { status: 204 })
        : new Response(
            'Invalid API key. Please check your API key and try again. (requestId: test)',
            { status: 401 },
          ),
    );
    const refused = await app.request('http://example.test/', {
      headers: { authorization: 'Bearer junk-route' },
    });
    expect(refused.status).to.equal(401);
    expect(await refused.json()).to.deep.equal({
      ok: false,
      error: 'Unauthorized',
    });
    const queried = await app.request('http://example.test/?token=junk-query');
    expect(queried.status).to.equal(401);

    const admitted = await app.request('http://example.test/', {
      headers: { authorization: 'Bearer good' },
    });
    expect(admitted.status).to.equal(200);
    expect(await admitted.json()).to.include({ token: 'good' });
    expect(checks(fetch)).to.have.length(3);
  });
});
