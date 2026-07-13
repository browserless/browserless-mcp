import { parseCsv } from './lib/utils.js';
import type { McpConfig } from './@types/types.js';

export const DEFAULT_API_URL = 'https://production-sfo.browserless.io';

// Baseline allow-list of redirect URIs for MCP clients that legitimately DCR
// against the hosted mcp.browserless.io deployment. Extend at runtime via
// OAUTH_ADDITIONAL_REDIRECT_URI_PATTERNS for additional clients.
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
  'https://www.make.com/oauth/cb/mcp', // Make.com MCP client (canonical www host even for regional orgs)
  'https://us1.make.celonis.com/oauth/cb/mcp', // Make.com Celonis-hosted (enterprise) — US region
  'https://eu1.make.celonis.com/oauth/cb/mcp', // Make.com Celonis-hosted (enterprise) — EU region
];

// Fail closed on the compliance gate: any SET value that isn't an explicit
// opt-out enables the compliant (restricted) surface. A fumbled flag — "TRUE",
// "1", a trailing space, a typo, even an empty string — must not silently fall
// through to the full, prohibited surface on a directory-listed endpoint. Only
// an UNSET var or an explicit opt-out token (false/0/no/off) serves the full
// surface.
const COMPLIANCE_OPT_OUT = new Set(['false', '0', 'no', 'off']);
const COMPLIANCE_OPT_IN = new Set(['true', '1', 'yes', 'on']);
function parseComplianceMode(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return !COMPLIANCE_OPT_OUT.has(raw.trim().toLowerCase());
}

// Classify the raw MCP_COMPLIANCE_MODE for boot logging. `unrecognized` still
// resolves to compliant (fail-closed, see parseComplianceMode) but is surfaced
// as a warning so a typo'd / mis-scoped value ("ture", "compliant", a stray
// space) is visible instead of silently reading as an intentional opt-in.
export function classifyComplianceInput(
  raw: string | undefined,
): 'unset' | 'opt-out' | 'opt-in' | 'unrecognized' {
  if (raw === undefined) return 'unset';
  const v = raw.trim().toLowerCase();
  if (COMPLIANCE_OPT_OUT.has(v)) return 'opt-out';
  if (COMPLIANCE_OPT_IN.has(v)) return 'opt-in';
  return 'unrecognized';
}

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
    // Per-process toggle for the compliant surface used by the OpenAI/Anthropic
    // directory listings: registers fewer tools and de-fangs the agent (see
    // tools/compliance.ts). Fails closed — see parseComplianceMode.
    complianceMode: parseComplianceMode(process.env.MCP_COMPLIANCE_MODE),
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
