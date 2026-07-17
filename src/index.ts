import type { IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastMCP, OAuthProvider } from 'fastmcp';
import { OAuthProxy } from 'fastmcp/auth';
import { getConfig, classifyComplianceInput } from './config.js';
import type { BrowserlessSession } from './@types/types.js';
import { registerSurface } from './tools/register.js';
import { registerUploadRoute } from './resources/upload-route.js';
import { registerDownloadRoute } from './resources/download-route.js';
import { clearSession } from './lib/download-store.js';
import { AnalyticsHelper } from './lib/analytics.js';
import { installSupabaseTokenTtlPatch } from './lib/account-resolver.js';
import { resolveBrowserlessAuth } from './lib/http-auth.js';
import { BoundedEventStore } from './lib/bounded-event-store.js';
import { RedisOAuthProxy } from './lib/redis-oauth-proxy.js';
import { Redis } from 'ioredis';

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
    'utf-8',
  ),
) as { version: `${number}.${number}.${number}` };

const config = getConfig();

// Override Supabase's short-lived (~60s) OAuth token TTL so MCP clients don't
// thrash refresh. Narrowly scoped to the Supabase token endpoint; see
// installSupabaseTokenTtlPatch in account-resolver.ts for the full rationale.
if (config.oauthEnabled && config.supabaseUrl) {
  installSupabaseTokenTtlPatch(config.supabaseUrl, 3600);
}

const analytics = new AnalyticsHelper(
  config.analyticsEnabled,
  config.sqsQueueUrl,
  config.sqsRegion,
);

// Passthrough OAuth provider: disables FastMCP's token-swap mode so the MCP client
// receives the raw Supabase JWT directly.
const redisClient = config.redisUrl ? new Redis(config.redisUrl) : undefined;
if (redisClient) {
  redisClient.on('error', (err: Error) =>
    console.error('[browserless-mcp] Redis error:', err.message),
  );
  // Redis is only configured for the hosted httpStream deployment (REDIS_URL is
  // not set in stdio mode), so writing the "connected" line to stdout doesn't
  // interfere with MCP-over-stdio protocol framing.
  redisClient.on('ready', () =>
    console.log('[browserless-mcp] Redis connected for OAuth state storage'),
  );
}

class PassthroughOAuthProvider extends OAuthProvider {
  protected createProxy(): OAuthProxy {
    const proxyConfig = {
      allowedRedirectUriPatterns: config.oauthAllowedRedirectUriPatterns,
      baseUrl: this.config.baseUrl,
      consentRequired: false,
      enableTokenSwap: false,
      scopes: this.config.scopes ?? [],
      upstreamAuthorizationEndpoint: this.genericConfig.authorizationEndpoint,
      upstreamClientId: this.config.clientId,
      upstreamClientSecret: this.config.clientSecret,
      upstreamTokenEndpoint: this.genericConfig.tokenEndpoint,
      upstreamTokenEndpointAuthMethod:
        this.genericConfig.tokenEndpointAuthMethod ?? 'client_secret_basic',
    };
    if (redisClient) {
      return new RedisOAuthProxy(proxyConfig, redisClient);
    }
    return new OAuthProxy(proxyConfig);
  }
}

const oauthProvider =
  config.oauthEnabled && config.transport === 'httpStream'
    ? new PassthroughOAuthProvider({
        baseUrl: config.mcpBaseUrl,
        clientId: config.supabaseOAuthClientId,
        clientSecret: config.supabaseOAuthClientSecret,
        authorizationEndpoint: `${config.supabaseUrl}/auth/v1/oauth/authorize`,
        tokenEndpoint: `${config.supabaseUrl}/auth/v1/oauth/token`,
        scopes: ['email'],
        consentRequired: false,
      })
    : undefined;

// Hybrid authenticate, in order: (1) Authorization header with a plain API
// key or (2) ?token= query param → direct token session; (3) Authorization
// header with a Supabase JWT → resolve the Browserless API key via PostgREST.
const hybridAuthenticate =
  config.transport === 'httpStream'
    ? async (request: IncomingMessage) => {
        const params = new URLSearchParams(request.url?.split('?')[1] ?? '');
        return (await resolveBrowserlessAuth(
          {
            authHeader: request.headers.authorization as string | undefined,
            tokenQuery: params.get('token') || undefined,
            apiUrlHeader: request.headers['x-browserless-api-url'] as
              string | undefined,
            browserlessUrlQuery: params.get('browserlessUrl') || undefined,
            sessionIdHeader: request.headers['x-browserless-session-id'] as
              string | undefined,
            sessionIdQuery: params.get('browserlessSessionId') || undefined,
            sourceHeader: request.headers['x-browserless-mcp-source'] as
              string | undefined,
            sourceQuery: params.get('mcpSource') || undefined,
          },
          config,
        )) as BrowserlessSession;
      }
    : undefined;

const server = new FastMCP<BrowserlessSession>({
  name: 'browserless-mcp',
  version: pkg.version,
  ...(oauthProvider ? { auth: oauthProvider } : {}),
  authenticate: hybridAuthenticate,
});

registerSurface(server, config, analytics);
// Log the active surface (both transports) so it's visible in the boot logs.
// Fail-closed value lands on compliant; distinguish "unset" (dropped/wrong-scoped
// on a directory deploy) from opt-out, and warn on an unrecognized value (typo).
const complianceInput = classifyComplianceInput(
  process.env.MCP_COMPLIANCE_MODE,
);
if (complianceInput === 'unrecognized') {
  console.error(
    `[browserless-mcp] WARNING: MCP_COMPLIANCE_MODE="${process.env.MCP_COMPLIANCE_MODE}" ` +
      'is not a recognized value; defaulting to the compliant (reduced) surface. ' +
      'Set "true" for compliant or "false" for the full surface.',
  );
}
const complianceSurface = config.complianceMode
  ? 'compliant (reduced)'
  : complianceInput === 'unset'
    ? 'full (MCP_COMPLIANCE_MODE unset — set it to "true" for the compliant surface)'
    : 'full (explicit opt-out)';
console.error(`[browserless-mcp] Tool surface: ${complianceSurface}`);

server.on('connect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  console.error(`[browserless-mcp] Client connected: ${id}`);
  // force the client to refresh its tool list on connect
  void event.session.triggerListChangedNotification(
    'notifications/tools/list_changed',
  );
});

server.on('disconnect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  // Drop any files staged/captured for this session (TTL is the backstop).
  clearSession(event.session.sessionId);
  console.error(`[browserless-mcp] Client disconnected: ${id}`);
});

if (config.transport === 'httpStream') {
  server.start({
    transportType: 'httpStream',
    httpStream: {
      port: config.port,
      host: '0.0.0.0',
      eventStore: new BoundedEventStore(10_000),
      stateless: false,
    },
  });
  // Out-of-band file staging for uploads (the LLM curls a file here and gets a
  // handle, instead of base64-ing it through the conversation). httpStream only.
  registerUploadRoute(server, config);
  // Single-use, out-of-band fetch for captured downloads (the LLM GETs the file
  // instead of pulling bytes through the conversation). httpStream only.
  registerDownloadRoute(server, config);
  console.error(
    `[browserless-mcp] HTTP Streamable server listening on port ${config.port}`,
  );
} else {
  server.start({
    transportType: 'stdio',
  });
}

export { server };
