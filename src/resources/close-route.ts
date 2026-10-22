import type { FastMCP } from 'fastmcp';
import type { McpConfig } from '../@types/types.js';
import {
  closeSession,
  SessionCloseConflictError,
} from '../lib/agent-client.js';
import { guardRouteAuth } from '../lib/http-auth.js';

export function registerCloseRoute(server: FastMCP, config: McpConfig): void {
  server.getApp().delete('/agent/session/:handle', async (c) => {
    const auth = await guardRouteAuth(c, config);
    if (auth instanceof Response) return auth;
    try {
      closeSession(
        undefined,
        auth.token,
        undefined,
        undefined,
        undefined,
        undefined,
        c.req.param('handle'),
        undefined,
        undefined,
        undefined,
        auth.userId,
      );
    } catch (error) {
      if (error instanceof SessionCloseConflictError) {
        return c.json({ ok: false, error: error.message }, 409);
      }
      throw error;
    }
    return c.json({ ok: true });
  });
}
