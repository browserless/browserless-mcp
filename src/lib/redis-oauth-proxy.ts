import { Redis } from 'ioredis';
import {
  OAuthProxy,
  OAuthProxyError,
  type AuthorizationParams,
  type ClientCode,
  type OAuthProxyConfig,
  type OAuthTransaction,
  type TokenRequest,
  type TokenResponse,
  type UpstreamTokenSet,
} from 'fastmcp/auth';

/**
 * Redis-backed OAuthProxy that stores OAuth flow state (transactions and
 * authorization codes) in Redis instead of in-memory Maps.
 *
 * This enables multi-instance deployments where the OAuth flow may span
 * different server instances behind a load balancer:
 *   1. authorize() on Instance A → stores transaction in Redis
 *   2. handleCallback() on Instance B → reads transaction from Redis
 *   3. exchangeAuthorizationCode() on Instance A → reads code from Redis
 *
 * registerClient and handleConsent are NOT overridden because:
 * - registeredClients Map is write-only (never read by other methods)
 * - consentRequired is false in our config
 */

const KEY_PREFIX = 'mcp:oauth:';
const TX_PREFIX = `${KEY_PREFIX}tx:`;
const CODE_PREFIX = `${KEY_PREFIX}code:`;

const DEFAULT_TRANSACTION_TTL = 600;
const DEFAULT_CODE_TTL = 300;

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
  }

  private get _internal(): OAuthProxyInternals {
    return this as unknown as OAuthProxyInternals;
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

    const codeJson = await this.redis.get(`${CODE_PREFIX}${request.code}`);
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
      // Delegate PKCE validation to parent by placing code in Map temporarily
      this._internal.clientCodes.set(request.code, clientCode);
      try {
        return await super.exchangeAuthorizationCode(request);
      } finally {
        this._internal.clientCodes.delete(request.code);
        await this.redis.del(`${CODE_PREFIX}${request.code}`);
      }
    }
    if (clientCode.used) {
      throw new OAuthProxyError(
        'invalid_grant',
        'Authorization code already used',
      );
    }

    // One-time use: delete from Redis
    await this.redis.del(`${CODE_PREFIX}${request.code}`);

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
