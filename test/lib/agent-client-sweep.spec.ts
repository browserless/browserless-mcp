import { expect } from 'chai';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import sinon from 'sinon';
import * as client from '../../src/lib/agent-client.js';
import { makeRespondingServer } from '../helpers/upgrade-server.js';

describe('agent-client session sweep', () => {
  afterEach(() => sinon.restore());

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
      expect(
        client.getActiveSessionByHandle(replacement.handle, browser.url, 'tok'),
      ).to.equal(replacement);
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
      session.lastUsedAt = Date.now() - 16 * 60 * 1000;
      const closed = once(session.ws, 'close');
      client.sweepSessions();
      expect(outbound.calledOnce).to.equal(true);
      await clock.tickAsync(60_000);
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
        now: Date.now(),
        toFake: ['Date', 'setInterval', 'clearInterval'],
      });
      const interval = sinon.spy(globalThis, 'setInterval');
      client.startSweepTimer();
      client.startSweepTimer();
      expect(interval.calledOnce).to.equal(true);
      expect(interval.firstCall.returnValue.hasRef()).to.equal(false);
      await clock.tickAsync(15 * 60 * 1000);
      await client.send(active, 'getCookies');
      const closed = once(idle.ws, 'close');
      await clock.tickAsync(60_000);
      await closed;
      expect(
        client.getActiveSessionByHandle(active.handle, browser.url, 'tok'),
      ).to.equal(active);
    } finally {
      sinon.restore();
      await browser.close();
    }
  });
});
