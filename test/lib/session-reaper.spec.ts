import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import sinon from 'sinon';
import {
  touchSession,
  forgetSession,
  trackedSessionCount,
  reapIdleSessions,
  startSessionReaper,
  stopSessionReaper,
  resetSessionReaperForTests,
  type ReapableSession,
} from '../../src/lib/session-reaper.js';

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
});
