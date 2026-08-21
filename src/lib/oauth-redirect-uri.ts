import {
  OAuthProxy,
  OAuthProxyError,
  type AuthorizationParams,
  type DCRRequest,
  type DCRResponse,
  type OAuthProxyConfig,
} from 'fastmcp/auth';

const SAFE_DEFAULT_PATTERNS = ['http://localhost:*', 'http://127.0.0.1:*'];

const LOOPBACK_PATTERN_HOSTS = new Map([
  ['http://localhost:', 'localhost'],
  ['http://127.0.0.1:', '127.0.0.1'],
]);

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`);
}

function hasExpectedLoopbackHost(uri: URL, pattern: string): boolean {
  for (const [prefix, hostname] of LOOPBACK_PATTERN_HOSTS) {
    if (pattern.startsWith(prefix)) return uri.hostname === hostname;
  }
  return true;
}

export function isAllowedOAuthRedirectUri(
  redirectUri: string,
  patterns: string[] | undefined,
): boolean {
  let uri: URL;
  try {
    uri = new URL(redirectUri);
  } catch {
    return false;
  }

  if (uri.username || uri.password) return false;
  if (Array.isArray(patterns) && patterns.length === 0) return false;

  return (patterns ?? SAFE_DEFAULT_PATTERNS).some(
    (pattern) =>
      hasExpectedLoopbackHost(uri, pattern) &&
      globToRegExp(pattern).test(redirectUri),
  );
}

export class BrowserlessOAuthProxy extends OAuthProxy {
  private readonly allowedRedirectUriPatterns: string[] | undefined;

  constructor(config: OAuthProxyConfig) {
    super(config);
    this.allowedRedirectUriPatterns = config.allowedRedirectUriPatterns;
  }

  override async registerClient(request: DCRRequest): Promise<DCRResponse> {
    for (const redirectUri of request.redirect_uris) {
      if (
        !isAllowedOAuthRedirectUri(redirectUri, this.allowedRedirectUriPatterns)
      ) {
        throw new OAuthProxyError(
          'invalid_redirect_uri',
          `Invalid redirect URI: ${redirectUri}`,
        );
      }
    }
    return super.registerClient(request);
  }

  override async authorize(params: AuthorizationParams): Promise<Response> {
    if (
      !isAllowedOAuthRedirectUri(
        params.redirect_uri,
        this.allowedRedirectUriPatterns,
      )
    ) {
      throw new OAuthProxyError(
        'invalid_request',
        'redirect_uri is not allowed',
      );
    }
    return super.authorize(params);
  }
}
