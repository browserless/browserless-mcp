import { expect } from 'chai';
import type { BrowserlessSession } from '../../src/@types/types.js';
import {
  admitSessionRequest,
  assertSessionPrincipal,
  authOutcome,
  sessionNotFoundResponse,
  sessionPrincipal,
  type SessionLike,
} from '../../src/lib/session-binding.js';
import {
  resetSessionReaperForTests,
  trackedSessionCount,
} from '../../src/lib/session-reaper.js';

const key: BrowserlessSession = {
  token: 'abc',
  apiUrl: 'http://127.0.0.1:9',
  authMethod: 'api_key_header',
};
const oauth: BrowserlessSession = {
  ...key,
  authMethod: 'oauth',
  accountId: 'account-one',
  userId: 'user-one',
};
const body =
  '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}';

async function notFound(run: () => void) {
  let error: unknown;
  try {
    run();
  } catch (cause) {
    error = cause;
  }
  expect(error).to.be.instanceOf(Response);
  const response = error as Response;
  expect(response.status).to.equal(404);
  expect(response.statusText).to.equal('Not Found');
  expect(response.headers.get('content-type')).to.equal('application/json');
  expect(await response.text()).to.equal(body);
}

describe('session binding', () => {
  afterEach(() => resetSessionReaperForTests());

  it('admits initialization, the same key through either source, and refreshed OAuth identities', () => {
    assertSessionPrincipal(undefined, key, []);
    for (const auth of [key, { ...key, authMethod: 'api_key_query' as const }])
      assertSessionPrincipal('S', auth, [{ sessionId: 'S', auth: key }]);
    assertSessionPrincipal('S', { ...oauth, token: 'refreshed' }, [
      { sessionId: 'S', auth: oauth },
    ]);
  });

  for (const [name, auth, sessions] of [
    ['unknown session', key, []],
    ['other key', { ...key, token: 'def' }, [{ sessionId: 'S', auth: key }]],
    [
      'other user',
      { ...oauth, userId: 'user-two' },
      [{ sessionId: 'S', auth: oauth }],
    ],
    [
      'other account',
      { ...oauth, accountId: 'account-two' },
      [{ sessionId: 'S', auth: oauth }],
    ],
    ['key instead of OAuth', key, [{ sessionId: 'S', auth: oauth }]],
    ['missing stored auth', key, [{ sessionId: 'S' }]],
    ['other session id', key, [{ sessionId: 'S2', auth: key }]],
  ] as [string, BrowserlessSession, SessionLike[]][]) {
    it(`answers ${name} with the standard not-found response`, async () => {
      await notFound(() => assertSessionPrincipal('S', auth, sessions));
    });
  }

  it('uses a full credential digest and falls back when OAuth ids are incomplete', () => {
    const digest =
      'key:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(sessionPrincipal(key)).to.equal(digest);
    expect(sessionPrincipal(key)).not.to.include(key.token);
    expect(sessionPrincipal({ ...oauth, accountId: '' })).to.equal(digest);
    expect(sessionPrincipal({ ...oauth, userId: '' })).to.equal(digest);
    expect(sessionPrincipal(oauth)).to.equal('user:account-one:user-one');
  });

  it('records activity only after admission', async () => {
    resetSessionReaperForTests();
    await notFound(() => admitSessionRequest('S-new', key, []));
    await notFound(() =>
      admitSessionRequest('S', { ...key, token: 'def' }, [
        { sessionId: 'S', auth: key },
      ]),
    );
    expect(trackedSessionCount()).to.equal(0);
    admitSessionRequest('S', key, [{ sessionId: 'S', auth: key }]);
    expect(trackedSessionCount()).to.equal(1);
  });

  it('classifies not-found separately from authentication rejection', () => {
    expect(authOutcome(sessionNotFoundResponse())).to.equal('session_mismatch');
    expect(authOutcome(new Error('x'))).to.equal('rejected');
    expect(authOutcome(new Response(null, { status: 401 }))).to.equal(
      'rejected',
    );
  });
});
