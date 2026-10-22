import { expect } from 'chai';
import { FastMCP } from 'fastmcp';
import Sinon from 'sinon';
import type { McpConfig } from '../../src/@types/types.js';
import { registerCloseRoute } from '../../src/resources/close-route.js';
import {
  acquireStripeLinkSessionOperation,
  getOrCreateSession,
  closeSessionByHandle,
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
  it('requires authentication, isolates tokens, and reports absent sessions', async () => {
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
      ).to.equal(404);
      expect(session.ws.readyState).to.equal(1);
      for (let i = 0; i < 2; i++) {
        expect(
          (
            await route.request(url, {
              method: 'DELETE',
              headers: { Authorization: 'Bearer owner' },
            })
          ).status,
        ).to.equal(i === 0 ? 200 : 404);
      }
      expect(session.ws.readyState).not.to.equal(1);
    } finally {
      await upstream.close();
    }
  });

  for (const scope of ['attach', 'profile', 'integration'] as const) {
    it(`closes the exact cached key for a ${scope} session`, async () => {
      const upstream = await makeAcceptingServer();
      const args: Parameters<typeof getOrCreateSession> = [
        'mcp',
        upstream.url,
        'owner',
      ];
      if (scope === 'attach') args[6] = 'attached-session';
      if (scope === 'profile') {
        args[5] = { name: 'creation-profile' };
        Sinon.stub(globalThis, 'fetch').resolves(
          new Response(JSON.stringify({ id: 'created-session' })),
        );
      }
      if (scope === 'integration') {
        args[10] = 'integration-id';
        args[11] = ['example.com'];
      }
      try {
        const session = await getOrCreateSession(...args);
        const response = await app().request(
          `/agent/session/${encodeURIComponent(session.handle)}?token=owner`,
          { method: 'DELETE' },
        );
        expect(response.status).to.equal(200);
        expect(session.ws.readyState).not.to.equal(1);
        expect(closeSessionByHandle(session.handle, 'owner')).to.equal(false);
      } finally {
        Sinon.restore();
        await upstream.close();
      }
    });
  }

  it('refuses an ambiguous handle without closing either integration binding', async () => {
    const upstream = await makeAcceptingServer();
    const open = (integration: string) =>
      getOrCreateSession(
        'mcp',
        upstream.url,
        'owner',
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        's:shared',
        integration,
      );
    try {
      const first = await open('first-integration');
      const second = await open('second-integration');
      const response = await app().request(
        '/agent/session/s%3Ashared?token=owner',
        { method: 'DELETE' },
      );
      expect(response.status).to.equal(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).to.include('Multiple browser sessions');
      expect(first.ws.readyState).to.equal(1);
      expect(second.ws.readyState).to.equal(1);
    } finally {
      await upstream.close();
    }
  });

  it('isolates OAuth users sharing an account token', async () => {
    const upstream = await makeAcceptingServer();
    const args: Parameters<typeof getOrCreateSession> = [
      'mcp',
      upstream.url,
      'owner',
    ];
    args[17] = 'user-one';
    try {
      const session = await getOrCreateSession(...args);
      expect(closeSessionByHandle(session.handle, 'owner')).to.equal(false);
      expect(
        closeSessionByHandle(session.handle, 'owner', 'user-two'),
      ).to.equal(false);
      expect(session.ws.readyState).to.equal(1);
      expect(
        closeSessionByHandle(session.handle, 'owner', 'user-one'),
      ).to.equal(true);
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
