import type { IncomingMessage } from 'node:http';
import type { Context } from 'hono';
import { resolveApiKey } from './account-resolver.js';
import type { BrowserlessSession, McpConfig } from '../@types/types.js';
import { assertAllowedApiUrl, InvalidApiUrlError } from './api-url-guard.js';

export type ResolvedBrowserlessAuth = BrowserlessSession;

export interface AuthInput {
  authHeader?: string;
  tokenQuery?: string;
  apiUrlHeader?: string;
  browserlessUrlQuery?: string;
  sessionIdHeader?: string;
  sessionIdQuery?: string;
  sourceHeader?: string;
  sourceQuery?: string;
}

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
    | 'browserlessApiUrl'
    | 'allowedApiUrlHosts'
    | 'supabaseUrl'
    | 'supabaseServiceRoleKey'
  >,
): Promise<ResolvedBrowserlessAuth> => {
  const override = input.apiUrlHeader ?? input.browserlessUrlQuery;
  if (override !== undefined) assertAllowedApiUrl(override, config);
  const apiUrl = override ?? config.browserlessApiUrl;

  // A pre-created session id to attach to, threaded by the autologin runner.
  // The agent tool opens /chromium/agent?sessionId=<this> instead of doing its
  // own POST /profile.
  const attachSessionId = input.sessionIdHeader ?? input.sessionIdQuery;

  // Analytics-only origin tag set by our own callers; absent for external LLMs.
  const source = input.sourceHeader ?? input.sourceQuery;

  const headerToken = input.authHeader?.startsWith('Bearer ')
    ? input.authHeader.slice(7)
    : input.authHeader;

  // JWTs have 3 dot-separated base64url segments; plain API keys do not.
  const isJwt = headerToken ? headerToken.split('.').length === 3 : false;

  // A plain key (header or ?token=) is used directly and wins over JWT exchange.
  const plainKey = (isJwt ? undefined : headerToken) ?? input.tokenQuery;
  if (plainKey) {
    return { token: plainKey, apiUrl, attachSessionId, source };
  }

  // A JWT is exchanged for the account's Browserless API key via PostgREST.
  if (isJwt && headerToken) {
    const { apiKey, accountId } = await resolveApiKey(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      headerToken,
    );
    return { token: apiKey, apiUrl, attachSessionId, source, accountId };
  }

  throw new Error(
    'No Browserless API token provided. ' +
      'Pass it as Authorization: Bearer <token> header, ' +
      '?token= query parameter, or authenticate via OAuth.',
  );
};

export const resolveBrowserlessRequestAuth = (
  request: IncomingMessage,
  config: McpConfig,
): Promise<ResolvedBrowserlessAuth> => {
  const params = new URLSearchParams(request.url?.split('?')[1] ?? '');
  return resolveBrowserlessAuth(
    {
      authHeader: request.headers.authorization as string | undefined,
      tokenQuery: params.get('token') || undefined,
      apiUrlHeader: request.headers['x-browserless-api-url'] as
        string | undefined,
      browserlessUrlQuery: params.get('browserlessUrl') || undefined,
      sessionIdHeader: request.headers['x-browserless-session-id'] as
        string | undefined,
      sessionIdQuery: params.get('browserlessSessionId') || undefined,
      sourceHeader: request.headers['x-browserless-mcp-source'] as
        string | undefined,
      sourceQuery: params.get('mcpSource') || undefined,
    },
    config,
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
  } catch (error) {
    if (error instanceof InvalidApiUrlError) {
      return c.json({ ok: false, error: 'Invalid x-browserless-api-url' }, 400);
    }
    return c.json({ ok: false, error: 'Unauthorized' }, 401);
  }
};
