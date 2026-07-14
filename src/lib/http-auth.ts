import type { Context } from 'hono';
import { resolveApiKey } from './account-resolver.js';
import type { McpConfig } from '../@types/types.js';

export interface ResolvedBrowserlessAuth {
  token: string;
  apiUrl: string;
  attachSessionId?: string;
  clientSource?: string;
}

export interface AuthInput {
  authHeader?: string;
  tokenQuery?: string;
  apiUrlHeader?: string;
  browserlessUrlQuery?: string;
  sessionIdHeader?: string;
  sessionIdQuery?: string;
  clientHeader?: string;
}

// Inbound `x-browserless-client` values we forward verbatim onto the agent WS
// upgrade. Anything else (including a client trying to pass itself off as
// 'direct') collapses to 'mcp' so MCP-originated traffic can never masquerade
// as a raw WebSocket client. Grows as new first-party sub-sources appear.
const FORWARDED_CLIENT_SOURCES = new Set(['script_generator']);

const resolveClientSource = (clientHeader?: string): string =>
  clientHeader && FORWARDED_CLIENT_SOURCES.has(clientHeader)
    ? clientHeader
    : 'mcp';

/**
 * Resolve a Browserless API token from an inbound HTTP request, in order:
 * (1) Authorization header with a plain API key, (2) `?token=` query param,
 * (3) Authorization header with a Supabase JWT → resolved via PostgREST.
 * Throws when none is present/valid. Shared by the FastMCP `authenticate`
 * callback and the custom `/upload` route so both gate on the same rules.
 */
export const resolveBrowserlessAuth = async (
  input: AuthInput,
  config: Pick<
    McpConfig,
    'browserlessApiUrl' | 'supabaseUrl' | 'supabaseServiceRoleKey'
  >,
): Promise<ResolvedBrowserlessAuth> => {
  const apiUrl =
    input.apiUrlHeader ?? input.browserlessUrlQuery ?? config.browserlessApiUrl;

  // A pre-created session id to attach to, threaded by the autologin runner.
  // The agent tool opens /chromium/agent?sessionId=<this> instead of doing its
  // own POST /profile.
  const attachSessionId = input.sessionIdHeader ?? input.sessionIdQuery;

  // Sub-source marker (e.g. 'script_generator') forwarded onto the agent WS so
  // enterprise Amplitude events can attribute it; defaults to 'mcp'.
  const clientSource = resolveClientSource(input.clientHeader);

  const headerToken = input.authHeader?.startsWith('Bearer ')
    ? input.authHeader.slice(7)
    : input.authHeader;

  // JWTs have 3 dot-separated base64url segments; plain API keys do not.
  const isJwt = headerToken ? headerToken.split('.').length === 3 : false;

  // A plain key (header or ?token=) is used directly and wins over JWT exchange.
  const plainKey = (isJwt ? undefined : headerToken) ?? input.tokenQuery;
  if (plainKey) {
    return { token: plainKey, apiUrl, attachSessionId, clientSource };
  }

  // A JWT is exchanged for the account's Browserless API key via PostgREST.
  if (isJwt && headerToken) {
    const { apiKey } = await resolveApiKey(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      headerToken,
    );
    return { token: apiKey, apiUrl, attachSessionId, clientSource };
  }

  throw new Error(
    'No Browserless API token provided. ' +
      'Pass it as Authorization: Bearer <token> header, ' +
      '?token= query parameter, or authenticate via OAuth.',
  );
};

export const guardRouteAuth = async (
  c: Context,
  config: Parameters<typeof resolveBrowserlessAuth>[1],
): Promise<Response | null> => {
  try {
    await resolveBrowserlessAuth(
      {
        authHeader: c.req.header('authorization'),
        tokenQuery: c.req.query('token'),
        apiUrlHeader: c.req.header('x-browserless-api-url'),
        browserlessUrlQuery: c.req.query('browserlessUrl'),
      },
      config,
    );
    return null;
  } catch {
    return c.json({ ok: false, error: 'Unauthorized' }, 401);
  }
};
