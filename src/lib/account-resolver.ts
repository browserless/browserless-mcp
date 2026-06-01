import { ResponseCache } from './cache.js';
import { decodeJwtPayload } from './utils.js';

interface ResolvedAccount {
  apiKey: string;
  email: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new ResponseCache(CACHE_TTL_MS);

/**
 * Resolves a Browserless API key from a Supabase access token (JWT)
 * by extracting app_metadata.accountId and querying Supabase PostgREST.
 */
export async function resolveApiKey(
  supabaseUrl: string,
  serviceRoleKey: string,
  accessToken: string,
): Promise<ResolvedAccount> {
  const payload = decodeJwtPayload(accessToken);
  const accountId = payload.app_metadata?.accountId;

  if (!accountId) {
    throw new Error(
      'Supabase JWT does not contain app_metadata.accountId. ' +
        'The user may not have a Browserless account.',
    );
  }

  const cached = cache.get<ResolvedAccount>(`account:${accountId}`);
  if (cached) {
    return cached;
  }

  const url = `${supabaseUrl}/rest/v1/accounts?account_id=eq.${encodeURIComponent(accountId)}&select=api_key,email`;
  const response = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Supabase REST API returned ${response.status}: ${response.statusText}`,
    );
  }

  const rows = (await response.json()) as Array<{
    api_key?: string;
    email?: string;
  }>;
  const account = rows[0];

  if (!account?.api_key || !account?.email) {
    throw new Error('Account not found or missing api_key/email.');
  }

  const resolved: ResolvedAccount = {
    apiKey: account.api_key,
    email: account.email,
  };

  cache.set(`account:${accountId}`, resolved);
  return resolved;
}

export function clearResolverCache(): void {
  cache.clear();
}

/**
 * Patch `globalThis.fetch` to extend `expires_in` on Supabase OAuth token
 * responses so clients don't thrash refresh against the ~60s default. Global
 * because FastMCP's OAuthProxy has no fetch hook; matched origin/path-exact.
 */
export function installSupabaseTokenTtlPatch(
  supabaseUrl: string,
  ttlSeconds: number,
): void {
  const supabaseOrigin = new URL(supabaseUrl).origin;
  const TOKEN_PATHNAME = '/auth/v1/oauth/token';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await originalFetch(...args);
    const url =
      typeof args[0] === 'string'
        ? args[0]
        : args[0] instanceof URL
          ? args[0].toString()
          : (args[0] as Request).url;
    const reqUrl = new URL(url);
    if (
      !response.ok ||
      reqUrl.origin !== supabaseOrigin ||
      reqUrl.pathname !== TOKEN_PATHNAME
    ) {
      return response;
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.expires_in === 'number' && body.expires_in < ttlSeconds) {
      body.expires_in = ttlSeconds;
    }
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
