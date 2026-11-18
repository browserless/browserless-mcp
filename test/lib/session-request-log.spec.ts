import { expect } from 'chai';
import sinon from 'sinon';
import type { IncomingMessage } from 'node:http';
import {
  classifyCursor,
  observeSessionRequest,
  noteMissingStoreContext,
  resetSessionRequestLog,
  type ObservedRequest,
} from '../../src/lib/session-request-log.js';
import { hashToken } from '../../src/lib/utils.js';
import { sessionPrincipal } from '../../src/lib/session-binding.js';

const auth = {
  token: 'synthetic-presenter-key',
  apiUrl: 'http://127.0.0.1:9',
  authMethod: 'api_key_header' as const,
};
const owner = { ...auth, token: 'synthetic-owner-key' };
const uuid = '01234567-89ab-4cde-8123-456789abcdef';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const input = (changes: Partial<ObservedRequest> = {}): ObservedRequest => ({
  request: {
    headers: { 'user-agent': 'test-client/1', 'x-real-ip': ' 192.0.2.3 ' },
    url: '/mcp',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage,
  sessionId: 'session-presenter',
  method: 'GET',
  surface: 'full',
  failed: false,
  auth,
  store: { cursorContext: () => undefined },
  sessions: () => [],
  ...changes,
});

describe('session request observation', () => {
  let fetcher: sinon.SinonStub;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://127.0.0.1:9/v1/logs';
    fetcher = sinon.stub(globalThis, 'fetch').resolves(new Response(null));
    resetSessionRequestLog();
  });
  afterEach(async () => {
    await tick();
    resetSessionRequestLog();
    sinon.restore();
    if (previous === undefined)
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = previous;
  });
  const records = (): Record<string, unknown>[] =>
    fetcher.getCalls().map((call) => {
      const scope = JSON.parse(call.args[1].body).resourceLogs[0].scopeLogs[0];
      const record = scope.logRecords[0];
      return {
        scope: scope.scope.name,
        severity: record.severityNumber,
        ...Object.fromEntries(
          record.attributes.map(
            (a: { key: string; value: Record<string, unknown> }) => [
              a.key,
              Object.values(a.value)[0],
            ],
          ),
        ),
      };
    });

  it('classifies cursor shape and both process-time boundaries', () => {
    const now = Date.now();
    for (const [value, kind] of [
      [undefined, 'none'],
      ['', 'none'],
      ['  ', 'none'],
      [`_GET_stream_${now}_0_abc`, 'standalone'],
      [`${uuid}_${now}_12_`, 'request'],
      [`_GET_stream_${now}_1_`, 'standalone'],
      [` ${uuid}_${now}_0_abc `, 'request'],
      [
        `${uuid}_${Math.floor(performance.timeOrigin) - 1}_0_a`,
        'prior_process',
      ],
      [`_GET_stream_${Math.floor(performance.timeOrigin)}_0_a`, 'standalone'],
      [`_GET_stream_${now + 1}_0_a`, 'malformed'],
      ['_GET_stream_1_0_x', 'malformed'],
      ['x'.repeat(129), 'malformed'],
      [`g${uuid.slice(1)}_${now}_0_a`, 'malformed'],
      [`${uuid}_${now}_0_abcdefg`, 'malformed'],
      [`${uuid}_${now}_1234567890_a`, 'malformed'],
    ] as const)
      expect(classifyCursor(value, now), String(value)).to.equal(kind);
  });

  it('returns each counter reason, omits non-GET cursor detail, and defers all records', async () => {
    const cursor = `${uuid}_${Date.now()}_0_abc`;
    const request = input().request;
    request.headers['last-event-id'] = cursor;
    const cases: [Partial<ObservedRequest>, object][] = [
      [{}, { reason: 'ok', cursor: 'none' }],
      [{ method: 'POST' }, { reason: 'ok' }],
      [
        { failed: true, refusal: 'unknown_session' },
        { reason: 'unknown_session', cursor: 'none' },
      ],
      [
        { failed: true, refusal: 'principal_mismatch', owner },
        { reason: 'principal_mismatch', cursor: 'none' },
      ],
      [
        { failed: true, auth: undefined },
        { reason: 'missing_credentials', cursor: 'none' },
      ],
      [
        {
          failed: true,
          request: {
            ...input().request,
            headers: { authorization: 'Bearer header.payload.signature' },
          },
        },
        { reason: 'invalid_credentials', cursor: 'none' },
      ],
      [{ request }, { reason: 'unknown_cursor', cursor: 'request' }],
      ...[undefined, ''].map(
        (sessionId): [Partial<ObservedRequest>, object] => [
          {
            request,
            store: { cursorContext: () => ({ sessionId, ageMs: 42 }) },
          },
          { reason: 'cursor_context_mismatch', cursor: 'request' },
        ],
      ),
      [
        {
          request,
          store: {
            cursorContext: () => ({
              sessionId: 'session-presenter',
              ageMs: 42,
            }),
          },
        },
        { reason: 'ok', cursor: 'request' },
      ],
      [
        {
          request,
          store: {
            cursorContext: () => ({ sessionId: 'session-owner', ageMs: 42 }),
          },
        },
        { reason: 'cursor_context_mismatch', cursor: 'request' },
      ],
    ];
    for (const [changes, expected] of cases)
      expect(observeSessionRequest(input(changes))).to.deep.equal(expected);
    expect(fetcher.callCount).to.equal(0);
    await tick();
    expect(records()).to.have.length(2);
  });

  it('exports exactly one safe record for each qualifying reason', async () => {
    const cursor = `${uuid}_${Date.now()}_0_abc`;
    const sessions = () => [
      { sessionId: 'session-presenter', auth: owner },
      { sessionId: 'session-owner', auth },
    ];
    observeSessionRequest(
      input({ failed: true, refusal: 'principal_mismatch', owner }),
    );
    observeSessionRequest(input({ failed: true, auth: undefined, sessions }));
    observeSessionRequest(
      input({
        failed: true,
        auth: undefined,
        sessions,
        request: {
          ...input().request,
          headers: {
            authorization: 'Bearer header.payload.signature',
            'user-agent': 'u'.repeat(300),
          },
        },
      }),
    );
    observeSessionRequest(
      input({
        request: {
          ...input().request,
          headers: { ...input().request.headers, 'last-event-id': cursor },
        },
        sessions,
        store: {
          cursorContext: () => ({ sessionId: 'session-owner', ageMs: 42 }),
        },
      }),
    );
    expect(fetcher.callCount).to.equal(0);
    await tick();
    const found = records();
    expect(found).to.have.length(4);
    expect(found.map((r) => r.reason)).to.deep.equal([
      'principal_mismatch',
      'missing_credentials_live_session',
      'invalid_credentials_live_session',
      'cursor_context_mismatch',
    ]);
    for (const r of found) {
      expect(r).to.include({
        scope: 'session-requests',
        severity: 13,
        method: 'GET',
        surface: 'full',
        session_ref: hashToken('session-presenter'),
      });
      expect(r.owner_ref).to.match(/^[a-f0-9]{16}$/);
    }
    expect(found[0]).to.include({
      'event.name': 'browserless.mcp.session.request_refused',
      owner_ref: hashToken(sessionPrincipal(owner)),
      presenter_ref: hashToken(sessionPrincipal(auth)),
      auth_method: 'api_key_header',
      ip: '192.0.2.3',
      user_agent: 'test-client/1',
      user_agent_family: 'test-client',
      has_last_event_id: false,
      cursor_kind: 'none',
    });
    expect(found[2].user_agent).to.have.length(200);
    expect(found[3]).to.include({
      'event.name': 'browserless.mcp.event_store.replay_refused',
      cursor_session_ref: hashToken('session-owner'),
      cursor_age_ms: '42',
      same_principal: true,
      has_last_event_id: true,
      cursor_kind: 'request',
    });
    const serialized = JSON.stringify(
      fetcher.getCalls().map((call) => call.args[1].body),
    );
    for (const secret of [
      auth.token,
      owner.token,
      'header.payload.signature',
      'session-presenter',
      'session-owner',
      cursor,
      'key:',
    ])
      expect(serialized.includes(secret)).to.equal(false);
  });

  it('keeps routine cases silent and resolves liveness only in deferred work', async () => {
    const sessions = sinon.spy(() => []);
    for (const changes of [
      { failed: true, refusal: 'unknown_session' as const },
      { failed: true, auth: undefined },
      {
        failed: true,
        request: { ...input().request, headers: { authorization: 'Bearer x' } },
      },
      {
        request: {
          ...input().request,
          headers: { 'last-event-id': `${uuid}_${Date.now()}_0_x` },
        },
      },
      {
        request: {
          ...input().request,
          headers: { 'last-event-id': '_GET_stream_1000000000000_0_' },
        },
      },
      {
        request: {
          ...input().request,
          headers: { 'last-event-id': `_GET_stream_${Date.now()}_0_` },
        },
      },
    ])
      observeSessionRequest(input({ ...changes, sessions }));
    expect(sessions.callCount).to.equal(0);
    await tick();
    expect(fetcher.callCount).to.equal(0);
    expect(sessions.callCount).to.equal(2);
  });

  it('isolates lookup and exporter failures', async () => {
    const request = {
      ...input().request,
      headers: { 'last-event-id': `${uuid}_${Date.now()}_0_x` },
    };
    expect(
      observeSessionRequest(
        input({
          request,
          store: {
            cursorContext: () => {
              throw new Error('unavailable');
            },
          },
        }),
      ),
    ).to.equal(undefined);
    fetcher.throws(new Error('unavailable'));
    expect(
      observeSessionRequest(
        input({ failed: true, refusal: 'principal_mismatch', owner }),
      ),
    ).to.deep.equal({ reason: 'principal_mismatch', cursor: 'none' });
    await tick();
    expect(fetcher.callCount).to.equal(1);
    observeSessionRequest(
      input({
        failed: true,
        sessions: () => {
          throw new Error('unavailable');
        },
      }),
    );
    await tick();
    expect(fetcher.callCount).to.equal(1);
  });

  it('caps each reason independently and reports drops once at the window boundary', async () => {
    const clock = sinon.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
    });
    try {
      for (let n = 0; n < 61; n++)
        observeSessionRequest(
          input({ failed: true, refusal: 'principal_mismatch', owner }),
        );
      observeSessionRequest(
        input({
          failed: true,
          auth: undefined,
          sessions: () => [{ sessionId: 'session-presenter', auth: owner }],
        }),
      );
      await tick();
      await tick();
      expect(
        records().filter((r) => r.reason === 'principal_mismatch'),
      ).to.have.length(60);
      expect(
        records().filter(
          (r) => r.reason === 'missing_credentials_live_session',
        ),
      ).to.have.length(1);
      await clock.tickAsync(59_999);
      expect(records()).to.have.length(61);
      await clock.tickAsync(1);
      expect(records()[61]).to.include({
        'event.name': 'browserless.mcp.session.records_dropped',
        severity: 9,
        reason: 'principal_mismatch',
        dropped: '1',
        window_s: '60',
        surface: 'full',
      });
      observeSessionRequest(
        input({ failed: true, refusal: 'principal_mismatch', owner }),
      );
      await tick();
      expect(records()).to.have.length(63);
      await clock.tickAsync(60_000);
      expect(records()).to.have.length(63);
    } finally {
      clock.restore();
    }
  });

  it('exports the missing-context diagnostic once and defers its transport', async () => {
    noteMissingStoreContext('connector');
    noteMissingStoreContext('connector');
    expect(fetcher.callCount).to.equal(0);
    await tick();
    expect(records()).to.deep.equal([
      {
        scope: 'session-requests',
        severity: 17,
        'event.name': 'browserless.mcp.event_store.context_missing',
        surface: 'connector',
      },
    ]);
  });
});
