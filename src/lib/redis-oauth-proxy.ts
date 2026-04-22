import { Redis } from 'ioredis';
import {
  OAuthProxy,
  OAuthProxyError,
  type AuthorizationParams,
  type ClientCode,
  type DCRRequest,
  type DCRResponse,
  type OAuthProxyConfig,
  type OAuthTransaction,
  type TokenRequest,
  type TokenResponse,
  type UpstreamTokenSet,
} from 'fastmcp/auth';

/**
 * Redis-backed OAuthProxy that uses Redis as the single source of truth for
 * OAuth flow state (transactions, authorization codes, and Dynamic Client
 * Registrations).
 *
 * Multi-instance flows supported behind a load balancer:
 *   1. registerClient() on Instance A  → DCR record written to Redis
 *   2. authorize() on Instance B       → validates redirect_uri against Redis
 *   3. handleCallback() on Instance C  → reads transaction from Redis
 *   4. exchangeAuthorizationCode() on Instance D → reads code from Redis
 *
 * fastmcp v4.0.0 (CWE-601 hardening) made DCR state load-bearing for
 * authorize(), handleCallback(), and handleConsent() — all three check
 * `registeredClients.has(uri)` against an in-memory Map. That Map is
 * process-local, so a naive multi-instance deployment breaks: DCR on A,
 * authorize on B → B rejects the legitimate redirect_uri.
 *
 * We resolve this by ignoring the parent's Map entirely and validating
 * against Redis in the three override paths. `super.registerClient` still
 * populates the parent Map as a side effect; we don't read from it, so its
 * state is irrelevant to correctness.
 *
 * Consent is explicitly NOT supported. The parent's handleConsent reads
 * transactions from a process-local Map, which would reintroduce the
 * multi-instance bug, and our authorize() override short-circuits the
 * consent branch regardless. The constructor throws if consent is enabled.
 *
 * Storage requirements: Redis 6.2+ or Valkey 7+. The token-exchange path uses
 * GETDEL for atomic one-time-use of authorization codes across instances;
 * that command landed in Redis 6.2 and has been in every Valkey release.
 */

const KEY_PREFIX = 'mcp:oauth:';
const TX_PREFIX = `${KEY_PREFIX}tx:`;
const CODE_PREFIX = `${KEY_PREFIX}code:`;
const CLIENT_PREFIX = `${KEY_PREFIX}client:`;

const DEFAULT_TRANSACTION_TTL = 600;
const DEFAULT_CODE_TTL = 300;
const DEFAULT_CLIENT_TTL = 3600;

const DATE_FIELDS = new Set([
  'createdAt',
  'expiresAt',
  'issuedAt',
]);

function serialize(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => {
    if (value instanceof Date) return { __date: value.toISOString() };
    return value;
  });
}

function deserialize<T>(json: string): T {
  return JSON.parse(json, (key, value) => {
    if (value && typeof value === 'object' && '__date' in value) {
      return new Date(value.__date as string);
    }
    if (DATE_FIELDS.has(key) && typeof value === 'string') {
      return new Date(value);
    }
    return value;
  }) as T;
}

// Access TypeScript-private (but runtime-accessible) members of OAuthProxy
interface OAuthProxyInternals {
  clientCodes: Map<string, ClientCode>;
  config: OAuthProxyConfig & {
    authorizationCodeTtl?: number;
    clientRegistrationTtl?: number;
    transactionTtl?: number;
  };
  createTransaction(
    params: AuthorizationParams,
  ): Promise<OAuthTransaction>;
  exchangeUpstreamCode(
    code: string,
    transaction: OAuthTransaction,
  ): Promise<UpstreamTokenSet>;
  generateAuthorizationCode(
    transaction: OAuthTransaction,
    upstreamTokens: UpstreamTokenSet,
  ): string;
  redirectToUpstream(transaction: OAuthTransaction): Response;
}

export class RedisOAuthProxy extends OAuthProxy {
  private redis: Redis;

  constructor(config: OAuthProxyConfig, redis: Redis) {
    super(config);
    this.redis = redis;
    // Our authorize() override short-circuits the parent's consent branch,
    // and the parent's handleConsent reads transactions from a process-local
    // Map which breaks in multi-instance. Fail fast if a caller opts in.
    if ((this as unknown as OAuthProxyInternals).config.consentRequired) {
      throw new Error(
        'RedisOAuthProxy requires consentRequired: false — consent flow is not supported in multi-instance mode',
      );
    }
  }

  private get _internal(): OAuthProxyInternals {
    return this as unknown as OAuthProxyInternals;
  }

  override async registerClient(request: DCRRequest): Promise<DCRResponse> {
    // Delegate validation and response synthesis to the parent, then mirror
    // the accepted URIs into Redis so every instance can honor the v4
    // redirect_uri check. The parent also populates its in-memory Map as a
    // side effect — we don't read from it, so its state doesn't affect
    // correctness and we don't need to keep it in sync.
    const response = await super.registerClient(request);
    const ttl =
      this._internal.config.clientRegistrationTtl ?? DEFAULT_CLIENT_TTL;

    // Snapshot Redis pre-existence so rollback doesn't DEL a valid prior
    // registration of the same URI (two DCR calls sharing a redirect_uri —
    // rare but possible). Use allSettled so a Redis failure here doesn't
    // escape as a raw probe error; treat probe failure as fail-fast with
    // no writes attempted.
    const probes = await Promise.allSettled(
      response.redirect_uris.map(async (uri) => ({
        uri,
        existed: (await this.redis.exists(`${CLIENT_PREFIX}${uri}`)) > 0,
      })),
    );
    const probeFailed = probes.find(
      (p): p is PromiseRejectedResult => p.status === 'rejected',
    );
    if (probeFailed) {
      throw probeFailed.reason;
    }
    const redisPreExisting = new Set<string>(
      probes
        .filter(
          (
            p,
          ): p is PromiseFulfilledResult<{ uri: string; existed: boolean }> =>
            p.status === 'fulfilled' && p.value.existed,
        )
        .map((p) => p.value.uri),
    );

    const writes = await Promise.allSettled(
      response.redirect_uris.map((uri) =>
        this.redis.set(`${CLIENT_PREFIX}${uri}`, '1', 'EX', ttl),
      ),
    );
    const writeFailed = writes.find(
      (w): w is PromiseRejectedResult => w.status === 'rejected',
    );
    if (writeFailed) {
      // Best-effort cleanup of Redis keys this call introduced; if these
      // deletes also fail the originating error still wins.
      await Promise.allSettled(
        response.redirect_uris
          .filter((uri) => !redisPreExisting.has(uri))
          .map((uri) => this.redis.del(`${CLIENT_PREFIX}${uri}`)),
      );
      throw writeFailed.reason;
    }

    return response;
  }

  private async isClientRegistered(uri: string): Promise<boolean> {
    return (await this.redis.exists(`${CLIENT_PREFIX}${uri}`)) === 1;
  }

  override async authorize(params: AuthorizationParams): Promise<Response> {
    if (!params.client_id || !params.redirect_uri || !params.response_type) {
      throw new OAuthProxyError(
        'invalid_request',
        'Missing required parameters',
      );
    }
    if (params.response_type !== 'code') {
      throw new OAuthProxyError(
        'unsupported_response_type',
        "Only 'code' response type is supported",
      );
    }
    // RFC 6749 §5.2 — reject any client_id other than the single upstream
    // identity this proxy fronts. Ported from fastmcp v4 OAuthProxy.authorize.
    if (params.client_id !== this._internal.config.upstreamClientId) {
      throw new OAuthProxyError('invalid_client', 'Unknown client_id');
    }
    // RFC 6749 §3.1.2.3 / RFC 6819 §4.1.5 — the redirect_uri must be one that
    // was previously registered via DCR. Skipping this is CWE-601: an attacker
    // can steal an authorization code by passing their own URL here. Ported
    // from fastmcp v4; we read the shared Redis registry so DCR on another
    // instance still satisfies the check.
    if (!(await this.isClientRegistered(params.redirect_uri))) {
      throw new OAuthProxyError(
        'invalid_request',
        'redirect_uri is not registered for this client',
      );
    }
    if (params.code_challenge && !params.code_challenge_method) {
      throw new OAuthProxyError(
        'invalid_request',
        'code_challenge_method required when code_challenge is present',
      );
    }

    const transaction = await this._internal.createTransaction(params);
    const ttl =
      this._internal.config.transactionTtl || DEFAULT_TRANSACTION_TTL;
    await this.redis.set(
      `${TX_PREFIX}${transaction.id}`,
      serialize(transaction),
      'EX',
      ttl,
    );

    return this._internal.redirectToUpstream(transaction);
  }

  override async handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      throw new OAuthProxyError(
        error,
        url.searchParams.get('error_description') || undefined,
      );
    }
    if (!code || !state) {
      throw new OAuthProxyError(
        'invalid_request',
        'Missing code or state parameter',
      );
    }

    const txJson = await this.redis.get(`${TX_PREFIX}${state}`);
    if (!txJson) {
      throw new OAuthProxyError(
        'invalid_request',
        'Invalid or expired state',
      );
    }
    const transaction = deserialize<OAuthTransaction>(txJson);

    // Defense-in-depth (ported from fastmcp v4 OAuthProxy.handleCallback):
    // reject if the transaction's stored callback URL is no longer registered.
    // Guards against DCR revocation mid-flow and against any code path that
    // could have persisted an unvalidated URI.
    if (!(await this.isClientRegistered(transaction.clientCallbackUrl))) {
      await this.redis.del(`${TX_PREFIX}${state}`);
      throw new OAuthProxyError(
        'invalid_request',
        'Transaction callback URL is not registered',
      );
    }

    const upstreamTokens = await this._internal.exchangeUpstreamCode(
      code,
      transaction,
    );

    // generateAuthorizationCode writes to the in-memory clientCodes Map.
    // We read from it, persist to Redis, then clean up the Map entry.
    const clientCode = this._internal.generateAuthorizationCode(
      transaction,
      upstreamTokens,
    );
    const codeData = this._internal.clientCodes.get(clientCode);
    if (codeData) {
      const codeTtl =
        this._internal.config.authorizationCodeTtl || DEFAULT_CODE_TTL;
      await this.redis.set(
        `${CODE_PREFIX}${clientCode}`,
        serialize(codeData),
        'EX',
        codeTtl,
      );
      this._internal.clientCodes.delete(clientCode);
    }

    // Remove consumed transaction
    await this.redis.del(`${TX_PREFIX}${state}`);

    const redirectUrl = new URL(transaction.clientCallbackUrl);
    redirectUrl.searchParams.set('code', clientCode);
    redirectUrl.searchParams.set('state', transaction.state);
    return new Response(null, {
      headers: { Location: redirectUrl.toString() },
      status: 302,
    });
  }

  override async exchangeAuthorizationCode(
    request: TokenRequest,
  ): Promise<TokenResponse> {
    if (request.grant_type !== 'authorization_code') {
      throw new OAuthProxyError(
        'unsupported_grant_type',
        'Only authorization_code grant type is supported',
      );
    }
    // RFC 6749 §5.2 — reject unknown clients at token exchange too, so a
    // stolen authorization code cannot be redeemed by an arbitrary caller.
    // Ported from fastmcp v4 OAuthProxy.exchangeAuthorizationCode.
    if (request.client_id !== this._internal.config.upstreamClientId) {
      throw new OAuthProxyError('invalid_client', 'Unknown client_id');
    }

    // Atomically read-and-delete the code. The parent enforces one-time use
    // via an in-memory `used` flag, which can't work across instances: two
    // concurrent redemptions hitting different instances would both see the
    // code as valid before either could persist `used=true`. GETDEL makes the
    // consume race-free — only one redemption can pull a value, regardless of
    // instance.
    const codeJson = await this.redis.getdel(`${CODE_PREFIX}${request.code}`);
    if (!codeJson) {
      throw new OAuthProxyError(
        'invalid_grant',
        'Invalid or expired authorization code',
      );
    }
    const clientCode = deserialize<ClientCode>(codeJson);

    if (clientCode.clientId !== request.client_id) {
      throw new OAuthProxyError('invalid_client', 'Client ID mismatch');
    }
    if (clientCode.codeChallenge && !request.code_verifier) {
      throw new OAuthProxyError(
        'invalid_request',
        'code_verifier required for PKCE',
      );
    }
    if (clientCode.codeChallenge && request.code_verifier) {
      // Delegate PKCE validation to parent by placing code in Map temporarily.
      // Redis key is already consumed by GETDEL above, so no additional del
      // is needed in finally — only the local Map cleanup.
      this._internal.clientCodes.set(request.code, clientCode);
      try {
        return await super.exchangeAuthorizationCode(request);
      } finally {
        this._internal.clientCodes.delete(request.code);
      }
    }

    const response: TokenResponse = {
      access_token: clientCode.upstreamTokens.accessToken,
      expires_in: clientCode.upstreamTokens.expiresIn,
      token_type: clientCode.upstreamTokens.tokenType,
    };
    if (clientCode.upstreamTokens.refreshToken) {
      response.refresh_token = clientCode.upstreamTokens.refreshToken;
    }
    if (clientCode.upstreamTokens.scope?.length > 0) {
      response.scope = clientCode.upstreamTokens.scope.join(' ');
    }
    return response;
  }

  override destroy(): void {
    super.destroy();
  }
}
