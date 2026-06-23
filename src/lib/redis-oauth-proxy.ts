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
    // We return upstream tokens directly (no token swap); fail fast otherwise.
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
    // Store the client's redirect_uris under the issued client_id so any
    // instance can validate per-client (the parent's Map is process-local).
    const response = await super.registerClient(request);
    const ttl =
      this._internal.config.clientRegistrationTtl ?? DEFAULT_CLIENT_TTL;
    await this.redis.set(
      `${CLIENT_ID_PREFIX}${response.client_id}`,
      JSON.stringify(response.redirect_uris),
      'EX',
      ttl,
    );
    return response;
  }

  private async getClientRedirectUris(
    clientId: string,
  ): Promise<string[] | null> {
    const json = await this.redis.get(`${CLIENT_ID_PREFIX}${clientId}`);
    return json ? (JSON.parse(json) as string[]) : null;
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
    // redirect_uri must be one registered for THIS client_id — a global check
    // would let any client pair with any other's URI (CWE-601).
    const registeredUris = await this.getClientRedirectUris(params.client_id);
    if (!registeredUris) {
      throw new OAuthProxyError('invalid_client', 'Unknown client_id');
    }
    if (!registeredUris.includes(params.redirect_uri)) {
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

    // Defense-in-depth: the callback URL must still be bound to this client
    // (guards against mid-flow DCR revocation/expiry).
    const txUris = await this.getClientRedirectUris(transaction.clientId);
    if (!txUris || !txUris.includes(transaction.clientCallbackUrl)) {
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
    // generateAuthorizationCode just populated the Map; if a cleanup race
    // emptied it, fail loud rather than redirect with an unpersisted code.
    if (!codeData) {
      throw new OAuthProxyError(
        'server_error',
        'Failed to persist authorization code',
      );
    }
    const codeTtl =
      this._internal.config.authorizationCodeTtl || DEFAULT_CODE_TTL;
    await this.redis.set(
      `${CODE_PREFIX}${clientCode}`,
      serialize(codeData),
      'EX',
      codeTtl,
    );
    this._internal.clientCodes.delete(clientCode);

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
    // Reject unknown clients here too; the code↔client binding below enforces
    // that only the owning client can redeem the code.
    if (!(await this.getClientRedirectUris(request.client_id))) {
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
    // PKCE inline, not via super (the parent re-checks client_id against a
    // process-local Map). One-time-use is enforced by the GETDEL above, not the
    // parent's `used` flag.
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
}
