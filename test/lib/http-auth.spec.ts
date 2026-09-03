import { expect } from 'chai';
import { Hono } from 'hono';
import {
  guardRouteAuth,
  resolveBrowserlessAuth,
} from '../../src/lib/http-auth.js';
import { InvalidApiUrlError } from '../../src/lib/api-url-guard.js';

const config = {
  browserlessApiUrl: 'https://api.example.com',
  supabaseUrl: 'https://supabase.example.com',
  supabaseServiceRoleKey: 'service-role',
};

describe('resolveBrowserlessAuth', () => {
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

describe('guardRouteAuth', () => {
  const app = new Hono();
  app.get('*', async (c) => (await guardRouteAuth(c, config)) ?? c.text('ok'));

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
