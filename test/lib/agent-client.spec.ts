import { expect } from 'chai';
import {
  buildAgentWsUrl,
  getOrCreateSession,
  isRetryableUpgradeError,
  ProfileNotFoundError,
  proxyFingerprint,
  UpgradeError,
} from '../../src/lib/agent-client.js';
import type { ProxyOptions } from '../../src/tools/schemas.js';
import {
  makeAcceptingServer,
  makeRejectingServer,
} from '../helpers/upgrade-server.js';

describe('agent-client buildAgentWsUrl', () => {
  it('uses ws:// for http and only sets token when no proxy options are passed', () => {
    const url = new URL(buildAgentWsUrl('http://localhost:3000', 'tok'));
    expect(url.protocol).to.equal('ws:');
    expect(url.host).to.equal('localhost:3000');
    expect(url.pathname).to.equal('/chromium/agent');
    expect([...url.searchParams.keys()]).to.deep.equal(['token']);
    expect(url.searchParams.get('token')).to.equal('tok');
  });

  it('uses wss:// for https', () => {
    const url = new URL(buildAgentWsUrl('https://mcp.browserless.io', 'tok'));
    expect(url.protocol).to.equal('wss:');
  });

  it('strips a trailing slash from apiUrl so the path is single-slashed', () => {
    const url = new URL(buildAgentWsUrl('http://localhost:3000/', 'tok'));
    expect(url.pathname).to.equal('/chromium/agent');
  });

  it('URL-encodes the token', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'a/b c?d&e=1'),
    );
    expect(url.searchParams.get('token')).to.equal('a/b c?d&e=1');
  });

  it('sets proxy=residential when requested', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', { proxy: 'residential' }),
    );
    expect(url.searchParams.get('proxy')).to.equal('residential');
  });

  it('passes country, sticky, and locale-match flags', () => {
    const proxy: ProxyOptions = {
      proxy: 'residential',
      proxyCountry: 'us',
      proxySticky: true,
      proxyLocaleMatch: true,
    };
    const url = new URL(buildAgentWsUrl('http://localhost:3000', 'tok', proxy));
    expect(url.searchParams.get('proxy')).to.equal('residential');
    expect(url.searchParams.get('proxyCountry')).to.equal('us');
    expect(url.searchParams.get('proxySticky')).to.equal('true');
    expect(url.searchParams.get('proxyLocaleMatch')).to.equal('true');
  });

  it('omits sticky when false (server uses presence-only semantics)', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', {
        proxy: 'residential',
        proxySticky: false,
      }),
    );
    expect(url.searchParams.has('proxySticky')).to.equal(false);
  });

  it('omits locale-match when false (server uses presence-only semantics)', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', {
        proxy: 'residential',
        proxyLocaleMatch: false,
      }),
    );
    expect(url.searchParams.has('proxyLocaleMatch')).to.equal(false);
  });

  it('passes proxyPreset when set', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', {
        proxy: 'residential',
        proxyPreset: 'px_amazon01',
      }),
    );
    expect(url.searchParams.get('proxyPreset')).to.equal('px_amazon01');
  });

  it('swaps the scheme case-insensitively (HTTPS://)', () => {
    const url = new URL(buildAgentWsUrl('HTTPS://host.example.com', 'tok'));
    expect(url.protocol).to.equal('wss:');
  });

  it('round-trips externalProxyServer with credentials', () => {
    const ext = 'http://user:pass@host.example.com:8080';
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', {
        externalProxyServer: ext,
      }),
    );
    expect(url.searchParams.get('externalProxyServer')).to.equal(ext);
  });

  it('passes proxyState and proxyCity when set', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', {
        proxy: 'residential',
        proxyState: 'CA',
        proxyCity: 'Los Angeles',
      }),
    );
    expect(url.searchParams.get('proxyState')).to.equal('CA');
    expect(url.searchParams.get('proxyCity')).to.equal('Los Angeles');
  });

  it('omits profile when not set', () => {
    const url = new URL(buildAgentWsUrl('http://localhost:3000', 'tok'));
    expect(url.searchParams.has('profile')).to.equal(false);
  });

  it('appends profile when set', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', undefined, 'my-login'),
    );
    expect(url.searchParams.get('profile')).to.equal('my-login');
  });

  it('URL-encodes the profile name', () => {
    const url = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        undefined,
        'profile with spaces',
      ),
    );
    expect(url.searchParams.get('profile')).to.equal('profile with spaces');
    expect(url.toString()).to.include('profile=profile+with+spaces');
  });

  it('combines profile and proxy params on the same URL', () => {
    const url = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        { proxy: 'residential', proxyCountry: 'us' },
        'my-login',
      ),
    );
    expect(url.searchParams.get('proxy')).to.equal('residential');
    expect(url.searchParams.get('proxyCountry')).to.equal('us');
    expect(url.searchParams.get('profile')).to.equal('my-login');
  });
});

describe('agent-client proxyFingerprint', () => {
  it('returns empty string for undefined', () => {
    expect(proxyFingerprint(undefined)).to.equal('');
  });

  it('returns empty string for an empty object', () => {
    expect(proxyFingerprint({})).to.equal('');
  });

  it('produces a stable string from the same inputs regardless of key order', () => {
    const a: ProxyOptions = { proxy: 'residential', proxyCountry: 'us' };
    const b: ProxyOptions = { proxyCountry: 'us', proxy: 'residential' };
    expect(proxyFingerprint(a)).to.equal(proxyFingerprint(b));
  });

  it('differs when any field differs', () => {
    const us = proxyFingerprint({ proxy: 'residential', proxyCountry: 'us' });
    const de = proxyFingerprint({ proxy: 'residential', proxyCountry: 'de' });
    expect(us).to.not.equal(de);
  });

  it('differs from no-proxy when only sticky is set', () => {
    expect(proxyFingerprint({ proxySticky: true })).to.not.equal('');
  });

  it('does not include externalProxyServer credentials verbatim', () => {
    const fp = proxyFingerprint({
      externalProxyServer: 'http://user:hunter2@host.example.com:8080',
    });
    expect(fp).to.not.include('hunter2');
    expect(fp).to.not.include('user:');
    expect(fp).to.not.include('host.example.com');
  });

  it('keys distinct externalProxyServer URLs to distinct fingerprints', () => {
    const a = proxyFingerprint({
      externalProxyServer: 'http://u:p@host-a:8080',
    });
    const b = proxyFingerprint({
      externalProxyServer: 'http://u:p@host-b:8080',
    });
    expect(a).to.not.equal(b);
    expect(a).to.not.equal('');
  });

  it('prefixes the proxy segment with NUL so it cannot collide with an mcpSessionId', () => {
    // Session keys are built as `${mcpSessionId}${proxyFingerprint}`. The
    // separator must not appear in either segment, otherwise distinct
    // configs could collide on the same key.
    const fp = proxyFingerprint({ proxy: 'residential' });
    expect(fp.startsWith('\u0000')).to.equal(true);
  });
});

describe('agent-client isRetryableUpgradeError', () => {
  // The retry guard exists so the agent tool doesn't burn a second WS
  // handshake when the server already returned a definitive 4xx.
  it('does not retry on 400/401/403/404', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(
        isRetryableUpgradeError(new UpgradeError(status, 'msg', 'body')),
        `status=${status}`,
      ).to.equal(false);
    }
  });

  it('retries on 5xx and 429 (transient)', () => {
    for (const status of [429, 500, 502, 503]) {
      expect(
        isRetryableUpgradeError(new UpgradeError(status, 'msg', 'body')),
        `status=${status}`,
      ).to.equal(true);
    }
  });

  it('does not retry on ProfileNotFoundError (it is a 404)', () => {
    expect(
      isRetryableUpgradeError(new ProfileNotFoundError('p', 'Not Found', '')),
    ).to.equal(false);
  });

  it('retries on plain errors (network failures, timeouts)', () => {
    expect(isRetryableUpgradeError(new Error('ECONNREFUSED'))).to.equal(true);
  });
});

// Verbatim error bodies the backend emits. Tests reference these constants
// so the strings stay in sync with production wording and a future divergence
// is visible at a single location.
const SERVER_BODIES = {
  profileNotFound: (name: string) => `Profile "${name}" was not found`,
  reconnectWithProfile:
    '?profile= is not supported on /reconnect — the browser is already running with its original auth state',
  unauthorized: 'Bad or missing authentication.',
  concurrencyLimit:
    'Your plan allows 1 concurrent sessions and 0 queued requests, but both limits have been reached. Possible causes: 1) Your plan has reached maximum capacity, 2) Your token may not have access to this version, 3) Your requests are coming too quickly.',
} as const;

// Responses an upstream proxy may inject instead of forwarding a typed body
// from the backend — empty bodies on `ngx.exit(N)`, an HTML default page when
// the backend is unreachable, or a redirect notice on deprecated endpoints.
const PROXY_BODIES = {
  // Approximation — actual bytes vary by nginx build but always HTML.
  nginxDefault: (status: number, title: string) =>
    `<html>\r\n<head><title>${status} ${title}</title></head>\r\n<body>\r\n<center><h1>${status} ${title}</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>`,
  legacyRedirect:
    'This URL is a legacy endpoint, please use https://production-sfo.browserless.io for REST API calls and wss://production-sfo.browserless.io for library and puppeteer usage. See more at https://docs.browserless.io/overview/connection-urlss',
} as const;

// Run `getOrCreateSession` against an upgrade-rejecting server and return
// the thrown error. Encapsulates the server lifecycle so tests focus on the
// assertion. Throws if the call unexpectedly resolves.
const expectUpgradeReject = async (
  status: number,
  body: string,
  opts: {
    mcpSessionId: string;
    proxy?: ProxyOptions;
    profile?: string;
  },
): Promise<unknown> => {
  const server = await makeRejectingServer(status, body);
  try {
    await getOrCreateSession(
      opts.mcpSessionId,
      server.url,
      'tok',
      opts.proxy,
      opts.profile,
    );
    throw new Error(`expected ${status} upgrade rejection`);
  } catch (err) {
    return err;
  } finally {
    await server.close();
  }
};

describe('agent-client connect (upgrade error handling)', () => {
  it('surfaces a 404 with a profile as ProfileNotFoundError', async () => {
    const err = await expectUpgradeReject(
      404,
      SERVER_BODIES.profileNotFound('ghost'),
      // Distinct mcpSessionId per test so session-cache state from a prior
      // test cannot mask a fresh connect attempt.
      { mcpSessionId: 'mcp-404', profile: 'ghost' },
    );
    expect(err).to.be.instanceOf(ProfileNotFoundError);
    expect((err as ProfileNotFoundError).profile).to.equal('ghost');
    // Server body is forwarded verbatim — locks in the contract that the
    // tool layer renders the server's message rather than a wrapper.
    expect((err as Error).message).to.equal(
      SERVER_BODIES.profileNotFound('ghost'),
    );
  });

  it('surfaces a 404 without a profile as a generic UpgradeError', async () => {
    const err = await expectUpgradeReject(404, 'Not Found', {
      mcpSessionId: 'mcp-404-noprofile',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect(err).to.not.be.instanceOf(ProfileNotFoundError);
    expect((err as UpgradeError).statusCode).to.equal(404);
  });

  it('surfaces a 401 with the verbatim server auth body', async () => {
    const err = await expectUpgradeReject(401, SERVER_BODIES.unauthorized, {
      mcpSessionId: 'mcp-401',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).statusCode).to.equal(401);
    expect((err as UpgradeError).body).to.equal(SERVER_BODIES.unauthorized);
  });

  it('surfaces a 400 (?profile= on /reconnect rejection) verbatim', async () => {
    const err = await expectUpgradeReject(
      400,
      SERVER_BODIES.reconnectWithProfile,
      { mcpSessionId: 'mcp-400', profile: 'p' },
    );
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).statusCode).to.equal(400);
    expect((err as UpgradeError).body).to.equal(
      SERVER_BODIES.reconnectWithProfile,
    );
  });

  it('surfaces a 429 with the verbatim concurrency-limit message', async () => {
    const err = await expectUpgradeReject(
      429,
      SERVER_BODIES.concurrencyLimit,
      { mcpSessionId: 'mcp-429' },
    );
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).statusCode).to.equal(429);
    expect((err as UpgradeError).body).to.equal(
      SERVER_BODIES.concurrencyLimit,
    );
  });

  it('handles a proxy-injected empty-body 401 without crashing', async () => {
    const err = await expectUpgradeReject(401, '', {
      mcpSessionId: 'mcp-lb-401',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).statusCode).to.equal(401);
    expect((err as UpgradeError).body).to.equal('');
  });

  it('handles a proxy-injected empty-body 429 without crashing', async () => {
    const err = await expectUpgradeReject(429, '', {
      mcpSessionId: 'mcp-lb-429',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).statusCode).to.equal(429);
    expect((err as UpgradeError).body).to.equal('');
  });

  it('surfaces a legacy-endpoint 403 with the redirect message body', async () => {
    const err = await expectUpgradeReject(403, PROXY_BODIES.legacyRedirect, {
      mcpSessionId: 'mcp-lb-403',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).statusCode).to.equal(403);
    expect((err as UpgradeError).body).to.equal(PROXY_BODIES.legacyRedirect);
  });

  it('preserves an nginx default HTML body verbatim on the typed error', async () => {
    // The typed error holds the body unchanged — formatConnectError is
    // responsible for HTML cleanup at render time.
    const html = PROXY_BODIES.nginxDefault(502, 'Bad Gateway');
    const err = await expectUpgradeReject(502, html, {
      mcpSessionId: 'mcp-lb-502',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).statusCode).to.equal(502);
    expect((err as UpgradeError).body).to.include('<html>');
    expect((err as UpgradeError).body).to.include('nginx');
  });

  it('caps a runaway upgrade body so a misbehaving server cannot OOM us', async () => {
    // 1 MiB of body — well above the 64 KiB internal cap. Confirms we
    // truncate, append the marker, and still surface a typed error rather
    // than buffering the whole payload.
    const huge = 'x'.repeat(1024 * 1024);
    const err = await expectUpgradeReject(500, huge, {
      mcpSessionId: 'mcp-oom',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).statusCode).to.equal(500);
    expect((err as UpgradeError).body).to.include('truncated');
    // The buffered payload is bounded by the cap; the marker adds a small
    // fixed overhead (~35 bytes) — assert against a generous ceiling.
    expect((err as UpgradeError).body.length).to.be.lessThan(64 * 1024 + 128);
  });

  // The cap is enforced on raw wire bytes including the leading CRLF the
  // rejector emits between headers and body. Account for that 2-byte
  // overhead so the boundary cases hit `total == cap` and `total == cap + 1`.
  const WIRE_OVERHEAD = 2;

  it('passes a body sized to the cap through without truncating', async () => {
    const exact = 'x'.repeat(64 * 1024 - WIRE_OVERHEAD);
    const err = await expectUpgradeReject(500, exact, {
      mcpSessionId: 'mcp-cap-exact',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).body).to.not.include('truncated');
    // After trim() strips the leading CRLF artifact, only the body remains.
    expect((err as UpgradeError).body.length).to.equal(64 * 1024 - WIRE_OVERHEAD);
  });

  it('truncates a body one byte over the cap', async () => {
    const justOver = 'x'.repeat(64 * 1024 - WIRE_OVERHEAD + 1);
    const err = await expectUpgradeReject(500, justOver, {
      mcpSessionId: 'mcp-cap-plus-one',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).body).to.include('truncated');
  });
});

describe('agent-client session-cache isolation', () => {
  it('keeps distinct sessions for the same mcpSessionId+token with different profiles', async () => {
    const server = await makeAcceptingServer();
    try {
      const sidA = 'mcp-iso';
      const sessA = await getOrCreateSession(
        sidA,
        server.url,
        'tok',
        undefined,
        'profile-a',
      );
      const sessB = await getOrCreateSession(
        sidA,
        server.url,
        'tok',
        undefined,
        'profile-b',
      );
      // Two distinct WebSockets — a shared cache entry would re-hydrate
      // profile-A state into a profile-B request.
      expect(sessA.ws).to.not.equal(sessB.ws);
      expect(sessA.profile).to.equal('profile-a');
      expect(sessB.profile).to.equal('profile-b');

      // Asking for the same (sid, profile) again returns the cached session.
      const sessAAgain = await getOrCreateSession(
        sidA,
        server.url,
        'tok',
        undefined,
        'profile-a',
      );
      expect(sessAAgain.ws).to.equal(sessA.ws);
    } finally {
      await server.close();
    }
  });
});
