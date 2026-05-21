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

describe('account-resolver', () => {
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    clearResolverCache();
    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  it('resolves API key from valid Supabase JWT via PostgREST', async () => {
    const jwt = buildFakeJwt({
      sub: 'user-uuid',
      email: 'user@example.com',
      app_metadata: { accountId: 'acc-123' },
    });

    fetchStub.resolves(
      new Response(
        JSON.stringify([
          { api_key: 'resolved-key', email: 'user@example.com' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);

    expect(result.apiKey).to.equal('resolved-key');
    expect(result.email).to.equal('user@example.com');

    // Verify PostgREST call
    const [url, opts] = fetchStub.firstCall.args;
    expect(url).to.include('/rest/v1/accounts');
    expect(url).to.include('account_id=eq.acc-123');
    expect(opts.headers.apikey).to.equal(SERVICE_ROLE_KEY);
    expect(opts.headers.Authorization).to.equal(`Bearer ${SERVICE_ROLE_KEY}`);
  });

  it('returns cached result on second call', async () => {
    const jwt = buildFakeJwt({
      sub: 'user-uuid',
      app_metadata: { accountId: 'acc-456' },
    });

    fetchStub.resolves(
      new Response(
        JSON.stringify([
          { api_key: 'cached-key', email: 'cached@example.com' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);
    const result = await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, jwt);

    expect(result.apiKey).to.equal('cached-key');
    expect(fetchStub.callCount).to.equal(1);
  });

  it('throws when JWT has no app_metadata.accountId', async () => {
    const jwt = buildFakeJwt({ sub: 'user-uuid', email: 'user@example.com' });

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

    fetchStub.resolves(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

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

    fetchStub.resolves(
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

  it('throws on invalid JWT format', async () => {
    try {
      await resolveApiKey(SUPABASE_URL, SERVICE_ROLE_KEY, 'not-a-jwt');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.include('Invalid JWT format');
    }
  });
});
