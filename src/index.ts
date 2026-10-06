import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FastMCP, OAuthProvider } from 'fastmcp';
import type { OAuthProxy } from 'fastmcp/auth';
import { getConfig, classifyComplianceInput } from './config.js';
import type { BrowserlessSession } from './@types/types.js';
import { registerSurface } from './tools/register.js';
import { registerUploadRoute } from './resources/upload-route.js';
import { registerDownloadRoute } from './resources/download-route.js';
import { clearSession } from './lib/download-store.js';
import { dropMcpSession, startSweepTimer } from './lib/agent-client.js';
import {
  touchSession,
  forgetSession,
  startSessionReaper,
} from './lib/session-reaper.js';
import { AnalyticsHelper } from './lib/analytics.js';
import { installSupabaseTokenTtlPatch } from './lib/account-resolver.js';
import { resolveBrowserlessRequestAuth } from './lib/http-auth.js';
import { BoundedEventStore } from './lib/bounded-event-store.js';
import { RedisTokenStorage } from './lib/redis-token-storage.js';
import { BrowserlessOAuthProxy } from './lib/oauth-redirect-uri.js';
import { createRegisterRateLimiter } from './lib/oauth-register-rate-limit.js';
import { Redis } from 'ioredis';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  instrumentFastMcpTools,
  initializeAmplitudeAnalytics,
  shutdownAmplitudeAnalytics,
} from './lib/amplitude-analytics.js';

const pkg = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
    'utf-8',
  ),
) as { version: `${number}.${number}.${number}` };

const config = getConfig();

// Crash safety net: this MCP runs as a single instance behind the LB, so one
// stray throw or unhandled rejection during steady-state operation (a tool, a
// dependency, a periodic timer) would otherwise exit the process and take the
// whole service down for every client until it restarts. Once the server is
// serving, log and keep running instead; per-request and per-sweep failures are
// already isolated at their call sites, so this is the last-resort backstop.
// Trade-off: a genuinely corrupting runtime error is logged rather than
// fast-failing, which is acceptable here where a full outage is worse.
//
// Before the server is confirmed up the opposite holds: a crash during startup
// (e.g. the listen port is taken) leaves nothing to "keep serving", and
// swallowing it would strand a process that is alive but never accepting
// connections — the hardest outage to detect behind a load balancer. So fail
// loud until `serverReady`, matching Node's default fast-fail on boot.
let serverReady = false;
const logUnhandled = (kind: string, err: unknown): void => {
  console.error(
    `[browserless-mcp] ${kind}:`,
    err instanceof Error ? (err.stack ?? err.message) : err,
  );
  if (!serverReady) {
    // Startup fault: don't limp on in a permanently non-serving state.
    process.exit(1);
  }
};
process.on('uncaughtException', (err) =>
  logUnhandled('uncaughtException', err),
);
process.on('unhandledRejection', (reason) =>
  logUnhandled('unhandledRejection', reason),
);

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
const amplitudeAnalytics = initializeAmplitudeAnalytics(
  config.amplitudeApiKey,
  pkg.version,
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
      return new BrowserlessOAuthProxy({
        ...proxyConfig,
        encryptionKey: false,
        tokenStorage: new RedisTokenStorage(redisClient),
      });
    }
    return new BrowserlessOAuthProxy(proxyConfig);
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
    ? async (request: Parameters<typeof resolveBrowserlessRequestAuth>[0]) => {
        // Any authenticated inbound request proves the client is alive, so
        // refresh the idle clock here — not only on tool calls. This keeps the
        // reaper from closing a session that is merely between calls or only
        // listing tools. `initialize` carries no session id yet; `connect`
        // stamps that case.
        const sid = request.headers?.['mcp-session-id'];
        touchSession(Array.isArray(sid) ? sid[0] : sid);
        return (await resolveBrowserlessRequestAuth(
          request,
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

instrumentFastMcpTools(server, amplitudeAnalytics);
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

let warnedAboutServerIdentity = false;
server.on('connect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  // Stamp activity so the idle reaper gives a fresh session a full TTL.
  touchSession(event.session.sessionId);
  console.error(`[browserless-mcp] Client connected: ${id}`);
  if (
    amplitudeAnalytics &&
    !warnedAboutServerIdentity &&
    !(event.session.server instanceof Server)
  ) {
    warnedAboutServerIdentity = true;
    console.error(
      '[browserless-mcp] WARNING: FastMCP session server is not an MCP SDK Server; Amplitude instrumentation may be disabled.',
    );
  }
  // force the client to refresh its tool list on connect
  void event.session.triggerListChangedNotification(
    'notifications/tools/list_changed',
  );
});

if (amplitudeAnalytics) {
  let amplitudeShutdown = false;
  const shutdown = (exitCode: number): void => {
    if (amplitudeShutdown) return;
    amplitudeShutdown = true;
    void (async () => {
      try {
        await shutdownAmplitudeAnalytics(amplitudeAnalytics);
      } finally {
        process.exit(exitCode);
      }
    })();
  };
  process.once('SIGTERM', () => shutdown(143));
  process.once('SIGINT', () => shutdown(130));
}

server.on('disconnect', (event) => {
  const id = event.session.sessionId ?? 'stdio';
  // Remote clients replace MCP transports between turns and after a 401.
  // Do not close agent browsers here: their handles survive transport churn.
  // Drop any files staged/captured for this session (TTL is the backstop).
  clearSession(event.session.sessionId);
  dropMcpSession(event.session.sessionId);
  forgetSession(event.session.sessionId);
  // Release this torn-down MCP session's keepalive ping. fastmcp removes the
  // session from its registry on disconnect but never calls close(), so the 5s
  // ping setInterval — and the session graph it pins — would otherwise live
  // until the process exits. The transport is already gone, so this
  // only frees the timer and the MCP server; the agent browser handle is keyed
  // separately in agent-client and is untouched.
  void Promise.resolve(event.session.close()).catch(() => {});
  console.error(`[browserless-mcp] Client disconnected: ${id}`);
});

startSweepTimer();
// Backstop for abandoned httpStream transports that never fire `disconnect`:
// close MCP sessions idle past the TTL so their ping intervals cannot pile up.
startSessionReaper(() => server.sessions);

if (config.transport === 'httpStream') {
  const started = server.start({
    transportType: 'httpStream',
    httpStream: {
      port: config.port,
      host: '0.0.0.0',
      eventStore: new BoundedEventStore(10_000),
      stateless: false,
    },
  });
  // A failed listen (e.g. EADDRINUSE) never resolves this and instead surfaces
  // as an uncaughtException — which the guard above fast-fails while serverReady
  // is still false. A clean listen flips the flag so steady-state faults from
  // here on are survivable rather than fatal.
  void Promise.resolve(started).then(() => {
    serverReady = true;
  });
  // Out-of-band file staging for uploads (the LLM curls a file here and gets a
  // handle, instead of base64-ing it through the conversation). httpStream only.
  registerUploadRoute(server, config);
  if (oauthProvider) {
    const limiter = createRegisterRateLimiter({
      redis: redisClient,
      limitPerHour: config.oauthRegisterRateLimitPerHour,
    });
    server.getApp().use('/oauth/register', async (c, next) => {
      if (c.req.method !== 'POST') return await next();
      // Deploy behind a trusted proxy that overwrites X-Real-IP.
      const incoming = (c.env as { incoming?: IncomingMessage } | undefined)
        ?.incoming;
      const ip =
        c.req.header('x-real-ip')?.trim() ||
        incoming?.socket?.remoteAddress ||
        'unknown';
      const { allowed, retryAfterSeconds } = await limiter.hit(ip);
      if (!allowed) {
        console.warn('[browserless-mcp] DCR rate limit hit', { ip });
        return c.json(
          {
            error: 'too_many_requests',
            error_description:
              'Too many client registrations from this address',
          },
          429,
          {
            'Retry-After': String(retryAfterSeconds),
            'Cache-Control': 'no-store',
          },
        );
      }
      // Leave the body unread for FastMCP's OAuth route.
      await next();
    });
  }
  // Single-use, out-of-band fetch for captured downloads (the LLM GETs the file
  // instead of pulling bytes through the conversation). httpStream only.
  registerDownloadRoute(server, config);
  console.error(
    `[browserless-mcp] HTTP Streamable server listening on port ${config.port}`,
  );
} else {
  const started = server.start({
    transportType: 'stdio',
  });
  void Promise.resolve(started).then(() => {
    serverReady = true;
  });
}

export { server };
