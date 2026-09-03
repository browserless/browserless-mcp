import { expect } from 'chai';
import sinon from 'sinon';
import {
  buildAgentWsUrl,
  getOrCreateSession,
  getSessionKey,
  isRetryableUpgradeError,
  PersonaConflictError,
  ProfileNotFoundError,
  proxyFingerprint,
  sessionHandle,
  dropMcpSession,
  UpgradeError,
} from '../../src/lib/agent-client.js';
import type { ProxyOptions } from '../../src/@types/types.js';
import {
  makeAcceptingServer,
  makeRejectingServer,
  makeStallingServer,
} from '../helpers/upgrade-server.js';

describe('agent-client buildAgentWsUrl', () => {
  // A base carrying a query used to concatenate into path `/` — the raw CDP
  // socket — so every agent method came back as -32601 "wasn't found".
  it('ignores a query string on the configured api url', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000?token=leaked', 'tok'),
    );

    expect(url.pathname).to.equal('/chromium/agent');
    expect(url.searchParams.get('token')).to.equal('tok');
    expect(url.toString()).to.not.include('leaked');
  });

  it('keeps a subpath prefix on the configured api url', () => {
    const url = new URL(buildAgentWsUrl('http://host/browserless/', 'tok'));

    expect(url.pathname).to.equal('/browserless/chromium/agent');
  });

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

  it('sets proxy=datacenter when requested', () => {
    const url = new URL(
      buildAgentWsUrl('http://localhost:3000', 'tok', {
        proxy: 'datacenter',
        proxyCountry: 'us',
      }),
    );
    expect(url.searchParams.get('proxy')).to.equal('datacenter');
    expect(url.searchParams.get('proxyCountry')).to.equal('us');
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

  it('preserves explicit rotating proxy behavior for a persona session', () => {
    const url = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        { proxy: 'datacenter', proxySticky: false },
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        { emulationOs: 'windows' },
      ),
    );
    expect(url.searchParams.get('proxySticky')).to.equal('false');
  });

  it('preserves explicit rotating proxy behavior for the shipped OS alias', () => {
    const url = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        { proxy: 'datacenter', proxySticky: false },
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        'windows',
      ),
    );
    expect(url.searchParams.get('proxySticky')).to.equal('false');
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

  it('omits integrationId when not set', () => {
    const url = new URL(buildAgentWsUrl('http://localhost:3000', 'tok'));
    expect(url.searchParams.has('integrationId')).to.equal(false);
    expect(url.searchParams.has('allowedDomains')).to.equal(false);
  });

  it('appends integrationId and JSON-encodes allowedDomains', () => {
    const url = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        undefined,
        undefined,
        undefined,
        false,
        'op_int_abc',
        ['https://gymshark.com', 'https://flixbus.co.uk'],
      ),
    );
    expect(url.searchParams.get('integrationId')).to.equal('op_int_abc');
    expect(
      JSON.parse(url.searchParams.get('allowedDomains') as string),
    ).to.deep.equal(['https://gymshark.com', 'https://flixbus.co.uk']);
  });

  it('appends integrationId without allowedDomains when none given', () => {
    const url = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        undefined,
        undefined,
        undefined,
        false,
        'op_int_abc',
      ),
    );
    expect(url.searchParams.get('integrationId')).to.equal('op_int_abc');
    expect(url.searchParams.has('allowedDomains')).to.equal(false);
  });

  it('drops integrationId on the compliant surface', () => {
    const url = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        undefined,
        undefined,
        undefined,
        true,
        'op_int_abc',
        ['https://gymshark.com'],
      ),
    );
    expect(url.searchParams.has('integrationId')).to.equal(false);
    expect(url.searchParams.has('allowedDomains')).to.equal(false);
  });

  it('forwards persona options only on the full surface', () => {
    const persona = {
      emulationOs: 'windows' as const,
      emulatedDevice: 'pixel-8',
      screen: '1920x1080',
      deviceScaleFactor: 1.25 as const,
      deviceSlot: 3,
    };
    const full = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        persona,
      ),
    );
    expect(Object.fromEntries(full.searchParams)).to.include({
      emulationOs: 'windows',
      emulatedDevice: 'pixel-8',
      screen: '1920x1080',
      deviceScaleFactor: '1.25',
      deviceSlot: '3',
    });

    const compliant = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        persona,
      ),
    );
    for (const field of Object.keys(persona)) {
      expect(compliant.searchParams.has(field), field).to.equal(false);
    }
  });

  it('rejects conflicting OS aliases before serializing the URL', () => {
    expect(() =>
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        'macos',
        undefined,
        { emulationOs: 'windows' },
      ),
    ).to.throw(PersonaConflictError, /os.*emulationOs/i);
  });

  it('rejects redefining persona while attaching an existing browser', () => {
    expect(() =>
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        undefined,
        undefined,
        'sess-123',
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        { emulationOs: 'windows' },
      ),
    ).to.throw(/cannot redefine an attached browser/i);
  });

  it('skips integrationId when attaching to an existing session', () => {
    const url = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        undefined,
        undefined,
        'sess-123',
        false,
        'op_int_abc',
        ['https://gymshark.com'],
      ),
    );
    expect(url.searchParams.get('sessionId')).to.equal('sess-123');
    expect(url.searchParams.has('integrationId')).to.equal(false);
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

  it('attaches to a creation session by id and omits proxy/profile', () => {
    const url = new URL(
      buildAgentWsUrl(
        'http://localhost:3000',
        'tok',
        { proxy: 'residential', proxyCountry: 'us' },
        'my-login',
        'sess-abc123',
      ),
    );
    expect(url.searchParams.get('sessionId')).to.equal('sess-abc123');
    expect(url.searchParams.get('token')).to.equal('tok');
    // A creation session owns its own proxy/profile from POST /profile.
    expect(url.searchParams.has('proxy')).to.equal(false);
    expect(url.searchParams.has('profile')).to.equal(false);
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
  it('does not retry on 400/401/403/404/429', () => {
    // 429 is non-retryable: a retry opens another session and stacks more
    // lingering sessions against the same concurrency limit.
    for (const status of [400, 401, 403, 404, 429]) {
      expect(
        isRetryableUpgradeError(new UpgradeError(status, 'msg', 'body')),
        `status=${status}`,
      ).to.equal(false);
    }
  });

  it('retries on 5xx (transient)', () => {
    for (const status of [500, 502, 503]) {
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

  it('does not retry persona conflicts that would destroy the live session', () => {
    expect(isRetryableUpgradeError(new PersonaConflictError())).to.equal(false);
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
    const err = await expectUpgradeReject(429, SERVER_BODIES.concurrencyLimit, {
      mcpSessionId: 'mcp-429',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).statusCode).to.equal(429);
    expect((err as UpgradeError).body).to.equal(SERVER_BODIES.concurrencyLimit);
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
    expect((err as UpgradeError).body.length).to.equal(
      64 * 1024 - WIRE_OVERHEAD,
    );
  });

  it('truncates a body one byte over the cap', async () => {
    const justOver = 'x'.repeat(64 * 1024 - WIRE_OVERHEAD + 1);
    const err = await expectUpgradeReject(500, justOver, {
      mcpSessionId: 'mcp-cap-plus-one',
    });
    expect(err).to.be.instanceOf(UpgradeError);
    expect((err as UpgradeError).body).to.include('truncated');
  });

  it('does not hang when the server sends headers and stalls the body', async () => {
    // Regression: connect() previously cleared the 30s timer before
    // readUpgradeError started, so a server that promises a body
    // (Content-Length) but never sends it would leave the promise pending
    // forever. Fake only setTimeout/clearTimeout so the WS handshake's
    // setImmediate-based scheduling is untouched, and tick the fake clock
    // past the 10s body-read timeout.
    const server = await makeStallingServer(503);
    const clock = sinon.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
    });
    try {
      const errPromise = getOrCreateSession(
        'mcp-stall',
        server.url,
        'tok',
      ).catch((e: unknown) => e);
      // Yield until the unexpected-response handler runs and arms the
      // body-read setTimeout. A few microtask-flushes are enough — the WS
      // handshake itself completes via I/O events, not fake-timer scheduling.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r));
      }
      await clock.tickAsync(11_000);
      const err = await errPromise;
      expect(err).to.be.instanceOf(UpgradeError);
      expect((err as UpgradeError).statusCode).to.equal(503);
      expect((err as UpgradeError).body).to.include('timed out');
    } finally {
      clock.restore();
      await server.close();
    }
  });
});

describe('agent-client bare-call isolation', () => {
  const bare = (sid: string | undefined, url: string) =>
    getOrCreateSession(sid, url, 'tok');
  const echo = (sid: string | undefined, url: string, handle: string) =>
    getOrCreateSession(
      sid,
      url,
      'tok',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      handle,
    );

  // Regression: tasks in one conversation hashed to one key, so every task after
  // the first landed on the same browser AND page, each goto clobbering the others.
  it('gives every bare caller its own browser, sequential or concurrent', async () => {
    const server = await makeAcceptingServer();
    try {
      // Never timing-dependent: a browser idle between commands was reusable too.
      const first = await bare('mcp-parallel', server.url);
      const second = await bare('mcp-parallel', server.url);
      expect(second.ws).to.not.equal(first.ws);
      expect(second.handle).to.not.equal(first.handle);

      // Concurrent bare calls: no shared in-flight creation either.
      const [a, b, c] = await Promise.all([
        bare('mcp-parallel', server.url),
        bare('mcp-parallel', server.url),
        bare('mcp-parallel', server.url),
      ]);
      const sockets = new Set([first.ws, second.ws, a.ws, b.ws, c.ws]);
      expect(sockets.size).to.equal(5);
    } finally {
      await server.close();
    }
  });

  // stdio had no MCP session id, so its key was one process-wide slot — the worst
  // case for parallel workers sharing a server process.
  it('isolates bare callers on stdio, which has no MCP session id', async () => {
    const server = await makeAcceptingServer();
    try {
      const [a, b] = await Promise.all([
        bare(undefined, server.url),
        bare(undefined, server.url),
      ]);
      expect(a.ws).to.not.equal(b.ws);
    } finally {
      await server.close();
    }
  });

  it('returns the same browser whenever its handle is echoed back', async () => {
    const server = await makeAcceptingServer();
    try {
      const opened = await bare('mcp-echo', server.url);
      const resumed = await echo('mcp-echo', server.url, opened.handle);
      expect(resumed.ws).to.equal(opened.ws);

      // Continuity follows the handle, not the MCP session id — remote clients
      // mint a fresh id per turn, and stdio never had one.
      const churned = await echo('mcp-echo-2', server.url, opened.handle);
      expect(churned.ws).to.equal(opened.ws);
      const onStdio = await echo(undefined, server.url, opened.handle);
      expect(onStdio.ws).to.equal(opened.ws);
    } finally {
      await server.close();
    }
  });

  it('retains persona on an echoed handle and rejects a conflicting persona', async () => {
    const server = await makeAcceptingServer();
    try {
      const opened = await getOrCreateSession(
        'mcp-persona',
        server.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { emulationOs: 'windows', screen: '1920x1080' },
      );
      const resumed = await getOrCreateSession(
        'mcp-persona-2',
        server.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        opened.handle,
      );
      expect(resumed.ws).to.equal(opened.ws);
      expect(resumed.persona).to.deep.equal({
        emulationOs: 'windows',
        screen: '1920x1080',
      });

      let thrown: unknown;
      try {
        await getOrCreateSession(
          'mcp-persona-2',
          server.url,
          'tok',
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          opened.handle,
          undefined,
          undefined,
          undefined,
          undefined,
          { emulationOs: 'macos' },
        );
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).to.match(/fixed when.*opens/i);
    } finally {
      await server.close();
    }
  });

  it('keeps a proxy-backed persona when only the handle is repeated', async () => {
    const server = await makeAcceptingServer();
    try {
      const opened = await getOrCreateSession(
        'mcp-proxy-persona',
        server.url,
        'tok',
        { proxy: 'datacenter', proxyCountry: 'us' },
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { emulationOs: 'windows' },
      );
      const resumed = await getOrCreateSession(
        'mcp-proxy-persona-follow-up',
        server.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        opened.handle,
      );

      expect(resumed.ws).to.equal(opened.ws);
      expect(resumed.persona).to.deep.equal({ emulationOs: 'windows' });
    } finally {
      await server.close();
    }
  });

  it('retains persona when a dropped socket is recreated by handle', async () => {
    const server = await makeAcceptingServer();
    try {
      const opened = await getOrCreateSession(
        'mcp-dropped-persona',
        server.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        'dropped-persona-handle',
        undefined,
        undefined,
        undefined,
        undefined,
        { emulationOs: 'windows', screen: '1920x1080' },
      );
      const closed = new Promise<void>((resolve) =>
        opened.ws.once('close', () => resolve()),
      );
      opened.ws.terminate();
      await closed;

      const resumed = await getOrCreateSession(
        'mcp-dropped-persona-2',
        server.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        'dropped-persona-handle',
      );

      expect(resumed.ws).to.not.equal(opened.ws);
      expect(resumed.persona).to.deep.equal({
        emulationOs: 'windows',
        screen: '1920x1080',
      });
      const reconnectUrl = new URL(server.upgradeUrls()[1]!, server.url);
      expect(reconnectUrl.searchParams.get('emulationOs')).to.equal('windows');
      expect(reconnectUrl.searchParams.get('screen')).to.equal('1920x1080');
    } finally {
      await server.close();
    }
  });

  it('retains the shipped OS alias when a dropped socket is recreated by handle', async () => {
    const server = await makeAcceptingServer();
    try {
      const opened = await getOrCreateSession(
        'mcp-dropped-os',
        server.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        'dropped-os-handle',
        undefined,
        undefined,
        'windows',
      );
      const closed = new Promise<void>((resolve) =>
        opened.ws.once('close', () => resolve()),
      );
      opened.ws.terminate();
      await closed;

      const resumed = await getOrCreateSession(
        'mcp-dropped-os-2',
        server.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        'dropped-os-handle',
      );

      expect(resumed.persona).to.deep.equal({ emulationOs: 'windows' });
      const reconnectUrl = new URL(server.upgradeUrls()[1]!, server.url);
      expect(reconnectUrl.searchParams.get('emulationOs')).to.equal('windows');
    } finally {
      await server.close();
    }
  });

  it('rejects a conflicting persona while sharing an in-flight creation', async () => {
    const server = await makeAcceptingServer(25);
    try {
      const open = (mcpSessionId: string, emulationOs: 'windows' | 'macos') =>
        getOrCreateSession(
          mcpSessionId,
          server.url,
          'tok',
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          'shared-pending-persona',
          undefined,
          undefined,
          undefined,
          undefined,
          { emulationOs },
        );

      const windows = open('mcp-pending-a', 'windows');
      const macos = open('mcp-pending-b', 'macos').catch(
        (error: unknown) => error,
      );
      expect((await windows).persona).to.deep.equal({
        emulationOs: 'windows',
      });
      expect(await macos).to.be.instanceOf(PersonaConflictError);
    } finally {
      await server.close();
    }
  });

  it('rejects persona before allocating a profile-creation session', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
      new Response(JSON.stringify({ id: 'created-profile' }), {
        status: 200,
      }),
    );
    try {
      let thrown: unknown;
      try {
        await getOrCreateSession(
          'mcp-create-profile-persona',
          'http://127.0.0.1:1',
          'tok',
          undefined,
          undefined,
          { name: 'demo' },
          undefined,
          false,
          undefined,
          'profile-persona-handle',
          undefined,
          undefined,
          undefined,
          undefined,
          { emulationOs: 'windows', screen: '1920x1080' },
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).to.be.instanceOf(PersonaConflictError);
      expect(fetchStub.called).to.equal(false);
    } finally {
      fetchStub.restore();
    }
  });

  it('keeps an echoed handle scoped to its own token', async () => {
    const server = await makeAcceptingServer();
    try {
      const mine = await bare('mcp-tok', server.url);
      const theirs = await getOrCreateSession(
        'mcp-tok',
        server.url,
        'other-token',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mine.handle,
      );
      expect(theirs.ws).to.not.equal(mine.ws);
    } finally {
      await server.close();
    }
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

      // The handle carries the session, not the profile name: a bare re-ask would
      // open a third browser (see bare-call isolation).
      const sessAAgain = await getOrCreateSession(
        sidA,
        server.url,
        'tok',
        undefined,
        'profile-a',
        undefined,
        undefined,
        undefined,
        undefined,
        sessA.handle,
      );
      expect(sessAAgain.ws).to.equal(sessA.ws);
    } finally {
      await server.close();
    }
  });
});

describe('agent-client session handle', () => {
  const key = (
    handle: string,
    token = 'tok',
    sid: string | undefined = 'mcp-1',
  ) =>
    getSessionKey(
      sid,
      token,
      undefined,
      undefined,
      undefined,
      undefined,
      handle,
    );

  it('keys the same handle to one browser regardless of the MCP session id', () => {
    expect(key('handle-1', 'tok', 'mcp-1')).to.equal(
      key('handle-1', 'tok', 'mcp-2'),
    );
  });

  it('scopes an echoed handle to its token so it cannot cross accounts', () => {
    expect(key('handle-1', 'tok-a')).to.not.equal(key('handle-1', 'tok-b'));
  });

  it('still separates conversations that echo different handles', () => {
    expect(key('handle-1')).to.not.equal(key('handle-2'));
  });

  it('falls back to the MCP session id, then to the token, when nothing is echoed', () => {
    expect(sessionHandle('mcp-1', 'tok')).to.equal('mcp-1');
    expect(sessionHandle(undefined, 'tok')).to.match(/^stdio:/);
  });

  it('reuses the live browser across an MCP session change when the handle is echoed', async () => {
    const server = await makeAcceptingServer();
    try {
      const first = await getOrCreateSession('mcp-1', server.url, 'tok');
      // The handle is minted per task, not derived from the MCP session id —
      // that id is shared by every concurrent task in the conversation.
      expect(first.handle).to.not.equal('mcp-1');

      // The client re-initialized: new MCP session id, same conversation.
      const churned = await getOrCreateSession(
        'mcp-2',
        server.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        first.handle,
      );
      expect(churned.ws).to.equal(first.ws);

      // Same churned session id, but the handle was dropped — a new browser.
      const dropped = await getOrCreateSession('mcp-2', server.url, 'tok');
      expect(dropped.ws).to.not.equal(first.ws);
    } finally {
      await server.close();
    }
  });
});

describe('agent-client integration binding key', () => {
  const key = (integrationId?: string, allowedDomains?: string[]) =>
    getSessionKey(
      'mcp-1',
      'tok',
      undefined,
      undefined,
      undefined,
      undefined,
      'handle-1',
      integrationId,
      allowedDomains,
    );

  it('separates the same integration under different domain scopes', () => {
    expect(key('op_int_a', ['https://a.com'])).to.not.equal(
      key('op_int_a', ['https://b.com']),
    );
  });

  it('separates a scoped binding from an unscoped one', () => {
    expect(key('op_int_a', ['https://a.com'])).to.not.equal(key('op_int_a'));
  });

  it('treats domain order as the same scope', () => {
    expect(key('op_int_a', ['https://a.com', 'https://b.com'])).to.equal(
      key('op_int_a', ['https://b.com', 'https://a.com']),
    );
  });

  it('ignores allowedDomains with no integrationId (it never reaches the wire)', () => {
    expect(key(undefined, ['https://a.com'])).to.equal(key(undefined));
  });
});

describe('agent-client mcp-session churn', () => {
  const bare = (sid: string, url: string) =>
    getOrCreateSession(sid, url, 'tok');

  // "Orphan adoption" let a bare call recover a browser whose MCP session went
  // quiet — the same guess that collided tasks. The handle is now the only way back.
  it("does not hand a quiet session's browser to the next bare caller", async () => {
    const server = await makeAcceptingServer();
    try {
      const first = await bare('mcp-a', server.url);
      dropMcpSession('mcp-a');

      const next = await bare('mcp-b', server.url);
      expect(next.ws).to.not.equal(first.ws);

      // The original browser is still reachable — by its handle.
      const resumed = await getOrCreateSession(
        'mcp-b',
        server.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        first.handle,
      );
      expect(resumed.ws).to.equal(first.ws);
    } finally {
      await server.close();
    }
  });

  it("never lets a bare caller reach another conversation's live browser", async () => {
    const server = await makeAcceptingServer();
    try {
      const live = await bare('mcp-live', server.url);
      const other = await bare('mcp-new', server.url);
      expect(other.ws).to.not.equal(live.ws);
    } finally {
      await server.close();
    }
  });
});

describe('agent-client createProfile with os and humanlike', () => {
  let fetchStub: sinon.SinonStub;

  afterEach(() => {
    sinon.restore();
  });

  it('forwards non-default os and humanlike as query params to POST /profile', async () => {
    const server = await makeAcceptingServer();
    try {
      fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(JSON.stringify({ id: 'sess-test-123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await getOrCreateSession(
        'mcp-create-profile',
        server.url,
        'tok',
        undefined, // proxy
        undefined, // profile (string)
        { name: 'my-profile' }, // createProfile
        undefined, // attachSessionId
        false, // compliant
        undefined, // source
        undefined, // echoedSessionId
        undefined, // integrationId
        undefined, // allowedDomains
        'macos', // os
        true, // humanlike
      );

      expect(fetchStub.calledOnce).to.be.true;
      const calledUrl = new URL(fetchStub.firstCall.args[0] as string);
      expect(calledUrl.pathname).to.equal('/profile');
      expect(calledUrl.searchParams.get('emulationOs')).to.equal('macos');
      expect(calledUrl.searchParams.get('humanlike')).to.equal('true');
    } finally {
      await server.close();
    }
  });

  it('omits emulationOs and humanlike from POST /profile when not provided', async () => {
    const server = await makeAcceptingServer();
    try {
      fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(JSON.stringify({ id: 'sess-no-os' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await getOrCreateSession(
        'mcp-create-profile-bare',
        server.url,
        'tok',
        undefined, // proxy
        undefined, // profile (string)
        { name: 'bare-profile' }, // createProfile
      );

      expect(fetchStub.calledOnce).to.be.true;
      const calledUrl = new URL(fetchStub.firstCall.args[0] as string);
      expect(calledUrl.searchParams.has('emulationOs')).to.be.false;
      expect(calledUrl.searchParams.has('humanlike')).to.be.false;
    } finally {
      await server.close();
    }
  });

  it('forwards emulationOs through profile creation like the shipped os alias', async () => {
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
      new Response(JSON.stringify({ id: 'created-profile' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const server = await makeAcceptingServer();
    try {
      await getOrCreateSession(
        'mcp-create-profile-emulation-os',
        server.url,
        'tok',
        undefined,
        undefined,
        { name: 'emulated-profile' },
        undefined,
        false,
        undefined,
        'emulated-profile-handle',
        undefined,
        undefined,
        undefined,
        undefined,
        { emulationOs: 'macos' },
      );

      const calledUrl = new URL(fetchStub.firstCall.args[0] as string);
      expect(calledUrl.searchParams.get('emulationOs')).to.equal('macos');
    } finally {
      fetchStub.restore();
      await server.close();
    }
  });

  it('forwards humanlike=false explicitly when humanlike is false', async () => {
    const server = await makeAcceptingServer();
    try {
      fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(JSON.stringify({ id: 'sess-hl-false' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await getOrCreateSession(
        'mcp-create-profile-hl-false',
        server.url,
        'tok',
        undefined, // proxy
        undefined, // profile (string)
        { name: 'hl-false-profile' }, // createProfile
        undefined, // attachSessionId
        false, // compliant
        undefined, // source
        undefined, // echoedSessionId
        undefined, // integrationId
        undefined, // allowedDomains
        undefined, // os
        false, // humanlike — explicitly disabled
      );

      expect(fetchStub.calledOnce).to.be.true;
      const calledUrl = new URL(fetchStub.firstCall.args[0] as string);
      expect(calledUrl.searchParams.get('humanlike')).to.equal('false');
    } finally {
      await server.close();
    }
  });
});
