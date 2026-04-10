import type { IncomingMessage } from 'node:http';
import { FastMCP, OAuthProvider } from 'fastmcp';
import { OAuthProxy } from 'fastmcp/auth';
import { getConfig } from './config.js';
import type { BrowserlessSession } from './config.js';
import { registerPowerScraperTool } from './tools/smartscraper.js';
import { registerFunctionTool } from './tools/function.js';
import { registerDownloadTool } from './tools/download.js';
import { registerExportTool } from './tools/export.js';
import { registerSearchTool } from './tools/search.js';
import { registerMapTool } from './tools/map.js';
import { registerCrawlTool } from './tools/crawl.js';
import { registerPerformanceTool } from './tools/performance.js';
import { registerApiDocsResource } from './resources/api-docs.js';
import { registerStatusResource } from './resources/status.js';
import { registerScrapeUrlPrompt } from './prompts/scrape-url.js';
import { registerExtractContentPrompt } from './prompts/extract-content.js';
import { AmplitudeHelper } from './lib/amplitude.js';
import { resolveApiKey } from './lib/account-resolver.js';
import { BoundedEventStore } from './lib/bounded-event-store.js';

const config = getConfig();

// Supabase OAuth tokens have a very short TTL (60s), which causes FastMCP's
// token-swap mode to issue equally short-lived JWTs and trigger constant refresh
// cycles. We intercept Supabase token responses to extend the TTL to 1 hour.
// This is safe because we only decode the JWT payload (for accountId) — we never
// use it as a bearer token against Supabase APIs.
const OAUTH_TOKEN_TTL_OVERRIDE = 3600; // 1 hour
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const response = await originalFetch(...args);
  const url =
    typeof args[0] === 'string'
      ? args[0]
      : args[0] instanceof URL
        ? args[0].toString()
        : (args[0] as Request).url;
  if (response.ok && url.includes('/oauth/token')) {
    const body = (await response.json()) as Record<string, unknown>;
    if (
      typeof body.expires_in === 'number' &&
      body.expires_in < OAUTH_TOKEN_TTL_OVERRIDE
    ) {
      body.expires_in = OAUTH_TOKEN_TTL_OVERRIDE;
    }
    return new Response(JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
};
const amplitude = new AmplitudeHelper(
  config.analyticsEnabled,
  config.sqsQueueUrl,
  config.sqsRegion,
);

// Passthrough OAuth provider: disables FastMCP's token-swap mode so the MCP client
// receives the raw Supabase JWT directly. This eliminates server-side token storage,
// meaning server restarts don't invalidate client sessions.
class PassthroughOAuthProvider extends OAuthProvider {
  protected createProxy(): OAuthProxy {
    return new OAuthProxy({
      allowedRedirectUriPatterns: ['http://localhost:*', 'https://*'],
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
    });
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
        consentRequired: true,
      })
    : undefined;

// Hybrid authenticate: plain API key first, then ?token=, then OAuth/JWT fallback.
// 1. Authorization header with plain API key (non-JWT) → direct token session
// 2. ?token= query param → direct token session
// 3. Authorization header with JWT (Supabase token from OAuth) → decode payload,
//    resolve Browserless API key from Supabase PostgREST, return as session token
const hybridAuthenticate =
  config.transport === 'httpStream'
    ? async (request: IncomingMessage) => {
        const params = new URLSearchParams(request.url?.split('?')[1] ?? '');
        const authHeader = request.headers.authorization as string | undefined;
        const headerToken = authHeader?.startsWith('Bearer ')
          ? authHeader.slice(7)
          : authHeader;

        const apiUrl =
          (request.headers['x-browserless-api-url'] as string) ??
          params.get('browserlessUrl') ??
          config.browserlessApiUrl;

        // JWTs have 3 dot-separated base64url segments; plain API keys do not.
        const isJwt = headerToken
          ? headerToken.split('.').length === 3
          : false;

        // 1. Authorization header with plain API key
        if (headerToken && !isJwt) {
          return { token: headerToken, apiUrl } as BrowserlessSession;
        }

        // 2. ?token= query param
        const directToken = params.get('token') || undefined;
        if (directToken) {
          return { token: directToken, apiUrl } as BrowserlessSession;
        }

        // 3. Authorization header with JWT → decode Supabase token directly
        if (isJwt && headerToken) {
          const { apiKey } = await resolveApiKey(
            config.supabaseUrl,
            config.supabaseServiceRoleKey,
            headerToken,
          );
          return { token: apiKey, apiUrl } as BrowserlessSession;
        }

        throw new Error(
          'No Browserless API token provided. ' +
            'Pass it as Authorization: Bearer <token> header, ' +
            '?token= query parameter, or authenticate via OAuth.',
        );
      }
    : undefined;

const server = new FastMCP<BrowserlessSession>({
  name: 'browserless-mcp',
  version: '0.1.0',
  ...(oauthProvider ? { auth: oauthProvider } : {}),
  authenticate: hybridAuthenticate,
});

registerPowerScraperTool(server, config, amplitude);
registerFunctionTool(server, config, amplitude);
registerDownloadTool(server, config, amplitude);
registerExportTool(server, config, amplitude);
registerSearchTool(server, config, amplitude);
registerMapTool(server, config, amplitude);
registerCrawlTool(server, config, amplitude);
registerPerformanceTool(server, config, amplitude);
registerApiDocsResource(server, config);
registerStatusResource(server, config);
registerScrapeUrlPrompt(server);
registerExtractContentPrompt(server);

server.on('connect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  console.error(`[browserless-mcp] Client connected: ${id}`);
});

server.on('disconnect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  console.error(`[browserless-mcp] Client disconnected: ${id}`);
});

// OpenAI Apps Challenge verification endpoint
const app = server.getApp();
app.get('/.well-known/openai-apps-challenge', (c) => {
  return c.text('aaf7cYxvDaXPvZ2Vg40MCTvYzhCO0KW5mlqmvVIyh5o');
});

if (config.transport === 'httpStream') {
  server.start({
    transportType: 'httpStream',
    httpStream: {
      port: config.port,
      host: '0.0.0.0',
      eventStore: new BoundedEventStore(10_000),
    },
  });
  console.error(
    `[browserless-mcp] HTTP Streamable server listening on port ${config.port}`,
  );
} else {
  server.start({
    transportType: 'stdio',
  });
}

export { server };
