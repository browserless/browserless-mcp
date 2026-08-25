import {
  OAuthProxy,
  OAuthProxyError,
  type AuthorizationParams,
  type DCRRequest,
  type DCRResponse,
  type OAuthProxyConfig,
} from 'fastmcp/auth';

// Mirrors FastMCP's defaults for callers that omit an explicit allowlist.
const SAFE_DEFAULT_PATTERNS = ['http://localhost:*', 'http://127.0.0.1:*'];

const AUTHORITY_WITH_USERINFO = /^\s*[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i;
const URL_PATTERN =
  /^([a-z][a-z\d+.-]*):\/\/(\[[^\]]+\]|[^:/?#@]+)(?::([^/?#]*))?(.*)$/;

const LOOPBACK_PATTERN_HOSTS = new Map([
  ['http://localhost', 'localhost'],
  ['http://127.0.0.1', '127.0.0.1'],
]);

function globComponentToRegExp(
  component: string,
  wildcardCharacter: string,
): string {
  return [...component]
    .map((character) => {
      if (character === '*') return `${wildcardCharacter}*`;
      if (character === '?') return wildcardCharacter;
      return character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    })
    .join('');
}

function globToRegExp(pattern: string): RegExp | undefined {
  const match = URL_PATTERN.exec(pattern);
  if (!match) return;

  const [, scheme, hostnamePattern, portPattern, suffix] = match;
  if (portPattern === '') return;

  const hostname = globComponentToRegExp(hostnamePattern, '[^./:@]');
  const port =
    portPattern === undefined
      ? ''
      : `:${globComponentToRegExp(portPattern, '\\d')}`;
  const allowsAnyLoopbackPath =
    scheme.toLowerCase() === 'http' &&
    ['localhost', '127.0.0.1'].includes(hostnamePattern.toLowerCase()) &&
    portPattern === '*' &&
    suffix === '';
  // Two different rules, because the two cases carry different risk.
  //
  // Loopback is host-pinned by hasExpectedLoopbackHost, so whatever follows
  // the port reaches the user's own machine and can never reach an attacker.
  // Stay permissive: a desktop client picks its own callback path, and it may
  // sit at the root with only a query ('http://localhost:3000?state=1'). A
  // false negative here breaks a login for no security gain.
  //
  // Everywhere else the wildcard must stop at the query or fragment
  // delimiter, or 'https://client.example/cb/*' would also accept
  // '.../cb/x?next=...' and '.../cb/x#...'. RFC 6749 3.1.2 forbids a fragment
  // on a redirect endpoint outright, and a pattern can never spell a literal
  // query anyway because '?' is the single-character glob.
  const path = allowsAnyLoopbackPath
    ? '(?:[/?#].*)?'
    : globComponentToRegExp(suffix, '[^/?#]');
  return new RegExp(
    `^${globComponentToRegExp(scheme, '[^:]')}://${hostname}${port}${path}$`,
  );
}

function hasExpectedLoopbackHost(uri: URL, pattern: string): boolean {
  for (const [prefix, hostname] of LOOPBACK_PATTERN_HOSTS) {
    if (!pattern.toLowerCase().startsWith(prefix)) continue;
    const nextCharacter = pattern.at(prefix.length);
    if ([':', '*', '?'].includes(nextCharacter ?? '')) {
      return uri.hostname === hostname;
    }
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

  if (
    AUTHORITY_WITH_USERINFO.test(redirectUri) ||
    uri.username ||
    uri.password
  ) {
    return false;
  }
  if (Array.isArray(patterns) && patterns.length === 0) return false;

  return (patterns ?? SAFE_DEFAULT_PATTERNS).some((pattern) => {
    const matcher = globToRegExp(pattern);
    return (
      matcher !== undefined &&
      hasExpectedLoopbackHost(uri, pattern) &&
      matcher.test(redirectUri)
    );
  });
}

export class BrowserlessOAuthProxy extends OAuthProxy {
  // OAuthProxy's normalized config is private, so retain this field for both
  // public validation seams.
  private readonly allowedRedirectUriPatterns: string[] | undefined;

  constructor(config: OAuthProxyConfig) {
    super(config);
    this.allowedRedirectUriPatterns = config.allowedRedirectUriPatterns;
  }

  override async registerClient(request: DCRRequest): Promise<DCRResponse> {
    const redirectUris = request?.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.some((redirectUri) => typeof redirectUri !== 'string')
    ) {
      throw new OAuthProxyError(
        'invalid_client_metadata',
        'redirect_uris must be a non-empty array of strings',
      );
    }

    for (const redirectUri of redirectUris) {
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
