import type { IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastMCP, OAuthProvider } from 'fastmcp';
import { OAuthProxy } from 'fastmcp/auth';
import { getConfig } from './config.js';
import type { BrowserlessSession } from './@types/types.js';
import { registerSmartScraperTool } from './tools/smartscraper.js';
import { registerFunctionTool } from './tools/function.js';
import { registerDownloadTool } from './tools/download.js';
import { registerExportTool } from './tools/export.js';
import { registerAgentTools } from './tools/agent.js';
import { registerSearchTool } from './tools/search.js';
import { registerMapTool } from './tools/map.js';
import { registerCrawlTool } from './tools/crawl.js';
import { registerPerformanceTool } from './tools/performance.js';
import { registerApiDocsResource } from './resources/api-docs.js';
import { registerStatusResource } from './resources/status.js';
import { registerScrapeUrlPrompt } from './prompts/scrape-url.js';
import { registerExtractContentPrompt } from './prompts/extract-content.js';
import { AnalyticsHelper } from './lib/analytics.js';
import {
  resolveApiKey,
  installSupabaseTokenTtlPatch,
} from './lib/account-resolver.js';
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
        const authHeader = request.headers.authorization as string | undefined;
        const headerToken = authHeader?.startsWith('Bearer ')
          ? authHeader.slice(7)
          : authHeader;

        const apiUrl =
          (request.headers['x-browserless-api-url'] as string) ??
          params.get('browserlessUrl') ??
          config.browserlessApiUrl;

        // JWTs have 3 dot-separated base64url segments; plain API keys do not.
        const isJwt = headerToken ? headerToken.split('.').length === 3 : false;

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
  version: pkg.version,
  ...(oauthProvider ? { auth: oauthProvider } : {}),
  authenticate: hybridAuthenticate,
});

registerSmartScraperTool(server, config, analytics);
registerFunctionTool(server, config, analytics);
registerDownloadTool(server, config, analytics);
registerExportTool(server, config, analytics);
registerAgentTools(server, config, analytics);
registerSearchTool(server, config, analytics);
registerMapTool(server, config, analytics);
registerCrawlTool(server, config, analytics);
registerPerformanceTool(server, config, analytics);
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
  console.error(
    `[browserless-mcp] HTTP Streamable server listening on port ${config.port}`,
  );
} else {
  server.start({
    transportType: 'stdio',
  });
}

export { server };
