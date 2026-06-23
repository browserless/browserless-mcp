import { resolveApiKey } from './account-resolver.js';
import type { McpConfig } from '../@types/types.js';

export interface ResolvedBrowserlessAuth {
  token: string;
  apiUrl: string;
  attachSessionId?: string;
}

export interface AuthInput {
  authHeader?: string;
  tokenQuery?: string;
  apiUrlHeader?: string;
  browserlessUrlQuery?: string;
  sessionIdHeader?: string;
  sessionIdQuery?: string;
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
    'browserlessApiUrl' | 'supabaseUrl' | 'supabaseServiceRoleKey'
  >,
): Promise<ResolvedBrowserlessAuth> => {
  const headerToken = input.authHeader?.startsWith('Bearer ')
    ? input.authHeader.slice(7)
    : input.authHeader;

  const apiUrl =
    input.apiUrlHeader ?? input.browserlessUrlQuery ?? config.browserlessApiUrl;

  // A pre-created session id to attach to, threaded by the autologin runner.
  // The agent tool opens /chromium/agent?sessionId=<this> instead of doing its
  // own POST /profile.
  const attachSessionId =
    input.sessionIdHeader ?? input.sessionIdQuery ?? undefined;

  // JWTs have 3 dot-separated base64url segments; plain API keys do not.
  const isJwt = headerToken ? headerToken.split('.').length === 3 : false;

  if (headerToken && !isJwt) {
    return { token: headerToken, apiUrl, attachSessionId };
  }
  if (input.tokenQuery) {
    return { token: input.tokenQuery, apiUrl, attachSessionId };
  }
  if (isJwt && headerToken) {
    const { apiKey } = await resolveApiKey(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      headerToken,
    );
    return { token: apiKey, apiUrl, attachSessionId };
  }

  throw new Error(
    'No Browserless API token provided. ' +
      'Pass it as Authorization: Bearer <token> header, ' +
      '?token= query parameter, or authenticate via OAuth.',
  );
};
