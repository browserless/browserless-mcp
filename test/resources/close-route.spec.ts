import { expect } from 'chai';
import { FastMCP } from 'fastmcp';
import type { McpConfig } from '../../src/@types/types.js';
import { registerCloseRoute } from '../../src/resources/close-route.js';
import {
  acquireStripeLinkSessionOperation,
  getOrCreateSession,
} from '../../src/lib/agent-client.js';
import { makeAcceptingServer } from '../helpers/upgrade-server.js';

const config = {
  browserlessApiUrl: 'https://api.example.com',
  supabaseUrl: '',
  supabaseServiceRoleKey: '',
} as McpConfig;
const app = () => {
  const server = new FastMCP({ name: 'test', version: '1.0.0' });
  registerCloseRoute(server, config);
  return server.getApp();
};

describe('remote session close route', () => {
  it('requires authentication, isolates tokens, and closes idempotently', async () => {
    const upstream = await makeAcceptingServer();
    try {
      const session = await getOrCreateSession('mcp', upstream.url, 'owner');
      const route = app();
      const url = `/agent/session/${encodeURIComponent(session.handle)}`;
      expect((await route.request(url, { method: 'DELETE' })).status).to.equal(
        401,
      );
      expect(
        (await route.request(`${url}?token=other`, { method: 'DELETE' }))
          .status,
      ).to.equal(200);
      expect(session.ws.readyState).to.equal(1);
      for (let i = 0; i < 2; i++) {
        expect(
          (
            await route.request(url, {
              method: 'DELETE',
              headers: { Authorization: 'Bearer owner' },
            })
          ).status,
        ).to.equal(200);
      }
      expect(session.ws.readyState).not.to.equal(1);
    } finally {
      await upstream.close();
    }
  });

  for (const state of ['active', 'resume', 'report'] as const) {
    it(`returns an actionable 409 for a ${state} Stripe Link operation`, async () => {
      const upstream = await makeAcceptingServer();
      let release: (() => void) | undefined;
      try {
        const session = await getOrCreateSession('mcp', upstream.url, 'owner');
        if (state === 'active')
          release = await acquireStripeLinkSessionOperation(session);
        else
          session.stripeLinkContinuation = {
            checkoutId: 'checkout',
            allowedNextAction: state,
            validUntil: Date.now() + 60_000,
          };
        const result = await app().request(
          `/agent/session/${encodeURIComponent(session.handle)}?token=owner`,
          { method: 'DELETE' },
        );
        expect(result.status).to.equal(409);
        const body = (await result.json()) as { error: string };
        expect(body.error).to.include('Stripe Link checkout');
        expect(session.ws.readyState).to.equal(1);
      } finally {
        release?.();
        await upstream.close();
      }
    });
  }

  it('passes unexpected errors to the application error handler', async () => {
    const upstream = await makeAcceptingServer();
    try {
      const session = await getOrCreateSession('mcp', upstream.url, 'owner');
      const unexpected = new Error('unexpected failure');
      Object.defineProperty(session, 'stripeLinkContinuation', {
        get() {
          throw unexpected;
        },
      });
      const route = app();
      let observed: Error | undefined;
      route.onError((error, c) => {
        observed = error;
        return c.json({ ok: false }, 500);
      });
      const result = await route.request(
        `/agent/session/${encodeURIComponent(session.handle)}?token=owner`,
        { method: 'DELETE' },
      );
      expect(result.status).to.equal(500);
      expect(observed).to.equal(unexpected);
    } finally {
      await upstream.close();
    }
  });
});
