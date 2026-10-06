import { expect } from 'chai';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import sinon from 'sinon';
import * as client from '../../src/lib/agent-client.js';
import { makeRespondingServer } from '../helpers/upgrade-server.js';

describe('agent-client session sweep', () => {
  afterEach(() => sinon.restore());

  it('exposes pool size, in-flight commands, and cumulative sweeps for telemetry', async () => {
    const browser = await makeRespondingServer(() => ({}));
    try {
      const sweptBefore = client.sweptSessionTotal();
      const session = await client.getOrCreateSession(
        'telemetry-accessor',
        browser.url,
        'tok',
      );
      // Freshly pooled and idle: counted as active, no command in flight.
      expect(client.activeAgentSessionCount()).to.be.greaterThan(0);
      expect(client.inFlightCommandCount()).to.equal(0);
      // Creation already resolved, so nothing is mid-creation.
      expect(client.pendingSessionCount()).to.equal(0);
      // Age past the idle TTL and sweep: the cumulative swept counter advances.
      session.lastUsedAt = Date.now() - 16 * 60 * 1000;
      const closed = once(session.ws, 'close');
      client.sweepSessions();
      await closed;
      expect(client.sweptSessionTotal()).to.equal(sweptBefore + 1);
    } finally {
      await browser.close();
    }
  });

  it('proper-closes idle sessions, preserves the 15-minute boundary and cannot delete a replacement', async () => {
    let acknowledge!: () => void;
    const browser = await makeRespondingServer((method) =>
      method === 'close'
        ? new Promise<void>((resolve) => {
            acknowledge = resolve;
          })
        : {},
    );
    try {
      const session = await client.getOrCreateSession(
        'idle-sweep',
        browser.url,
        'tok',
      );
      const outbound = sinon.spy(session.ws, 'send');
      const now = Date.now();
      session.lastUsedAt = now - 15 * 60 * 1000;
      client.sweepSessions(now);
      expect(outbound.called).to.equal(false);
      client.sweepSessions(now + 1);
      expect(outbound.calledOnce).to.equal(true);
      expect(JSON.parse(String(outbound.firstCall.args[0]))).to.include({
        method: 'close',
      });
      client.sweepSessions(now + 2, 0);
      expect(outbound.calledOnce).to.equal(true);
      const replacement = await client.getOrCreateSession(
        'idle-sweep',
        browser.url,
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        session.handle,
      );
      expect(replacement.handle).to.equal(session.handle);
      expect(replacement).not.to.equal(session);
      while (!acknowledge)
        await new Promise((resolve) => setImmediate(resolve));
      const closed = once(session.ws, 'close');
      acknowledge();
      await closed;
      client.destroySession(
        'idle-sweep',
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        session.handle,
        undefined,
        undefined,
        undefined,
        session,
      );
      expect(
        client.getActiveSessionByHandle(replacement.handle, browser.url, 'tok'),
      ).to.equal(replacement);
      client.destroySession(
        'idle-sweep',
        'tok',
        undefined,
        undefined,
        undefined,
        undefined,
        replacement.handle,
        undefined,
        undefined,
        undefined,
        replacement,
      );
      expect(() =>
        client.getActiveSessionByHandle(replacement.handle, browser.url, 'tok'),
      ).to.throw('unavailable');
    } finally {
      acknowledge?.();
      await browser.close();
    }
  });

  it('proper-closes only the oldest excess session and protects checkout operations', async () => {
    const browser = await makeRespondingServer(() => ({}));
    let release: (() => void) | undefined;
    try {
      const guarded = await client.getOrCreateSession(
        'guarded-sweep',
        browser.url,
        'tok',
      );
      release = await client.acquireStripeLinkSessionOperation(guarded);
      const oldest = await client.getOrCreateSession(
        'oldest-sweep',
        browser.url,
        'tok',
      );
      const newest = await client.getOrCreateSession(
        'newest-sweep',
        browser.url,
        'tok',
      );
      const guardSend = sinon.spy(guarded.ws, 'send');
      const oldSend = sinon.spy(oldest.ws, 'send');
      const newSend = sinon.spy(newest.ws, 'send');
      guarded.lastUsedAt = Date.now() - 16 * 60 * 1000;
      oldest.lastUsedAt = Date.now() - 1000;
      client.sweepSessions(Date.now(), 2);
      expect(guardSend.called).to.equal(false);
      expect(newSend.called).to.equal(false);
      expect(oldSend.calledOnce).to.equal(true);
      expect(JSON.parse(String(oldSend.firstCall.args[0]))).to.include({
        method: 'close',
      });
      await once(oldest.ws, 'close');
    } finally {
      release?.();
      await browser.close();
    }
  });

  it('cleans up after a close response timeout without reconnecting', async () => {
    const browser = await makeRespondingServer(() => new Promise(() => {}));
    try {
      const session = await client.getOrCreateSession(
        'timeout-sweep',
        browser.url,
        'tok',
      );
      const clock = sinon.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout'],
      });
      const outbound = sinon.spy(session.ws, 'send');
      const closeSocket = sinon.spy(session.ws, 'close');
      session.lastUsedAt = Date.now() - 16 * 60 * 1000;
      const closed = once(session.ws, 'close');
      client.sweepSessions();
      expect(outbound.calledOnce).to.equal(true);
      await clock.tickAsync(4999);
      expect(closeSocket.called).to.equal(false);
      await clock.tickAsync(1);
      expect(closeSocket.calledOnce).to.equal(true);
      await closed;
      expect(browser.hits()).to.equal(1);
      expect(() =>
        client.getActiveSessionByHandle(session.handle, browser.url, 'tok'),
      ).to.throw('unavailable');
    } finally {
      sinon.restore();
      await browser.close();
    }
  });

  it('boots the sweep for both transports without closing browsers on disconnect', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    const disconnect = source.slice(
      source.indexOf("server.on('disconnect'"),
      source.indexOf("if (config.transport === 'httpStream')"),
    );
    expect(disconnect).to.include('dropMcpSession');
    expect(disconnect).not.to.match(
      /closeSession|closeAllSessions|properClose/,
    );
    expect(disconnect).to.include('startSweepTimer();');
  });

  it('starts one unrefed timer and reaps without incoming traffic while activity refreshes the idle clock', async () => {
    const browser = await makeRespondingServer(() => ({}));
    try {
      const idle = await client.getOrCreateSession(
        'timer-idle',
        browser.url,
        'tok',
      );
      const active = await client.getOrCreateSession(
        'timer-active',
        browser.url,
        'tok',
      );
      const clock = sinon.useFakeTimers({
        now: Date.now() + 1000,
        toFake: ['Date', 'setInterval', 'clearInterval'],
      });
      idle.lastUsedAt = clock.now;
      active.lastUsedAt = clock.now;
      const interval = sinon.spy(globalThis, 'setInterval');
      client.startSweepTimer();
      client.startSweepTimer();
      expect(interval.calledOnce).to.equal(true);
      expect(interval.firstCall.returnValue.hasRef()).to.equal(false);
      await clock.tickAsync(15 * 60 * 1000);
      expect(idle.ws.readyState).to.equal(1);
      await client.send(active, 'getCookies');
      const closed = once(idle.ws, 'close');
      await clock.tickAsync(60_000);
      await closed;
      expect(
        client.getActiveSessionByHandle(active.handle, browser.url, 'tok'),
      ).to.equal(active);
      client.stopSweepTimer();
      expect(clock.countTimers()).to.equal(0);
      client.startSweepTimer();
      expect(interval.callCount).to.equal(2);
    } finally {
      client.stopSweepTimer();
      sinon.restore();
      await browser.close();
    }
  });

  for (const [value, expected] of [
    ['-1', 60_000],
    ['2147483648', 60_000],
    ['Infinity', 60_000],
    ['NaN', 60_000],
    ['0', 60_000],
    ['0.5', 60_000],
    ['1', 1],
    ['1234', 1234],
    ['2147483647', 2147483647],
  ] as const) {
    it(`schedules MCP_SWEEP_MS=${value} at ${expected}ms`, () => {
      const previous = process.env.MCP_SWEEP_MS;
      sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const interval = sinon.spy(globalThis, 'setInterval');
      try {
        process.env.MCP_SWEEP_MS = value;
        client.startSweepTimer();
        expect(interval.firstCall.args[1]).to.equal(expected);
      } finally {
        client.stopSweepTimer();
        if (previous === undefined) delete process.env.MCP_SWEEP_MS;
        else process.env.MCP_SWEEP_MS = previous;
      }
    });
  }
});
