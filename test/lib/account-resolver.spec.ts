import { expect } from 'chai';
import sinon from 'sinon';
import {
  resolveApiKey,
  clearResolverCache,
} from '../../src/lib/account-resolver.js';

function buildFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fake-sig`;
}

const SUPABASE_URL = 'https://test.supabase.co';
const SERVICE_ROLE_KEY = 'test-service-role-key';

/** Supabase Auth `/auth/v1/user` success — the authoritative, signature-verified user. */
function supabaseUser(appMetadata: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ id: 'user-uuid', app_metadata: appMetadata }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

/** PostgREST `/rest/v1/accounts` success. */
function postgrestRows(rows: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('account-resolver', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    clearResolverCache();
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('verifies the token with Supabase Auth, then resolves the API key via PostgREST', async () => {
    const jwt = buildFakeJwt({
      sub: 'user-uuid',
      email: 'user@example.com',
      app_metadata: { accountId: 'acc-123' },
    });

    fetchStub.onFirstCall().resolves(supabaseUser({ accountId: 'acc-123' }));
    fetchStub
      .onSecondCall()
      .resolves(
        postgrestRows([{ api_key: 'resolved-key', email: 'user@example.com' }]),
      );

    const result = await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);

    expect(result.apiKey).to.equal('resolved-key');
    expect(result.email).to.equal('user@example.com');

    // First call must be the Supabase Auth verification with the USER's token.
    const [verifyUrl, verifyOpts] = fetchStub.firstCall.args;
    expect(verifyUrl).to.include('/auth/v1/user');
    expect(verifyOpts.headers.apikey).to.equal(SERVICE_ROLE_KEY);
    expect(verifyOpts.headers.Authorization).to.equal(`Bearer ${jwt}`);

    // Second call is the PostgREST lookup, keyed on the VERIFIED accountId.
    const [url, opts] = fetchStub.secondCall.args;
    expect(url).to.include('/rest/v1/accounts');
    expect(url).to.include('account_id=eq.acc-123');
    expect(opts.headers.apikey).to.equal(SERVICE_ROLE_KEY);
    expect(opts.headers.Authorization).to.equal(`Bearer ${SERVICE_ROLE_KEY}`);
  });

  it('rejects a token Supabase Auth does not accept (forged/expired) without any PostgREST call', async () => {
    // Attacker forges a token carrying a victim accountId; Supabase Auth rejects it.
    const forged = buildFakeJwt({
      sub: 'attacker',
      app_metadata: { accountId: 'victim-account' },
    });

    fetchStub.onFirstCall().resolves(
      new Response('{"msg":"invalid JWT"}', {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    try {
      await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, forged);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.include('rejected the access token');
    }

    // Crucially, no lookup for the victim account was ever made.
    expect(fetchStub.callCount).to.equal(1);
    expect(fetchStub.firstCall.args[0]).to.include('/auth/v1/user');
  });

  it('re-verifies every call but caches the account lookup', async () => {
    const jwt = buildFakeJwt({
      sub: 'user-uuid',
      app_metadata: { accountId: 'acc-456' },
    });

    // call 1: verify + PostgREST ; call 2: verify again, PostgREST from cache.
    fetchStub.onCall(0).resolves(supabaseUser({ accountId: 'acc-456' }));
    fetchStub
      .onCall(1)
      .resolves(
        postgrestRows([{ api_key: 'cached-key', email: 'cached@example.com' }]),
      );
    fetchStub.onCall(2).resolves(supabaseUser({ accountId: 'acc-456' }));

    await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);
    const result = await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);

    expect(result.apiKey).to.equal('cached-key');
    // Verification is NOT skipped on a cache hit — only the PostgREST account
    // lookup is cached. So 2 calls = verify(x2) + PostgREST(x1).
    const authCalls = fetchStub
      .getCalls()
      .filter((c) => String(c.args[0]).includes('/auth/v1/user'));
    const restCalls = fetchStub
      .getCalls()
      .filter((c) => String(c.args[0]).includes('/rest/v1/accounts'));
    expect(authCalls.length).to.equal(2);
    expect(restCalls.length).to.equal(1);
  });

  it('bounds every Supabase call with an abort signal (timeout guard)', async () => {
    const jwt = buildFakeJwt({
      sub: 'user-uuid',
      app_metadata: { accountId: 'acc-signal' },
    });
    fetchStub.onCall(0).resolves(supabaseUser({ accountId: 'acc-signal' }));
    fetchStub
      .onCall(1)
      .resolves(postgrestRows([{ api_key: 'k', email: 'e@example.com' }]));

    await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);

    // A hung Supabase must not stall these fetches — both carry an AbortSignal.
    for (const call of fetchStub.getCalls()) {
      expect(
        call.args[1]?.signal,
        `missing signal on ${call.args[0]}`,
      ).to.be.an('AbortSignal');
    }
  });

  it('throws when the verified user has no app_metadata.accountId', async () => {
    const jwt = buildFakeJwt({ sub: 'user-uuid', email: 'user@example.com' });

    fetchStub.onFirstCall().resolves(supabaseUser({}));

    try {
      await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.include('app_metadata.accountId');
    }
  });

  it('throws when PostgREST returns empty array', async () => {
    const jwt = buildFakeJwt({
      sub: 'user-uuid',
      app_metadata: { accountId: 'acc-missing' },
    });

    fetchStub
      .onFirstCall()
      .resolves(supabaseUser({ accountId: 'acc-missing' }));
    fetchStub.onSecondCall().resolves(postgrestRows([]));

    try {
      await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.include('Account not found');
    }
  });

  it('throws on PostgREST HTTP error', async () => {
    const jwt = buildFakeJwt({
      sub: 'user-uuid',
      app_metadata: { accountId: 'acc-err' },
    });

    fetchStub.onFirstCall().resolves(supabaseUser({ accountId: 'acc-err' }));
    fetchStub.onSecondCall().resolves(
      new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    try {
      await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.include('500');
    }
  });

  it('throws on invalid JWT format without contacting Supabase Auth', async () => {
    try {
      await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, 'not-a-jwt');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.include('Invalid JWT format');
    }
    expect(fetchStub.callCount).to.equal(0);
  });
});
