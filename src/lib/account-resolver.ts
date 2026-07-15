import { createHash } from 'node:crypto';
import { ResponseCache } from './cache.js';
import type { SupabaseJwtPayload } from '../@types/types.js';

interface ResolvedAccount {
  apiKey: string;
  email: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// accountId -> {apiKey,email}: the (stable, non-security) PostgREST row lookup.
const cache = new ResponseCache(CACHE_TTL_MS);

// full-token-hash -> verified accountId: caches the Supabase verification so a
// token that keeps hitting the server isn't re-verified on every request.
// TRADEOFF: a token revoked/expired at Supabase keeps resolving for up to this
// TTL before the entry ages out and the next request re-verifies. 5 min is an
// accepted window (access tokens are short-lived); shorten it if faster
// revocation propagation is ever needed. Key is a FULL SHA-256 (not truncated)
// so distinct tokens can't collide onto the same verified accountId.
const verifyCache = new ResponseCache(CACHE_TTL_MS);

const fullHash = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

// Upper bound on any single Supabase call. Without it a slow/unresponsive
// Supabase would hang the whole auth path (and the request holding it) forever.
const SUPABASE_TIMEOUT_MS = 5000;

/** `fetch` bounded by an AbortController so it can never hang indefinitely. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify a Supabase access token by presenting it to Supabase Auth's
 * `/auth/v1/user` endpoint (hosted Supabase in prod, the local Supabase stack
 * in dev — same REST surface). Supabase Auth checks the JWT signature, expiry,
 * and revocation server-side and returns the authoritative user record. We
 * deliberately do NOT decode and trust the token payload client-side: an
 * unsigned/forged token with an attacker-chosen `app_metadata.accountId` would
 * otherwise resolve to any account's API key. The `accountId` we act on comes
 * only from this verified response.
 */
async function verifyAccessToken(
  supabaseUrl: string,
  serviceRoleKey: string,
  accessToken: string,
): Promise<string> {
  // Cheap format guard so obviously-malformed input fails fast without a round
  // trip. GoTrue is still the authority on validity below.
  if (accessToken.split('.').length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const response = await fetchWithTimeout(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Supabase rejected the access token (${response.status}). ` +
        'The token is invalid, expired, or not signed by this project.',
    );
  }

  const user = (await response.json()) as SupabaseJwtPayload;
  const accountId = user.app_metadata?.accountId;
  if (!accountId) {
    throw new Error(
      'Supabase JWT does not contain app_metadata.accountId. ' +
        'The user may not have a Browserless account.',
    );
  }
  return accountId;
}

/**
 * Resolves a Browserless API key from a Supabase access token (JWT) by
 * verifying the token with Supabase Auth, then querying Supabase PostgREST for
 * the verified account's `api_key`.
 */
export async function resolveApiKey(
  supabaseUrl: string,
  serviceRoleKey: string,
  accessToken: string,
): Promise<ResolvedAccount> {
  // Resolve the verified accountId from the token — from the short-lived verify
  // cache if warm, otherwise by calling Supabase Auth. A failed verification
  // throws and is never cached, so a forged token can't poison the cache.
  const verifyKey = fullHash(accessToken);
  let accountId = verifyCache.get<string>(verifyKey);
  if (!accountId) {
    accountId = await verifyAccessToken(supabaseUrl, serviceRoleKey, accessToken);
    verifyCache.set(verifyKey, accountId);
  }

  // Cache the stable accountId -> {apiKey,email} PostgREST lookup, keyed by the
  // verified account UUID.
  const cacheKey = `account:${accountId}`;
  const cached = cache.get<ResolvedAccount>(cacheKey);
  if (cached) {
    return cached;
  }

  const url = `${supabaseUrl}/rest/v1/accounts?account_id=eq.${encodeURIComponent(accountId)}&select=api_key,email`;
  const response = await fetchWithTimeout(url, {
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

  cache.set(cacheKey, resolved);
  return resolved;
}

export function clearResolverCache(): void {
  cache.clear();
  verifyCache.clear();
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
