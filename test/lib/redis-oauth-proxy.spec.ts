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

      // Instance B: authorize (empty local registeredClients Map)
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
