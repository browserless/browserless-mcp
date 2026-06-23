import { expect } from 'chai';
import { resolveBrowserlessAuth } from '../../src/lib/http-auth.js';

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

  it('honors an explicit api url override', async () => {
    const auth = await resolveBrowserlessAuth(
      { tokenQuery: 't', apiUrlHeader: 'https://eu.example.com' },
      config,
    );
    expect(auth.apiUrl).to.equal('https://eu.example.com');
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
