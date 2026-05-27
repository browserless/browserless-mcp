import { parseCsv } from './lib/utils.js';
import type { McpConfig } from './@types/types.js';

export const DEFAULT_API_URL = 'https://production-sfo.browserless.io';

// Baseline allow-list of redirect URIs trusted by the hosted
// mcp.browserless.io deployment. These are the known MCP clients that
// legitimately DCR against this server today.
// Deployments that need to allow additional clients (new MCP hosts,
// staging domains, etc.) can extend this list at runtime via
// OAUTH_ADDITIONAL_REDIRECT_URI_PATTERNS.
const DEFAULT_ALLOWED_REDIRECT_URI_PATTERNS = [
  'http://localhost:*', // Claude Desktop, VS Code, Windsurf, and anything else using a local loopback callback
  'http://127.0.0.1:*',
  'https://claude.ai/api/mcp/auth_callback', // Claude.ai web custom connectors
  'https://chatgpt.com/connector/oauth/*', // ChatGPT / OpenAI Apps SDK connector (current per-connector callback id)
  'https://chatgpt.com/connector_platform_oauth_redirect', // ChatGPT MCP connector (legacy, still honored for already-published apps)
  'cursor://anysphere.cursor-mcp/oauth/callback', // Cursor (private-use URI scheme registered by the desktop app)
  'https://api.devin.ai/mcp/oauth/callback', // Devin prod
  'https://api.beta.devin.ai/mcp/oauth/callback', // Devin beta
  'https://api.itsdev.in/mcp/oauth/callback', // Devin dev
];

export function getConfig(): McpConfig {
  return {
    browserlessToken: process.env.BROWSERLESS_TOKEN,
    browserlessApiUrl: process.env.BROWSERLESS_API_URL ?? DEFAULT_API_URL,
    transport: (process.env.TRANSPORT as 'stdio' | 'httpStream') ?? 'stdio',
    port: parseInt(process.env.PORT ?? '8080', 10),
    requestTimeout: parseInt(process.env.BROWSERLESS_TIMEOUT ?? '30000', 10),
    maxRetries: parseInt(process.env.BROWSERLESS_MAX_RETRIES ?? '3', 10),
    cacheTtlMs: parseInt(process.env.BROWSERLESS_CACHE_TTL ?? '60000', 10),
    analyticsEnabled: process.env.ANALYTICS_ENABLED === 'true',
    sqsQueueUrl: process.env.SQS_QUEUE_URL,
    sqsRegion: process.env.SQS_REGION ?? 'us-west-2',
    // OAuth (Supabase)
    oauthEnabled: process.env.OAUTH_ENABLED === 'true',
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseOAuthClientId: process.env.SUPABASE_OAUTH_CLIENT_ID ?? '',
    supabaseOAuthClientSecret: process.env.SUPABASE_OAUTH_CLIENT_SECRET ?? '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    mcpBaseUrl: process.env.MCP_BASE_URL ?? 'https://mcp.browserless.io',
    redisUrl: process.env.REDIS_URL || undefined,
    oauthAllowedRedirectUriPatterns: [
      ...DEFAULT_ALLOWED_REDIRECT_URI_PATTERNS,
      ...parseCsv(process.env.OAUTH_ADDITIONAL_REDIRECT_URI_PATTERNS),
    ],
  };
}
