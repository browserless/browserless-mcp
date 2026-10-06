import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import sinon from 'sinon';
import {
  touchSession,
  forgetSession,
  beginSessionExec,
  endSessionExec,
  trackedSessionCount,
  inFlightExecCount,
  reapedSessionTotal,
  reapIdleSessions,
  startSessionReaper,
  stopSessionReaper,
  resetSessionReaperForTests,
  type ReapableSession,
} from '../../src/lib/session-reaper.js';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  createSyncInstruments,
  resetSyncInstruments,
} from '../../src/lib/metrics-recorders.js';

const TTL = 30 * 60 * 1000;

const fakeSession = (
  sessionId: string | undefined,
): ReapableSession & { close: sinon.SinonSpy } => ({
  sessionId,
  close: sinon.spy(() => Promise.resolve()),
});

describe('session-reaper', () => {
  beforeEach(() => resetSessionReaperForTests());
  afterEach(() => {
    resetSessionReaperForTests();
    sinon.restore();
  });

  it('tracks and forgets inbound activity', () => {
    expect(trackedSessionCount()).to.equal(0);
    touchSession('a', 1000);
    touchSession('b', 1000);
    touchSession(undefined, 1000);
    expect(trackedSessionCount()).to.equal(2);
    forgetSession('a');
    forgetSession(undefined);
    expect(trackedSessionCount()).to.equal(1);
  });

  it('closes only sessions idle beyond the TTL and forgets them', () => {
    const now = 10 * TTL;
    const idle = fakeSession('idle');
    const fresh = fakeSession('fresh');
    touchSession('idle', now - TTL - 1);
    touchSession('fresh', now - 1000);

    const closed = reapIdleSessions(() => [idle, fresh], { now, ttlMs: TTL });

    expect(closed).to.equal(1);
    expect(idle.close.calledOnce).to.equal(true);
    expect(fresh.close.called).to.equal(false);
    // The reaped id is forgotten; the live one is retained.
    expect(trackedSessionCount()).to.equal(1);
  });

  it('does not reap exactly at the boundary (idle === TTL)', () => {
    const now = 10 * TTL;
    const edge = fakeSession('edge');
    touchSession('edge', now - TTL);
    const closed = reapIdleSessions(() => [edge], { now, ttlMs: TTL });
    expect(closed).to.equal(0);
    expect(edge.close.called).to.equal(false);
  });

  it('never reaps a session without an id (stdio)', () => {
    const now = 10 * TTL;
    const stdio = fakeSession(undefined);
    const closed = reapIdleSessions(() => [stdio], { now, ttlMs: TTL });
    expect(closed).to.equal(0);
    expect(stdio.close.called).to.equal(false);
  });

  it('records a first-seen session and spares it for a full TTL', () => {
    const now = 10 * TTL;
    const unseen = fakeSession('unseen');
    // Never touched: first sight must record, not reap.
    expect(reapIdleSessions(() => [unseen], { now, ttlMs: TTL })).to.equal(0);
    expect(unseen.close.called).to.equal(false);
    expect(trackedSessionCount()).to.equal(1);
    // Still within TTL on the next pass.
    expect(
      reapIdleSessions(() => [unseen], { now: now + TTL, ttlMs: TTL }),
    ).to.equal(0);
    // Past TTL from first sight -> reaped.
    expect(
      reapIdleSessions(() => [unseen], { now: now + TTL + 1, ttlMs: TTL }),
    ).to.equal(1);
    expect(unseen.close.calledOnce).to.equal(true);
  });

  it('never reaps a session with a tool execution in flight', () => {
    const now = 10 * TTL;
    const busy = fakeSession('busy');
    touchSession('busy', now - TTL - 1); // idle beyond the TTL...
    beginSessionExec('busy'); // ...but a tool call is running
    expect(reapIdleSessions(() => [busy], { now, ttlMs: TTL })).to.equal(0);
    expect(busy.close.called).to.equal(false);
    // Completing the call refreshes the idle clock.
    endSessionExec('busy', now);
    expect(
      reapIdleSessions(() => [busy], { now: now + 1000, ttlMs: TTL }),
    ).to.equal(0);
    // Idle again past the TTL -> reaped.
    expect(
      reapIdleSessions(() => [busy], { now: now + TTL + 2000, ttlMs: TTL }),
    ).to.equal(1);
    expect(busy.close.calledOnce).to.equal(true);
  });

  it('prunes tracked ids that never became sessions (unauthenticated/bogus requests)', () => {
    const now = 10 * TTL;
    // Pre-auth touches for 200 distinct ids that are then rejected (401) and
    // never become sessions.
    for (let i = 0; i < 200; i++) touchSession('bogus-' + i, now);
    expect(trackedSessionCount()).to.equal(200);
    // A reaper pass with no live sessions must drop every orphaned id.
    expect(reapIdleSessions(() => [], { now: now + 1, ttlMs: TTL })).to.equal(
      0,
    );
    expect(trackedSessionCount()).to.equal(0);
  });

  it('prunes bogus ids but keeps a live session alongside them', () => {
    const now = 10 * TTL;
    const live = fakeSession('live');
    touchSession('live', now); // real, in server.sessions, recently active
    touchSession('bogus', now); // stamped pre-auth, never a session
    reapIdleSessions(() => [live], { now: now + 1000, ttlMs: TTL });
    expect(trackedSessionCount()).to.equal(1); // bogus dropped, live kept
    expect(live.close.called).to.equal(false); // live not reaped (within TTL)
  });

  it('keeps a live session that follows a reaped one in a mutable session array', () => {
    const now = 10 * TTL;
    // Emulate FastMCP's mutable server.sessions: closing a session splices it out.
    const arr: ReapableSession[] = [];
    const idle: ReapableSession = {
      sessionId: 'idle',
      close: () => {
        const i = arr.indexOf(idle);
        if (i >= 0) arr.splice(i, 1);
        return Promise.resolve();
      },
    };
    const live = fakeSession('live');
    arr.push(idle, live); // live follows the idle one that will splice itself
    touchSession('idle', now - TTL - 1);
    touchSession('live', now);
    beginSessionExec('live'); // live has a tool call in flight
    reapIdleSessions(() => arr, { now, ttlMs: TTL });
    // live must not be skipped+pruned: its tracking survives...
    expect(trackedSessionCount()).to.equal(1);
    // ...and its in-flight guard survives (stays unreaped even when idle-aged).
    reapIdleSessions(() => [live], { now: now + 10 * TTL, ttlMs: TTL });
    expect(live.close.called).to.equal(false);
  });

  it('swallows a throwing close() and still forgets the session', () => {
    const now = 10 * TTL;
    const bad: ReapableSession = {
      sessionId: 'bad',
      close: () => {
        throw new Error('already gone');
      },
    };
    touchSession('bad', now - TTL - 1);
    expect(() =>
      reapIdleSessions(() => [bad], { now, ttlMs: TTL }),
    ).to.not.throw();
    expect(trackedSessionCount()).to.equal(0);
  });

  it('starts one unref’d timer, is idempotent, and reaps on tick', () => {
    const clock = sinon.useFakeTimers({
      now: 10 * TTL,
      toFake: ['Date', 'setInterval', 'clearInterval'],
    });
    const interval = sinon.spy(globalThis, 'setInterval');
    const idle = fakeSession('idle');
    touchSession('idle', clock.now - TTL - 1);

    startSessionReaper(() => [idle]);
    startSessionReaper(() => [idle]);
    expect(interval.calledOnce).to.equal(true);
    expect(interval.firstCall.returnValue.hasRef()).to.equal(false);

    clock.tick(60_000);
    expect(idle.close.calledOnce).to.equal(true);

    stopSessionReaper();
    expect(clock.countTimers()).to.equal(0);
    startSessionReaper(() => [idle]);
    expect(interval.callCount).to.equal(2);
  });

  for (const [value, expected] of [
    ['-1', 60_000],
    ['2147483648', 60_000],
    ['Infinity', 60_000],
    ['NaN', 60_000],
    ['0', 60_000],
    ['1', 1],
    ['1234', 1234],
    ['2147483647', 2147483647],
  ] as const) {
    it(`schedules MCP_SESSION_REAP_MS=${value} at ${expected}ms`, () => {
      const previous = process.env.MCP_SESSION_REAP_MS;
      sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const interval = sinon.spy(globalThis, 'setInterval');
      try {
        process.env.MCP_SESSION_REAP_MS = value;
        startSessionReaper(() => []);
        expect(interval.firstCall.args[1]).to.equal(expected);
      } finally {
        stopSessionReaper();
        if (previous === undefined) delete process.env.MCP_SESSION_REAP_MS;
        else process.env.MCP_SESSION_REAP_MS = previous;
      }
    });
  }

  it('honors MCP_SESSION_TTL_MS at reap time', () => {
    const clock = sinon.useFakeTimers({
      now: 10 * TTL,
      toFake: ['Date', 'setInterval', 'clearInterval'],
    });
    const previous = process.env.MCP_SESSION_TTL_MS;
    const idle = fakeSession('idle');
    // Idle for 2 minutes; default 30m TTL would spare it, a 1m TTL reaps it.
    touchSession('idle', clock.now - 2 * 60 * 1000);
    try {
      process.env.MCP_SESSION_TTL_MS = String(60_000);
      startSessionReaper(() => [idle]);
      clock.tick(60_000);
      expect(idle.close.calledOnce).to.equal(true);
    } finally {
      stopSessionReaper();
      if (previous === undefined) delete process.env.MCP_SESSION_TTL_MS;
      else process.env.MCP_SESSION_TTL_MS = previous;
    }
  });

  it('index.ts wires the reaper and releases the ping on disconnect', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    // Backstop reaper is booted with the live session list.
    expect(source).to.include('startSessionReaper(() => server.sessions)');
    // Connect stamps activity; disconnect forgets and closes the dead session.
    expect(source).to.include('touchSession(event.session.sessionId)');
    expect(source).to.include('forgetSession(event.session.sessionId)');
    expect(source).to.include('event.session.close()');
    // Every authenticated inbound request refreshes the session's idle clock.
    expect(source).to.include("request.headers?.['mcp-session-id']");
  });

  it('reports in-flight tool executions via inFlightExecCount (telemetry)', () => {
    expect(inFlightExecCount()).to.equal(0);
    beginSessionExec('a');
    beginSessionExec('b');
    expect(inFlightExecCount()).to.equal(2);
    endSessionExec('a');
    expect(inFlightExecCount()).to.equal(1);
  });

  it('counts reaped idle sessions cumulatively via reapedSessionTotal (telemetry)', () => {
    const now = 10 * TTL;
    const idle = fakeSession('idle');
    touchSession('idle', now - TTL - 1);
    expect(reapedSessionTotal()).to.equal(0); // reset in beforeEach
    expect(reapIdleSessions(() => [idle], { now, ttlMs: TTL })).to.equal(1);
    expect(reapedSessionTotal()).to.equal(1);
    // A pass that closes nothing does not advance the counter.
    reapIdleSessions(() => [], { now: now + 1, ttlMs: TTL });
    expect(reapedSessionTotal()).to.equal(1);
  });
});

describe('session-reaper lifetime telemetry (A2 regression)', () => {
  // Regression: safeClose() → FastMCP disconnect → forgetSession deletes
  // firstSeen, so bornAt must be read before safeClose or the sample is lost.
  let provider: MeterProvider;
  const captured: ResourceMetrics[] = [];

  afterEach(async () => {
    await provider?.shutdown();
    metrics.disable();
    resetSyncInstruments();
    resetSessionReaperForTests();
    sinon.restore();
  });

  it('records session.lifetime_ms{mcp} even though close() forgets the session first', async () => {
    resetSessionReaperForTests();
    resetSyncInstruments();
    captured.length = 0;
    const exporter: PushMetricExporter = {
      export: (rm, cb) => {
        captured.push(rm);
        cb({ code: 0 });
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
      selectAggregationTemporality: () => AggregationTemporality.CUMULATIVE,
    };
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 2 ** 31 - 1,
    });
    provider = new MeterProvider({ readers: [reader] });
    // setGlobalMeterProvider no-ops if one is already registered by another
    // spec; clear first so this test is run-order independent.
    metrics.disable();
    metrics.setGlobalMeterProvider(provider);
    createSyncInstruments();

    const bornAt = 1_000_000;
    const now = bornAt + TTL + 5;
    touchSession('sid-1', bornAt);
    // close() synchronously forgets the session — exactly what FastMCP's
    // disconnect handler does, deleting firstSeen before the lifetime record.
    const session = {
      sessionId: 'sid-1',
      close: sinon.spy(() => {
        forgetSession('sid-1');
        return Promise.resolve();
      }),
    };
    expect(reapIdleSessions(() => [session], { now, ttlMs: TTL })).to.equal(1);
    expect(session.close.calledOnce).to.equal(true);

    await reader.forceFlush();
    const life = captured
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
      .find((m) => m.descriptor.name === 'browserless.mcp.session.lifetime_ms');
    const mcpPoint = life?.dataPoints.find((d) => d.attributes.kind === 'mcp');
    expect(mcpPoint, 'no mcp lifetime sample recorded on reap').to.not.equal(
      undefined,
    );
    expect((mcpPoint?.value as { sum?: number })?.sum).to.equal(now - bornAt);
  });
});
