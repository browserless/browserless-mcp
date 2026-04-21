import { expect } from 'chai';
import sinon from 'sinon';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { OAuthProxyError, type OAuthProxyConfig } from 'fastmcp/auth';
import { RedisOAuthProxy } from '../../src/lib/redis-oauth-proxy.js';

const UPSTREAM_CLIENT_ID = 'upstream-client-id';
const UPSTREAM_CLIENT_SECRET = 'upstream-client-secret';
const LEGIT_REDIRECT = 'https://client.example.com/callback';
const EVIL_REDIRECT = 'https://evil.attacker.com/steal';

function buildConfig(overrides: Partial<OAuthProxyConfig> = {}): OAuthProxyConfig {
  return {
    allowedRedirectUriPatterns: ['https://client.example.com/*'],
    baseUrl: 'http://localhost:4200',
    consentRequired: false,
    enableTokenSwap: false,
    scopes: [],
    upstreamAuthorizationEndpoint: 'https://provider.example.com/oauth/authorize',
    upstreamClientId: UPSTREAM_CLIENT_ID,
    upstreamClientSecret: UPSTREAM_CLIENT_SECRET,
    upstreamTokenEndpoint: 'https://provider.example.com/oauth/token',
    ...overrides,
  };
}

function makeRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

function baseAuthorizeParams(
  overrides: Partial<{
    client_id: string;
    redirect_uri: string;
    response_type: string;
    state: string;
  }> = {},
) {
  return {
    client_id: UPSTREAM_CLIENT_ID,
    redirect_uri: LEGIT_REDIRECT,
    response_type: 'code',
    state: 'client-state',
    ...overrides,
  } as Parameters<RedisOAuthProxy['authorize']>[0];
}

function mockUpstreamTokenFetch(): sinon.SinonStub {
  return sinon.stub(globalThis, 'fetch').resolves(
    new Response(
      JSON.stringify({
        access_token: 'UP_ACCESS_TOKEN',
        expires_in: 3600,
        refresh_token: 'UP_REFRESH_TOKEN',
        scope: 'read',
        token_type: 'Bearer',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

describe('RedisOAuthProxy', () => {
  let redis: Redis;
  let proxy: RedisOAuthProxy;

  beforeEach(async () => {
    redis = makeRedis();
    // ioredis-mock shares state across instances by default; reset between tests
    // to simulate a fresh Redis. Cross-instance sharing is still available within
    // a single test (that's what simulates the multi-instance deployment).
    await redis.flushall();
    proxy = new RedisOAuthProxy(buildConfig(), redis);
  });

  afterEach(async () => {
    sinon.restore();
    proxy.destroy();
    await redis.quit();
  });

  describe('constructor', () => {
    it('throws when consentRequired is true (unsupported in multi-instance)', () => {
      expect(
        () =>
          new RedisOAuthProxy(buildConfig({ consentRequired: true }), redis),
      ).to.throw(/consentRequired: false/);
    });
  });

  describe('registerClient', () => {
    it('mirrors every redirect_uri to Redis under the client registry prefix', async () => {
      await proxy.registerClient({
        redirect_uris: [
          'https://client.example.com/a',
          'https://client.example.com/b',
        ],
      });

      const a = await redis.exists('mcp:oauth:client:https://client.example.com/a');
      const b = await redis.exists('mcp:oauth:client:https://client.example.com/b');
      expect(a).to.equal(1);
      expect(b).to.equal(1);
    });

    it('sets a TTL on each registered redirect_uri', async () => {
      await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });

      const ttl = await redis.ttl(`mcp:oauth:client:${LEGIT_REDIRECT}`);
      expect(ttl).to.be.greaterThan(0);
    });

    it('still rejects unregistered patterns at DCR (validateRedirectUri unchanged)', async () => {
      try {
        await proxy.registerClient({ redirect_uris: [EVIL_REDIRECT] });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_redirect_uri');
      }
    });
  });

  describe('authorize CWE-601 checks', () => {
    it('rejects an unknown client_id with invalid_client', async () => {
      await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });

      try {
        await proxy.authorize(
          baseAuthorizeParams({ client_id: 'not-the-upstream' }),
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_client');
      }
    });

    it('rejects a redirect_uri that was never registered via DCR', async () => {
      try {
        await proxy.authorize(baseAuthorizeParams());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_request');
      }
    });

    it('rejects an attacker redirect_uri even when client_id matches', async () => {
      await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });

      try {
        await proxy.authorize(
          baseAuthorizeParams({ redirect_uri: EVIL_REDIRECT }),
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_request');
      }
    });

    it('accepts a redirect_uri registered on a different instance via shared Redis', async () => {
      // Instance A: DCR
      const proxyA = new RedisOAuthProxy(buildConfig(), redis);
      await proxyA.registerClient({ redirect_uris: [LEGIT_REDIRECT] });
      proxyA.destroy();

      // Instance B: authorize reads the DCR state from shared Redis
      const proxyB = new RedisOAuthProxy(buildConfig(), redis);
      try {
        const response = await proxyB.authorize(baseAuthorizeParams());
        expect(response.status).to.equal(302);
        expect(response.headers.get('Location')).to.include(
          'provider.example.com/oauth/authorize',
        );
      } finally {
        proxyB.destroy();
      }
    });

    it('persists the transaction to Redis after successful validation', async () => {
      await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });

      const response = await proxy.authorize(baseAuthorizeParams());
      const upstreamUrl = new URL(response.headers.get('Location')!);
      const transactionId = upstreamUrl.searchParams.get('state')!;

      const stored = await redis.get(`mcp:oauth:tx:${transactionId}`);
      expect(stored).to.be.a('string');
    });
  });

  describe('exchangeAuthorizationCode', () => {
    it('rejects an unknown client_id with invalid_client', async () => {
      try {
        await proxy.exchangeAuthorizationCode({
          client_id: 'not-the-upstream',
          code: 'anything',
          grant_type: 'authorization_code',
          redirect_uri: LEGIT_REDIRECT,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_client');
      }
    });

    async function runToAuthorizationCode(p: RedisOAuthProxy) {
      await p.registerClient({ redirect_uris: [LEGIT_REDIRECT] });
      const authResp = await p.authorize(baseAuthorizeParams());
      const txId = new URL(authResp.headers.get('Location')!).searchParams.get(
        'state',
      )!;
      const cbReq = new Request(
        `http://localhost:4200/oauth/callback?code=UP_CODE&state=${encodeURIComponent(txId)}`,
      );
      const cbResp = await p.handleCallback(cbReq);
      return new URL(cbResp.headers.get('Location')!).searchParams.get('code')!;
    }

    it('non-PKCE happy path returns the upstream access token', async () => {
      mockUpstreamTokenFetch();
      const code = await runToAuthorizationCode(proxy);

      const tokens = await proxy.exchangeAuthorizationCode({
        client_id: UPSTREAM_CLIENT_ID,
        code,
        grant_type: 'authorization_code',
        redirect_uri: LEGIT_REDIRECT,
      });

      expect(tokens.access_token).to.equal('UP_ACCESS_TOKEN');
      expect(tokens.token_type).to.equal('Bearer');
      expect(tokens.refresh_token).to.equal('UP_REFRESH_TOKEN');
    });

    it('non-PKCE redemption is one-time use — second call throws invalid_grant', async () => {
      mockUpstreamTokenFetch();
      const code = await runToAuthorizationCode(proxy);

      await proxy.exchangeAuthorizationCode({
        client_id: UPSTREAM_CLIENT_ID,
        code,
        grant_type: 'authorization_code',
        redirect_uri: LEGIT_REDIRECT,
      });

      try {
        await proxy.exchangeAuthorizationCode({
          client_id: UPSTREAM_CLIENT_ID,
          code,
          grant_type: 'authorization_code',
          redirect_uri: LEGIT_REDIRECT,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_grant');
      }
    });

    it('redemption is atomic across instances — GETDEL wins once', async () => {
      // Two proxies sharing Redis simulate two app instances racing to redeem
      // the same code. Exactly one should succeed; the other should see
      // invalid_grant. Without GETDEL (plain GET + DEL) both would succeed.
      mockUpstreamTokenFetch();
      const code = await runToAuthorizationCode(proxy);

      const proxyB = new RedisOAuthProxy(buildConfig(), redis);
      try {
        const results = await Promise.allSettled([
          proxy.exchangeAuthorizationCode({
            client_id: UPSTREAM_CLIENT_ID,
            code,
            grant_type: 'authorization_code',
            redirect_uri: LEGIT_REDIRECT,
          }),
          proxyB.exchangeAuthorizationCode({
            client_id: UPSTREAM_CLIENT_ID,
            code,
            grant_type: 'authorization_code',
            redirect_uri: LEGIT_REDIRECT,
          }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        expect(fulfilled).to.have.lengthOf(1);
        expect(rejected).to.have.lengthOf(1);
        expect(rejected[0].reason).to.be.instanceOf(OAuthProxyError);
        expect((rejected[0].reason as OAuthProxyError).code).to.equal(
          'invalid_grant',
        );
      } finally {
        proxyB.destroy();
      }
    });
  });

  describe('registerClient Redis failure rollback', () => {
    it('does not leave any Redis state when the mirror write fails', async () => {
      const setStub = sinon
        .stub(redis, 'set')
        .rejects(new Error('redis down'));

      try {
        await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).to.equal('redis down');
      }
      setStub.restore();

      // Redis has no registration → authorize rejects the URI
      try {
        await proxy.authorize(baseAuthorizeParams());
        expect.fail('authorize should have rejected the un-registered URI');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_request');
      }
    });

    it('surfaces the probe failure without attempting any writes', async () => {
      const existsStub = sinon
        .stub(redis, 'exists')
        .rejects(new Error('redis unreachable'));

      try {
        await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).to.equal('redis unreachable');
      }
      existsStub.restore();

      try {
        await proxy.authorize(baseAuthorizeParams());
        expect.fail('authorize should have rejected the un-registered URI');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_request');
      }
    });

    it('preserves pre-existing registrations when a later overlapping DCR fails', async () => {
      // Two different DCR calls happen to share a redirect_uri (rare but
      // possible: same client re-registering, or two clients with colliding
      // localhost ports). The first succeeds; the second fails its Redis
      // mirror. Rollback must NOT remove the URI that the first call
      // already legitimately registered.
      await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });

      // Verify initial registration is honored end-to-end
      const authOk = await proxy.authorize(baseAuthorizeParams());
      expect(authOk.status).to.equal(302);

      // Second DCR for the same URI: force Redis failure mid-mirror
      const setStub = sinon
        .stub(redis, 'set')
        .rejects(new Error('redis transient'));
      try {
        await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).to.equal('redis transient');
      }
      setStub.restore();

      // The prior registration must still be valid on both layers
      expect(
        await redis.exists(`mcp:oauth:client:${LEGIT_REDIRECT}`),
      ).to.equal(1);
      const authStillOk = await proxy.authorize(baseAuthorizeParams());
      expect(authStillOk.status).to.equal(302);
    });
  });

  describe('handleCallback defense-in-depth', () => {
    it('rejects when the transaction clientCallbackUrl is not in the registry and purges the transaction', async () => {
      // Simulates the multi-instance defense-in-depth scenario:
      //   Instance A: DCR + authorize (writes transaction + client to Redis)
      //   DCR TTL expires (or client de-registered) — Redis client key deleted
      //   Instance B: upstream callback arrives, local Map empty, Redis empty
      //               → must reject and purge the transaction
      const proxyA = new RedisOAuthProxy(buildConfig(), redis);
      await proxyA.registerClient({ redirect_uris: [LEGIT_REDIRECT] });
      const authResponse = await proxyA.authorize(baseAuthorizeParams());
      proxyA.destroy();

      const upstreamUrl = new URL(authResponse.headers.get('Location')!);
      const transactionId = upstreamUrl.searchParams.get('state')!;

      // Revoke registration from the shared Redis store
      await redis.del(`mcp:oauth:client:${LEGIT_REDIRECT}`);

      const fetchStub = mockUpstreamTokenFetch();
      const proxyB = new RedisOAuthProxy(buildConfig(), redis);
      const cbReq = new Request(
        `http://localhost:4200/oauth/callback?code=UP_CODE&state=${encodeURIComponent(transactionId)}`,
      );

      try {
        await proxyB.handleCallback(cbReq);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_request');
      } finally {
        proxyB.destroy();
      }

      // Transaction purged so it cannot be replayed
      const stored = await redis.get(`mcp:oauth:tx:${transactionId}`);
      expect(stored).to.equal(null);
      // Upstream token endpoint was never called
      expect(fetchStub.called).to.equal(false);
    });

    it('completes the happy path: 302 back to the registered callback with code + state', async () => {
      await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });
      mockUpstreamTokenFetch();

      const authResponse = await proxy.authorize(baseAuthorizeParams());
      const upstreamUrl = new URL(authResponse.headers.get('Location')!);
      const transactionId = upstreamUrl.searchParams.get('state')!;

      const cbReq = new Request(
        `http://localhost:4200/oauth/callback?code=UP_CODE&state=${encodeURIComponent(transactionId)}`,
      );
      const cbResp = await proxy.handleCallback(cbReq);

      expect(cbResp.status).to.equal(302);
      const finalLocation = new URL(cbResp.headers.get('Location')!);
      expect(finalLocation.origin + finalLocation.pathname).to.equal(LEGIT_REDIRECT);
      expect(finalLocation.searchParams.get('code')).to.be.a('string');
      expect(finalLocation.searchParams.get('state')).to.equal('client-state');

      // Transaction consumed
      const stored = await redis.get(`mcp:oauth:tx:${transactionId}`);
      expect(stored).to.equal(null);
      // Authorization code persisted in Redis for the token exchange
      const clientCode = finalLocation.searchParams.get('code')!;
      const codeStored = await redis.get(`mcp:oauth:code:${clientCode}`);
      expect(codeStored).to.be.a('string');
    });
  });
});
