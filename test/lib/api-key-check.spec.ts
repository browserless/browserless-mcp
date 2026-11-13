import { expect } from 'chai';
import sinon from 'sinon';
import {
  assertKnownApiKey,
  clearApiKeyCheckCache,
  UnknownApiKeyError,
} from '../../src/lib/api-key-check.js';

const API = 'https://api.example.com';
const UNKNOWN_BODY =
  'Invalid API key. Please check your API key and try again. (requestId: test)';

const outcome = async (apiUrl: string, key: string): Promise<unknown> => {
  try {
    await assertKnownApiKey(apiUrl, key);
    return 'known';
  } catch (error) {
    return error;
  }
};

describe('assertKnownApiKey', () => {
  let fetch: sinon.SinonStub;

  beforeEach(() => {
    clearApiKeyCheckCache();
    fetch = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
    clearApiKeyCheckCache();
  });

  const answer = (body: string | null, status: number) =>
    fetch.callsFake(async () => new Response(body, { status }));

  for (const [label, body, status, expected, cached] of [
    ['204', null, 204, 'known', true],
    ['200', 'ok', 200, 'known', true],
    ['401 unknown-key wording', UNKNOWN_BODY, 401, 'unknown', true],
    [
      '401 unknown-key wording after whitespace',
      '\n ' + UNKNOWN_BODY,
      401,
      'unknown',
      true,
    ],
    [
      '401 out of credits',
      'Your account has run out of credits, please upgrade your plan (requestId: x)',
      401,
      'known',
      true,
    ],
    [
      '401 spend cap',
      'Spend cap reached for this account. (requestId: x)',
      401,
      'known',
      true,
    ],
    [
      '401 load balancer HTML',
      '<html><head><title>401 Authorization Required</title></head></html>',
      401,
      'known',
      true,
    ],
    [
      '401 wording not at the start',
      'Error: Invalid API key',
      401,
      'known',
      true,
    ],
    ['403', UNKNOWN_BODY, 403, 'known', false],
    ['429', UNKNOWN_BODY, 429, 'known', false],
    ['500', UNKNOWN_BODY, 500, 'known', false],
    ['503', '', 503, 'known', false],
  ] as const) {
    it(`classifies ${label} as ${expected}${cached ? ' and caches it' : ' without caching'}`, async () => {
      answer(body, status);
      const first = await outcome(API, 'key-' + status);
      const second = await outcome(API, 'key-' + status);
      for (const result of [first, second]) {
        if (expected === 'known') expect(result).to.equal('known');
        else expect(result).to.be.instanceOf(UnknownApiKeyError);
      }
      expect(fetch.callCount).to.equal(cached ? 1 : 2);
    });
  }

  it('fails open on a redirect after exactly one request, without forwarding the key', async () => {
    fetch.callsFake(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example.net/active' },
        }),
    );
    expect(await outcome(API, 'redirected-key')).to.equal('known');
    expect(fetch.callCount).to.equal(1);
    expect(fetch.firstCall.args[1].redirect).to.equal('manual');
    expect(await outcome(API, 'redirected-key')).to.equal('known');
    expect(fetch.callCount).to.equal(2);
  });

  it('fails open without caching on network errors and timeouts', async () => {
    fetch.onFirstCall().rejects(new TypeError('fetch failed'));
    fetch
      .onSecondCall()
      .rejects(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await outcome(API, 'flaky-key')).to.equal('known');
    expect(await outcome(API, 'flaky-key')).to.equal('known');
    expect(fetch.callCount).to.equal(2);
  });

  it('fails open when the 401 body cannot be read', async () => {
    fetch.resolves({
      status: 401,
      text: () => Promise.reject(new Error('socket closed')),
    } as unknown as Response);
    expect(await outcome(API, 'broken-body')).to.equal('known');
    expect(await outcome(API, 'broken-body')).to.equal('known');
    expect(fetch.callCount).to.equal(2);
  });

  it('sends the key only as a Bearer header to the trimmed /active URL, with a timeout', async () => {
    answer(null, 204);
    await assertKnownApiKey(API + '//', 'header-only-key');
    const [url, init] = fetch.firstCall.args;
    expect(url).to.equal(API + '/active');
    expect(String(url)).not.to.include('header-only-key');
    expect(new URL(url).searchParams.has('token')).to.equal(false);
    expect(new Headers(init.headers).get('authorization')).to.equal(
      'Bearer header-only-key',
    );
    expect(init.redirect).to.equal('manual');
    expect(init.signal).to.be.instanceOf(AbortSignal);
  });

  it('checks the same key separately for each API URL', async () => {
    answer(null, 204);
    await assertKnownApiKey(API, 'shared-key');
    await assertKnownApiKey(
      'https://production-lon.browserless.io',
      'shared-key',
    );
    await assertKnownApiKey(API, 'shared-key');
    expect(fetch.callCount).to.equal(2);
    expect(fetch.secondCall.args[0]).to.equal(
      'https://production-lon.browserless.io/active',
    );
  });

  it('never includes the key in the refusal', async () => {
    answer(UNKNOWN_BODY, 401);
    const key = 'secret-junk-key-12345';
    const error = (await outcome(API, key)) as UnknownApiKeyError;
    expect(error).to.be.instanceOf(UnknownApiKeyError);
    expect(error.name).to.equal('UnknownApiKeyError');
    expect(error.message).to.equal(
      'Invalid Browserless API key. Check the key and try again.',
    );
    expect(error.message).not.to.include(key);
    expect(String(error.stack)).not.to.include(key);
  });

  it('expires unknown answers after 30 s and known answers after 5 min', async () => {
    const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    fetch.callsFake(
      async (_url, init) =>
        new Response(
          new Headers(init.headers).get('authorization') === 'Bearer junk'
            ? UNKNOWN_BODY
            : null,
          {
            status:
              new Headers(init.headers).get('authorization') === 'Bearer junk'
                ? 401
                : 204,
          },
        ),
    );
    await outcome(API, 'junk');
    await outcome(API, 'good');
    expect(fetch.callCount).to.equal(2);

    clock.tick(29_000);
    await outcome(API, 'junk');
    expect(fetch.callCount).to.equal(2);
    clock.tick(2_000);
    expect(await outcome(API, 'junk')).to.be.instanceOf(UnknownApiKeyError);
    expect(fetch.callCount).to.equal(3);

    await outcome(API, 'good');
    expect(fetch.callCount).to.equal(3);
    clock.tick(5 * 60_000 - 31_000 + 1_000);
    expect(await outcome(API, 'good')).to.equal('known');
    expect(fetch.callCount).to.equal(4);
  });

  it('stops caching new answers once 10,000 entries are held', async () => {
    answer(null, 204);
    await assertKnownApiKey(API, 'early-key');
    for (let i = 0; i < 9_999; i++) await assertKnownApiKey(API, 'fill-' + i);
    expect(fetch.callCount).to.equal(10_000);

    await assertKnownApiKey(API, 'late-key');
    await assertKnownApiKey(API, 'late-key');
    expect(fetch.callCount).to.equal(10_002);

    await assertKnownApiKey(API, 'early-key');
    expect(fetch.callCount).to.equal(10_002);
  });
});
