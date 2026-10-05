import { expect } from 'chai';
import { once } from 'node:events';
import sinon from 'sinon';
import * as client from '../../src/lib/agent-client.js';
import { makeRespondingServer } from '../helpers/upgrade-server.js';

describe('agent-client eviction safety', () => {
  afterEach(() => sinon.restore());

  it('evicts an attached/profile session without sending the agent close command', async () => {
    const browser = await makeRespondingServer(() => ({}));
    try {
      const session = await client.getOrCreateSession(
        'attached-evict',
        browser.url,
        'tok',
      );
      // Simulate an attached (attachSessionId) or profile-creation browser whose
      // lifetime is owned elsewhere.
      session.creationSessionId = 'ext-sess-123';
      const outbound = sinon.spy(session.ws, 'send');
      session.lastUsedAt = Date.now() - 16 * 60 * 1000;
      const closed = once(session.ws, 'close');
      client.sweepSessions();
      await closed;
      // Our socket is dropped, but no `close` command is sent — the externally
      // owned browser survives.
      expect(outbound.called).to.equal(false);
      expect(() =>
        client.getActiveSessionByHandle(session.handle, browser.url, 'tok'),
      ).to.throw('unavailable');
    } finally {
      await browser.close();
    }
  });

  it('does not evict a session whose command is still in flight past the idle TTL', async () => {
    let release!: () => void;
    const browser = await makeRespondingServer((method) =>
      method === 'getCookies'
        ? new Promise<Record<string, never>>((resolve) => {
            release = () => resolve({});
          })
        : {},
    );
    try {
      const session = await client.getOrCreateSession(
        'inflight-evict',
        browser.url,
        'tok',
      );
      const pending = client.send(session, 'getCookies');
      // Wait until the mock server holds the command (response pending) so it is
      // genuinely in flight.
      while (!release) await new Promise((r) => setImmediate(r));
      // Simulate the command running past the idle TTL.
      session.lastUsedAt = Date.now() - 16 * 60 * 1000;
      const outbound = sinon.spy(session.ws, 'send');
      client.sweepSessions();
      // In-flight guard skips eviction: no close command, session retained.
      expect(outbound.called).to.equal(false);
      expect(
        client.getActiveSessionByHandle(session.handle, browser.url, 'tok'),
      ).to.equal(session);
      // Completing the command refreshes the idle clock and clears the guard.
      release();
      await pending;
      expect(session.lastUsedAt).to.be.greaterThan(Date.now() - 60 * 1000);
    } finally {
      release?.();
      await browser.close();
    }
  });
});
