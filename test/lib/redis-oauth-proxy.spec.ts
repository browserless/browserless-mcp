import { expect } from 'chai';
import sinon from 'sinon';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { OAuthProxyError, type OAuthProxyConfig } from 'fastmcp/auth';
import { RedisOAuthProxy } from '../../src/lib/redis-oauth-proxy.js';

const UPSTREAM_CLIENT_ID = 'upstream-client-id';
const UPSTREAM_CLIENT_SECRET = 'upstream-client-secret';
const LEGIT_REDIRECT = 'https://client.example.com/callback';
const OTHER_LEGIT_REDIRECT = 'https://client.example.com/other';
const EVIL_REDIRECT = 'https://evil.attacker.com/steal';

function buildConfig(
  overrides: Partial<OAuthProxyConfig> = {},
): OAuthProxyConfig {
  return {
    allowedRedirectUriPatterns: ['https://client.example.com/*'],
    baseUrl: 'http://localhost:4200',
    consentRequired: false,
    enableTokenSwap: false,
    scopes: [],
    upstreamAuthorizationEndpoint:
      'https://provider.example.com/oauth/authorize',
    upstreamClientId: UPSTREAM_CLIENT_ID,
    upstreamClientSecret: UPSTREAM_CLIENT_SECRET,
    upstreamTokenEndpoint: 'https://provider.example.com/oauth/token',
    ...overrides,
  };
}

function makeRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

// DCR issues a random per-client client_id; clients authorize with THAT id, not
// the upstream identity. Register first and use the returned id everywhere.
async function dcr(
  p: RedisOAuthProxy,
  redirectUris: string[] = [LEGIT_REDIRECT],
): Promise<string> {
  const resp = await p.registerClient({ redirect_uris: redirectUris });
  return resp.client_id;
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

function mockUpstreamTokenFetch(
  extra: Record<string, unknown> = {},
): sinon.SinonStub {
  return sinon.stub(globalThis, 'fetch').resolves(
    new Response(
      JSON.stringify({
        access_token: 'UP_ACCESS_TOKEN',
        expires_in: 3600,
        refresh_token: 'UP_REFRESH_TOKEN',
        scope: 'read',
        token_type: 'Bearer',
        ...extra,
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

    it('throws when enableTokenSwap is true (token-swap not supported)', () => {
      expect(
        () =>
          new RedisOAuthProxy(buildConfig({ enableTokenSwap: true }), redis),
      ).to.throw(/enableTokenSwap: false/);
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

      const a = await redis.exists(
        'mcp:oauth:client:https://client.example.com/a',
      );
      const b = await redis.exists(
        'mcp:oauth:client:https://client.example.com/b',
      );
      expect(a).to.equal(1);
      expect(b).to.equal(1);
    });

    it('stores the client redirect_uris under the client-id key', async () => {
      const resp = await proxy.registerClient({
        redirect_uris: [LEGIT_REDIRECT],
      });
      const stored = await redis.get(`mcp:oauth:client-id:${resp.client_id}`);
      expect(JSON.parse(stored!)).to.deep.equal([LEGIT_REDIRECT]);
    });

    it('sets the 90-day client TTL on the registration keys', async () => {
      const resp = await proxy.registerClient({
        redirect_uris: [LEGIT_REDIRECT],
      });

      const NINETY_DAYS = 90 * 24 * 60 * 60;
      const uriTtl = await redis.ttl(`mcp:oauth:client:${LEGIT_REDIRECT}`);
      const idTtl = await redis.ttl(`mcp:oauth:client-id:${resp.client_id}`);
      expect(uriTtl).to.be.closeTo(NINETY_DAYS, 60);
      expect(idTtl).to.be.closeTo(NINETY_DAYS, 60);
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
    it('accepts a DCR-issued client_id', async () => {
      const clientId = await dcr(proxy);
      const response = await proxy.authorize(
        baseAuthorizeParams({ client_id: clientId }),
      );
      expect(response.status).to.equal(302);
      expect(response.headers.get('Location')).to.include(
        'provider.example.com/oauth/authorize',
      );
    });

    it('rejects an unknown client_id with invalid_client', async () => {
      // A valid registration exists, but the request uses a different id.
      await dcr(proxy);

      try {
        await proxy.authorize(
          baseAuthorizeParams({ client_id: 'never-registered' }),
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_client');
      }
    });

    it('rejects a redirect_uri that was never registered via DCR', async () => {
      const clientId = await dcr(proxy);

      try {
        await proxy.authorize(
          baseAuthorizeParams({
            client_id: clientId,
            redirect_uri: OTHER_LEGIT_REDIRECT,
          }),
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_request');
      }
    });

    it('rejects an attacker redirect_uri even when client_id is valid', async () => {
      const clientId = await dcr(proxy);

      try {
        await proxy.authorize(
          baseAuthorizeParams({
            client_id: clientId,
            redirect_uri: EVIL_REDIRECT,
          }),
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_request');
      }
    });

    it('rejects a redirect_uri registered to a different client (per-client binding)', async () => {
      const clientA = await dcr(proxy, [LEGIT_REDIRECT]);
      const clientB = await dcr(proxy, [OTHER_LEGIT_REDIRECT]);
      expect(clientB).to.not.equal(clientA);

      // B's redirect_uri is globally registered, but it is not bound to A.
      // A global check would let this pass; the per-client check must not.
      try {
        await proxy.authorize(
          baseAuthorizeParams({
            client_id: clientA,
            redirect_uri: OTHER_LEGIT_REDIRECT,
          }),
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_request');
      }
    });

    it('accepts a client registered on a different instance via shared Redis', async () => {
      // Instance A: DCR
      const proxyA = new RedisOAuthProxy(buildConfig(), redis);
      const clientId = await dcr(proxyA);
      proxyA.destroy();

      // Instance B: authorize reads the DCR state from shared Redis. This is
      // the regression guard for the original bug — A's client_id must be
      // recognized by B even though B's in-memory client Map is empty.
      const proxyB = new RedisOAuthProxy(buildConfig(), redis);
      try {
        const response = await proxyB.authorize(
          baseAuthorizeParams({ client_id: clientId }),
        );
        expect(response.status).to.equal(302);
        expect(response.headers.get('Location')).to.include(
          'provider.example.com/oauth/authorize',
        );
      } finally {
        proxyB.destroy();
      }
    });

    it('persists the transaction to Redis after successful validation', async () => {
      const clientId = await dcr(proxy);

      const response = await proxy.authorize(
        baseAuthorizeParams({ client_id: clientId }),
      );
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
          client_id: 'never-registered',
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

    async function runToAuthorizationCode(
      p: RedisOAuthProxy,
    ): Promise<{ clientId: string; code: string }> {
      const clientId = await dcr(p);
      const authResp = await p.authorize(
        baseAuthorizeParams({ client_id: clientId }),
      );
      const txId = new URL(authResp.headers.get('Location')!).searchParams.get(
        'state',
      )!;
      const cbReq = new Request(
        `http://localhost:4200/oauth/callback?code=UP_CODE&state=${encodeURIComponent(txId)}`,
      );
      const cbResp = await p.handleCallback(cbReq);
      const code = new URL(cbResp.headers.get('Location')!).searchParams.get(
        'code',
      )!;
      return { clientId, code };
    }

    async function mintPkceCode(
      p: RedisOAuthProxy,
      challenge: string,
      method = 'S256',
    ): Promise<{ clientId: string; code: string }> {
      const clientId = await dcr(p);
      const authResp = await p.authorize(
        baseAuthorizeParams({
          client_id: clientId,
          code_challenge: challenge,
          code_challenge_method: method,
        } as Parameters<RedisOAuthProxy['authorize']>[0]),
      );
      const txId = new URL(authResp.headers.get('Location')!).searchParams.get(
        'state',
      )!;
      const cbResp = await p.handleCallback(
        new Request(
          `http://localhost:4200/oauth/callback?code=UP_CODE&state=${encodeURIComponent(txId)}`,
        ),
      );
      const code = new URL(cbResp.headers.get('Location')!).searchParams.get(
        'code',
      )!;
      return { clientId, code };
    }

    it('non-PKCE happy path returns the upstream access token', async () => {
      mockUpstreamTokenFetch();
      const { clientId, code } = await runToAuthorizationCode(proxy);

      const tokens = await proxy.exchangeAuthorizationCode({
        client_id: clientId,
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
      const { clientId, code } = await runToAuthorizationCode(proxy);

      await proxy.exchangeAuthorizationCode({
        client_id: clientId,
        code,
        grant_type: 'authorization_code',
        redirect_uri: LEGIT_REDIRECT,
      });

      try {
        await proxy.exchangeAuthorizationCode({
          client_id: clientId,
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
      const { clientId, code } = await runToAuthorizationCode(proxy);

      const proxyB = new RedisOAuthProxy(buildConfig(), redis);
      try {
        const results = await Promise.allSettled([
          proxy.exchangeAuthorizationCode({
            client_id: clientId,
            code,
            grant_type: 'authorization_code',
            redirect_uri: LEGIT_REDIRECT,
          }),
          proxyB.exchangeAuthorizationCode({
            client_id: clientId,
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

    it('passes through an upstream id_token (OIDC)', async () => {
      mockUpstreamTokenFetch({ id_token: 'UP_ID_TOKEN' });
      const { clientId, code } = await runToAuthorizationCode(proxy);

      const tokens = await proxy.exchangeAuthorizationCode({
        client_id: clientId,
        code,
        grant_type: 'authorization_code',
        redirect_uri: LEGIT_REDIRECT,
      });

      expect(tokens.id_token).to.equal('UP_ID_TOKEN');
    });

    it('rejects redeeming a code under a different registered client', async () => {
      // Auth-code-injection defense: a code minted for client A must not be
      // redeemable by a different (also registered) client B.
      mockUpstreamTokenFetch();
      const { clientId: clientA, code } = await runToAuthorizationCode(proxy);
      const clientB = await dcr(proxy, ['https://client.example.com/b']);
      expect(clientB).to.not.equal(clientA);

      try {
        await proxy.exchangeAuthorizationCode({
          client_id: clientB,
          code,
          grant_type: 'authorization_code',
          redirect_uri: LEGIT_REDIRECT,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_client');
      }
    });

    it('PKCE happy path validates the verifier across instances', async () => {
      const { createHash } = await import('node:crypto');
      const verifier = 'test-code-verifier-abc123';
      const challenge = createHash('sha256')
        .update(verifier)
        .digest('base64url');

      mockUpstreamTokenFetch();
      // Mint on instance A, redeem on instance B — PKCE is validated inline,
      // with no dependency on the parent's process-local Map.
      const proxyA = new RedisOAuthProxy(buildConfig(), redis);
      const { clientId, code } = await mintPkceCode(proxyA, challenge);
      proxyA.destroy();

      const proxyB = new RedisOAuthProxy(buildConfig(), redis);
      try {
        const tokens = await proxyB.exchangeAuthorizationCode({
          client_id: clientId,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: LEGIT_REDIRECT,
        });
        expect(tokens.access_token).to.equal('UP_ACCESS_TOKEN');
      } finally {
        proxyB.destroy();
      }
    });

    it('PKCE rejects a wrong code_verifier with invalid_grant', async () => {
      const { createHash } = await import('node:crypto');
      const challenge = createHash('sha256')
        .update('the-real-verifier')
        .digest('base64url');

      mockUpstreamTokenFetch();
      const { clientId, code } = await mintPkceCode(proxy, challenge);

      try {
        await proxy.exchangeAuthorizationCode({
          client_id: clientId,
          code,
          code_verifier: 'the-WRONG-verifier',
          grant_type: 'authorization_code',
          redirect_uri: LEGIT_REDIRECT,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_grant');
      }
    });

    it('PKCE rejects a missing code_verifier with invalid_request', async () => {
      const { createHash } = await import('node:crypto');
      const challenge = createHash('sha256')
        .update('the-real-verifier')
        .digest('base64url');

      mockUpstreamTokenFetch();
      const { clientId, code } = await mintPkceCode(proxy, challenge);

      try {
        await proxy.exchangeAuthorizationCode({
          client_id: clientId,
          code,
          grant_type: 'authorization_code',
          redirect_uri: LEGIT_REDIRECT,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_request');
      }
    });

    it('PKCE plain method happy path (challenge equals verifier)', async () => {
      mockUpstreamTokenFetch();
      // For the "plain" method the challenge is the verifier verbatim.
      const verifier = 'plain-code-verifier-value';
      const { clientId, code } = await mintPkceCode(proxy, verifier, 'plain');

      const tokens = await proxy.exchangeAuthorizationCode({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: LEGIT_REDIRECT,
      });
      expect(tokens.access_token).to.equal('UP_ACCESS_TOKEN');
    });

    it('PKCE plain method rejects a wrong code_verifier with invalid_grant', async () => {
      mockUpstreamTokenFetch();
      const { clientId, code } = await mintPkceCode(
        proxy,
        'the-real-plain-verifier',
        'plain',
      );

      try {
        await proxy.exchangeAuthorizationCode({
          client_id: clientId,
          code,
          code_verifier: 'the-WRONG-plain-verifier',
          grant_type: 'authorization_code',
          redirect_uri: LEGIT_REDIRECT,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_grant');
      }
    });
  });

  describe('read path fails closed on Redis error', () => {
    it('authorize rejects (does not fail open) when the client lookup errors', async () => {
      const clientId = await dcr(proxy);
      // authorize reads the client's redirect_uris via GET; a Redis failure
      // must propagate (fail closed), not be treated as "no client".
      sinon.stub(redis, 'get').rejects(new Error('redis unreachable'));

      try {
        await proxy.authorize(baseAuthorizeParams({ client_id: clientId }));
        expect.fail('must not treat a Redis error as a registered client');
      } catch (err) {
        expect((err as Error).message).to.equal('redis unreachable');
      }
    });

    it('exchangeAuthorizationCode rejects when the client lookup errors', async () => {
      const clientId = await dcr(proxy);
      sinon.stub(redis, 'exists').rejects(new Error('redis unreachable'));

      try {
        await proxy.exchangeAuthorizationCode({
          client_id: clientId,
          code: 'anything',
          grant_type: 'authorization_code',
          redirect_uri: LEGIT_REDIRECT,
        });
        expect.fail('must not treat a Redis error as a registered client');
      } catch (err) {
        expect((err as Error).message).to.equal('redis unreachable');
      }
    });
  });

  describe('registerClient Redis failure rollback', () => {
    it('does not leave any Redis state when the mirror write fails', async () => {
      const setStub = sinon.stub(redis, 'set').rejects(new Error('redis down'));

      try {
        await proxy.registerClient({ redirect_uris: [LEGIT_REDIRECT] });
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as Error).message).to.equal('redis down');
      }
      setStub.restore();

      // Nothing registered → authorize rejects an unknown client.
      try {
        await proxy.authorize(
          baseAuthorizeParams({ client_id: 'never-registered' }),
        );
        expect.fail('authorize should have rejected the unknown client');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_client');
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
        await proxy.authorize(
          baseAuthorizeParams({ client_id: 'never-registered' }),
        );
        expect.fail('authorize should have rejected the unknown client');
      } catch (err) {
        expect(err).to.be.instanceOf(OAuthProxyError);
        expect((err as OAuthProxyError).code).to.equal('invalid_client');
      }
    });

    it('preserves pre-existing registrations when a later overlapping DCR fails', async () => {
      // Two different DCR calls happen to share a redirect_uri (rare but
      // possible: same client re-registering, or two clients with colliding
      // localhost ports). The first succeeds; the second fails its Redis
      // mirror. Rollback must NOT remove the URI that the first call
      // already legitimately registered.
      const clientId = await dcr(proxy);

      // Verify initial registration is honored end-to-end
      const authOk = await proxy.authorize(
        baseAuthorizeParams({ client_id: clientId }),
      );
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
      expect(await redis.exists(`mcp:oauth:client:${LEGIT_REDIRECT}`)).to.equal(
        1,
      );
      const authStillOk = await proxy.authorize(
        baseAuthorizeParams({ client_id: clientId }),
      );
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
      const clientId = await dcr(proxyA);
      const authResponse = await proxyA.authorize(
        baseAuthorizeParams({ client_id: clientId }),
      );
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
      const clientId = await dcr(proxy);
      mockUpstreamTokenFetch();

      const authResponse = await proxy.authorize(
        baseAuthorizeParams({ client_id: clientId }),
      );
      const upstreamUrl = new URL(authResponse.headers.get('Location')!);
      const transactionId = upstreamUrl.searchParams.get('state')!;

      const cbReq = new Request(
        `http://localhost:4200/oauth/callback?code=UP_CODE&state=${encodeURIComponent(transactionId)}`,
      );
      const cbResp = await proxy.handleCallback(cbReq);

      expect(cbResp.status).to.equal(302);
      const finalLocation = new URL(cbResp.headers.get('Location')!);
      expect(finalLocation.origin + finalLocation.pathname).to.equal(
        LEGIT_REDIRECT,
      );
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
