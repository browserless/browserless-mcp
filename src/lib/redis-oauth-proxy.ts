import { Redis } from 'ioredis';
import {
  OAuthProxy,
  OAuthProxyError,
  PKCEUtils,
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
 * Redis-backed OAuthProxy using Redis as the single source of truth for OAuth
 * flow state (transactions, authorization codes, DCRs), so the steps of one
 * flow can land on different instances behind a load balancer.
 *
 * fastmcp v4 (CWE-601 hardening) made DCR state load-bearing for authorize(),
 * handleCallback(), and handleConsent(), all checking a process-local Map.
 * That breaks multi-instance (DCR on A, authorize on B → B rejects a valid
 * redirect_uri), so the overrides here validate against Redis instead and
 * ignore the parent's Map (super.registerClient still fills it; we never read it).
 *
 * Consent is NOT supported — the parent's handleConsent uses a process-local
 * Map; the constructor throws if it's enabled. Requires Redis 6.2+ / Valkey 7+
 * for GETDEL (atomic one-time-use of authorization codes across instances).
 */

const KEY_PREFIX = 'mcp:oauth:';
const TX_PREFIX = `${KEY_PREFIX}tx:`;
const CODE_PREFIX = `${KEY_PREFIX}code:`;
const CLIENT_PREFIX = `${KEY_PREFIX}client:`;
const CLIENT_ID_PREFIX = `${KEY_PREFIX}client-id:`;

const DEFAULT_TRANSACTION_TTL = 600;
const DEFAULT_CODE_TTL = 300;
// DCR clients are reused for weeks; a short TTL would expire one mid-life.
const DEFAULT_CLIENT_TTL = 90 * 24 * 60 * 60;

const DATE_FIELDS = new Set(['createdAt', 'expiresAt', 'issuedAt']);

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
  createTransaction(params: AuthorizationParams): Promise<OAuthTransaction>;
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
    // exchangeAuthorizationCode() returns the upstream tokens directly; it does
    // not implement token swap. Fail fast rather than silently issue raw tokens
    // while the parent's refresh path would swap them.
    if ((this as unknown as OAuthProxyInternals).config.enableTokenSwap) {
      throw new Error(
        'RedisOAuthProxy requires enableTokenSwap: false — token-swap mode is not supported',
      );
    }
  }

  private get _internal(): OAuthProxyInternals {
    return this as unknown as OAuthProxyInternals;
  }

  override async registerClient(request: DCRRequest): Promise<DCRResponse> {
    // Delegate validation/response to the parent, then mirror the accepted
    // URIs into Redis so every instance can honor the v4 redirect_uri check.
    // (The parent's in-memory Map is also populated but we never read it.)
    const response = await super.registerClient(request);
    const ttl =
      this._internal.config.clientRegistrationTtl ?? DEFAULT_CLIENT_TTL;

    // Snapshot pre-existence so rollback doesn't DEL a valid prior
    // registration of the same URI (two DCR calls sharing a redirect_uri).
    // allSettled → a probe failure is fail-fast with no writes attempted.
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
          (p): p is PromiseFulfilledResult<{ uri: string; existed: boolean }> =>
            p.status === 'fulfilled' && p.value.existed,
        )
        .map((p) => p.value.uri),
    );

    // Mirror the redirect_uris and the issued client_id so authorize/token can
    // validate both across instances. The client_id is freshly generated, so
    // rolling it back on failure can never drop a prior registration.
    const clientIdKey = `${CLIENT_ID_PREFIX}${response.client_id}`;
    const writes = await Promise.allSettled([
      ...response.redirect_uris.map((uri) =>
        this.redis.set(`${CLIENT_PREFIX}${uri}`, '1', 'EX', ttl),
      ),
      this.redis.set(clientIdKey, '1', 'EX', ttl),
    ]);
    const writeFailed = writes.find(
      (w): w is PromiseRejectedResult => w.status === 'rejected',
    );
    if (writeFailed) {
      // Best-effort cleanup of Redis keys this call introduced; if these
      // deletes also fail the originating error still wins.
      await Promise.allSettled([
        ...response.redirect_uris
          .filter((uri) => !redisPreExisting.has(uri))
          .map((uri) => this.redis.del(`${CLIENT_PREFIX}${uri}`)),
        this.redis.del(clientIdKey),
      ]);
      throw writeFailed.reason;
    }

    return response;
  }

  private async keyExists(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }

  private isClientRegistered(uri: string): Promise<boolean> {
    return this.keyExists(`${CLIENT_PREFIX}${uri}`);
  }

  private isClientIdRegistered(clientId: string): Promise<boolean> {
    return this.keyExists(`${CLIENT_ID_PREFIX}${clientId}`);
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
    // client_id must be a DCR client — check shared Redis, not a process-local
    // Map, so it holds when authorize lands on a different instance than DCR.
    if (!(await this.isClientIdRegistered(params.client_id))) {
      throw new OAuthProxyError('invalid_client', 'Unknown client_id');
    }
    // RFC 6749 §3.1.2.3 / RFC 6819 §4.1.5 — redirect_uri must be one
    // previously registered via DCR; skipping this is CWE-601 (auth-code
    // theft). We read the shared Redis registry so cross-instance DCR counts.
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
    const ttl = this._internal.config.transactionTtl || DEFAULT_TRANSACTION_TTL;
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
      throw new OAuthProxyError('invalid_request', 'Invalid or expired state');
    }
    const transaction = deserialize<OAuthTransaction>(txJson);

    // Defense-in-depth: reject if the transaction's stored callback URL is no
    // longer registered. Guards against DCR revocation mid-flow and any path
    // that could have persisted an unvalidated URI.
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
    // Reject unknown clients here too (shared Redis); the code↔client binding
    // below enforces that only the owning client can redeem the code.
    if (!(await this.isClientIdRegistered(request.client_id))) {
      throw new OAuthProxyError('invalid_client', 'Unknown client_id');
    }

    // Atomically read-and-delete the code. The parent's in-memory `used` flag
    // can't work across instances (two concurrent redemptions on different
    // instances both see it valid); GETDEL makes the consume race-free.
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
    // PKCE inline, not via super: the parent re-checks client_id against a
    // process-local Map. enableTokenSwap is false, so the response below
    // equals what super would return.
    if (clientCode.codeChallenge) {
      if (!request.code_verifier) {
        throw new OAuthProxyError(
          'invalid_request',
          'code_verifier required for PKCE',
        );
      }
      if (
        !PKCEUtils.validateChallenge(
          request.code_verifier,
          clientCode.codeChallenge,
          clientCode.codeChallengeMethod,
        )
      ) {
        throw new OAuthProxyError('invalid_grant', 'Invalid PKCE verifier');
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
    if (clientCode.upstreamTokens.idToken) {
      response.id_token = clientCode.upstreamTokens.idToken;
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
