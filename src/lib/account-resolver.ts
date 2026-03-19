import { ResponseCache } from './cache.js';

interface ResolvedAccount {
  apiKey: string;
  email: string;
}

interface SupabaseJwtPayload {
  sub?: string;
  email?: string;
  app_metadata?: {
    accountId?: string;
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new ResponseCache(CACHE_TTL_MS);

function decodeJwtPayload(jwt: string): SupabaseJwtPayload {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload) as SupabaseJwtPayload;
}

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
