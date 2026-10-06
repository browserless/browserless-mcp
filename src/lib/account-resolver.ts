import { createHash } from 'node:crypto';
import { ResponseCache } from './cache.js';
import type { SupabaseJwtPayload } from '../@types/types.js';

interface ResolvedAccount {
  apiKey: string;
  email: string;
  accountId: string;
  userId: string;
  userRole: 'owner' | 'admin' | 'viewer';
}

type CachedAccount = Omit<ResolvedAccount, 'userId' | 'userRole'>;

interface VerifiedOwner {
  accountId: string;
  userId: string;
  userRole: 'owner' | 'admin' | 'viewer';
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// accountId -> {apiKey,email}: the (stable, non-security) PostgREST row lookup.
const cache = new ResponseCache(CACHE_TTL_MS);

// full-token-hash -> verified user/account identity: caches the Supabase
// verification so a token isn't re-verified on every request.
// Entries are capped by token expiry. Revocation can still take up to 5 min
// to propagate before the next request re-verifies.
// Key is a FULL SHA-256 (not truncated)
// so distinct tokens can't collide onto the same verified accountId.
const verifyCache = new ResponseCache(CACHE_TTL_MS);

const fullHash = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

// Unverified claims may only shorten caching after Supabase accepts the token.
function tokenExpiryMs(accessToken: string): number | undefined {
  try {
    const { exp } = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    );
    return typeof exp === 'number' && Number.isFinite(exp)
      ? exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

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
): Promise<VerifiedOwner> {
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
  const userId = user.id;
  if (!userId) {
    throw new Error('Supabase user response does not contain an id.');
  }
  const accountId = user.app_metadata?.accountId;
  if (!accountId) {
    throw new Error(
      'Supabase JWT does not contain app_metadata.accountId. ' +
        'The user may not have a Browserless account.',
    );
  }
  const role = user.app_metadata?.role;
  if (role !== 'owner' && role !== 'admin' && role !== 'viewer') {
    throw new Error('Supabase user does not contain a valid account role.');
  }
  return { accountId, userId, userRole: role };
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
  // Resolve the verified user/account identity from the short-lived cache when
  // warm, otherwise by calling Supabase Auth. A failed verification
  // throws and is never cached, so a forged token can't poison the cache.
  const verifyKey = fullHash(accessToken);
  let verified = verifyCache.get<VerifiedOwner>(verifyKey);
  // The shared cache includes its deadline; JWT expiry is exclusive.
  if (verified && (tokenExpiryMs(accessToken) ?? Infinity) <= Date.now()) {
    verified = undefined;
  }
  if (!verified) {
    verified = await verifyAccessToken(
      supabaseUrl,
      serviceRoleKey,
      accessToken,
    );
    const expMs = tokenExpiryMs(accessToken);
    const ttl =
      expMs === undefined
        ? CACHE_TTL_MS
        : Math.min(CACHE_TTL_MS, expMs - Date.now());
    if (ttl > 0) {
      verifyCache.set(verifyKey, verified, ttl);
    }
  }
  const { accountId, userId, userRole } = verified;

  // Cache the stable accountId -> {apiKey,email} PostgREST lookup, keyed by the
  // verified account UUID.
  const cacheKey = `account:${accountId}`;
  const cached = cache.get<CachedAccount>(cacheKey);
  if (cached) {
    return { ...cached, userId, userRole };
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

  const resolved: CachedAccount = {
    apiKey: account.api_key,
    email: account.email,
    accountId,
  };

  cache.set(cacheKey, resolved);
  return { ...resolved, userId, userRole };
}

export function clearResolverCache(): void {
  cache.clear();
  verifyCache.clear();
}
