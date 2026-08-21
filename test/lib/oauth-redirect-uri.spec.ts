import { expect } from 'chai';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import {
  OAuthProxy,
  OAuthProxyError,
  type OAuthProxyConfig,
} from 'fastmcp/auth';
import { getConfig } from '../../src/config.js';
import {
  BrowserlessOAuthProxy,
  isAllowedOAuthRedirectUri,
} from '../../src/lib/oauth-redirect-uri.js';
import { RedisTokenStorage } from '../../src/lib/redis-token-storage.js';

const EXACT_CALLBACKS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'https://api.devin.ai/mcp/oauth/callback',
  'https://api.beta.devin.ai/mcp/oauth/callback',
  'https://api.itsdev.in/mcp/oauth/callback',
  'https://www.make.com/oauth/cb/mcp',
  'https://us1.make.celonis.com/oauth/cb/mcp',
  'https://eu1.make.celonis.com/oauth/cb/mcp',
];

const WILDCARD_CALLBACKS = [
  'http://localhost:31337/callback',
  'http://127.0.0.1:4567/callback',
  'https://chatgpt.com/connector/oauth/browserless',
];

const LOOKALIKE_CALLBACKS = [
  'https://apixdevin.ai/mcp/oauth/callback',
  'https://api.betaxdevin.ai/mcp/oauth/callback',
  'https://wwwxmake.com/oauth/cb/mcp',
  'https://us1.makexcelonis.com/oauth/cb/mcp',
  'https://eu1.makexcelonis.com/oauth/cb/mcp',
];

const LOOPBACK_CONFUSION_CALLBACKS = [
  'http://localhost.evil.example:31337/callback',
  'http://127.0.0.1.evil.example:31337/callback',
  'http://localhost:31337@evil.example/callback',
  'http://user@localhost:31337/callback',
  'http://user:password@127.0.0.1:31337/callback',
];

function buildConfig(
  overrides: Partial<OAuthProxyConfig> = {},
): OAuthProxyConfig {
  return {
    allowedRedirectUriPatterns: getConfig().oauthAllowedRedirectUriPatterns,
    baseUrl: 'http://127.0.0.1:18081',
    consentRequired: false,
    enableTokenSwap: false,
    scopes: ['email'],
    upstreamAuthorizationEndpoint: 'http://127.0.0.1:9/oauth/authorize',
    upstreamClientId: 'upstream-client-id',
    upstreamClientSecret: 'upstream-client-secret',
    upstreamTokenEndpoint: 'http://127.0.0.1:9/oauth/token',
    ...overrides,
  };
}

describe('Browserless OAuth redirect URI validation', () => {
  const patterns = getConfig().oauthAllowedRedirectUriPatterns;

  for (const redirectUri of [...EXACT_CALLBACKS, ...WILDCARD_CALLBACKS]) {
    it(`accepts configured callback ${redirectUri}`, () => {
      expect(isAllowedOAuthRedirectUri(redirectUri, patterns)).to.equal(true);
    });
  }

  for (const redirectUri of [
    ...LOOKALIKE_CALLBACKS,
    ...LOOPBACK_CONFUSION_CALLBACKS,
    'https://evil.example/callback',
    'not a URI',
  ]) {
    it(`rejects unsafe callback ${redirectUri}`, () => {
      expect(isAllowedOAuthRedirectUri(redirectUri, patterns)).to.equal(false);
    });
  }

  it('treats only * and ? as glob metacharacters', () => {
    expect(
      isAllowedOAuthRedirectUri('https://client.example/cb/a+b', [
        'https://client.example/cb/a+b',
      ]),
    ).to.equal(true);
    expect(
      isAllowedOAuthRedirectUri('https://client.example/cb/axb', [
        'https://client.example/cb/a+b',
      ]),
    ).to.equal(false);
    expect(
      isAllowedOAuthRedirectUri('https://client.example/cb/one/two', [
        'https://client.example/cb/*',
      ]),
    ).to.equal(true);
    expect(
      isAllowedOAuthRedirectUri('https://client.example/cb/x', [
        'https://client.example/cb/?',
      ]),
    ).to.equal(true);
  });

  it('rejects an empty allowlist', () => {
    expect(isAllowedOAuthRedirectUri('http://localhost:3000', [])).to.equal(
      false,
    );
  });

  it('uses safe loopback defaults when patterns are undefined', () => {
    expect(
      isAllowedOAuthRedirectUri('http://localhost:3000/callback', undefined),
    ).to.equal(true);
    expect(
      isAllowedOAuthRedirectUri(
        'http://localhost.evil.example:3000/callback',
        undefined,
      ),
    ).to.equal(false);
  });

  it('rejects lookalikes through the public DCR seam', async () => {
    const proxy = new BrowserlessOAuthProxy(buildConfig());
    try {
      for (const redirectUri of LOOKALIKE_CALLBACKS) {
        try {
          await proxy.registerClient({ redirect_uris: [redirectUri] });
          expect.fail(`accepted ${redirectUri}`);
        } catch (error) {
          expect(error).to.be.instanceOf(OAuthProxyError);
          expect((error as OAuthProxyError).code).to.equal(
            'invalid_redirect_uri',
          );
        }
      }
    } finally {
      proxy.destroy();
    }
  });

  it('revalidates a vulnerable pre-existing registration at authorize time', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const storage = new RedisTokenStorage(redis);
    const vulnerable = new OAuthProxy({
      ...buildConfig({
        allowedRedirectUriPatterns: ['https://api.devin.ai/mcp/oauth/callback'],
      }),
      encryptionKey: false,
      tokenStorage: storage,
    });
    const hardened = new BrowserlessOAuthProxy({
      ...buildConfig(),
      encryptionKey: false,
      tokenStorage: storage,
    });

    try {
      const registration = await vulnerable.registerClient({
        redirect_uris: ['https://apixdevin.ai/mcp/oauth/callback'],
      });

      try {
        await hardened.authorize({
          client_id: registration.client_id,
          redirect_uri: 'https://apixdevin.ai/mcp/oauth/callback',
          response_type: 'code',
          state: 'client-state',
        });
        expect.fail('accepted a vulnerable persisted registration');
      } catch (error) {
        expect(error).to.be.instanceOf(OAuthProxyError);
        expect((error as OAuthProxyError).code).to.equal('invalid_request');
      }
    } finally {
      vulnerable.destroy();
      hardened.destroy();
      await redis.quit();
    }
  });
});
