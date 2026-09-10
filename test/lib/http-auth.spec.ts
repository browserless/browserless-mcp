import { expect } from 'chai';
import sinon from 'sinon';
import {
  authInputFromRequest,
  resolveBrowserlessAuth,
} from '../../src/lib/http-auth.js';

const config = {
  browserlessApiUrl: 'https://api.example.com',
  supabaseUrl: 'https://supabase.example.com',
  supabaseServiceRoleKey: 'service-role',
};

describe('resolveBrowserlessAuth', () => {
  afterEach(() => sinon.restore());

  for (const [input, token, authMethod] of [
    [{ authHeader: 'Bearer header-key' }, 'header-key', 'api_key_header'],
    [{ authHeader: 'header-key' }, 'header-key', 'api_key_header'],
    [{ tokenQuery: 'query-key' }, 'query-key', 'api_key_query'],
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
          app_metadata: { accountId: 'attribution-account' },
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

  it('honors an explicit api url override', async () => {
    const auth = await resolveBrowserlessAuth(
      { tokenQuery: 't', apiUrlHeader: 'https://eu.example.com' },
      config,
    );
    expect(auth.apiUrl).to.equal('https://eu.example.com');
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
