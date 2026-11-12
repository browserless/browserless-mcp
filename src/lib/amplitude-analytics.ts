import { createHash } from 'node:crypto';
import { createInstance, Types } from '@amplitude/analytics-node';
import {
  AmplitudeMCPAnalytics,
  getCurrentContext,
  setIdentity,
  setRationale,
} from '@amplitude/mcp-analytics';
import type { McpToolContext } from '@amplitude/mcp-analytics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastMCP } from 'fastmcp';
import type { BrowserlessSession } from '../@types/types.js';
import { skillDeliveryFailed } from './skill-telemetry.js';
import {
  diagnosticPreview,
  escapeDiagnosticString,
} from './diagnostic-string.js';
import { exportLogRecord } from './otlp-log.js';

export type AmplitudeFactory = (
  apiKey: string,
  serverVersion: string,
) => AmplitudeMCPAnalytics;

const CONNECT_GUARD = Symbol('browserlessAmplitudeConnectGuard');
const ORIGINAL_CONNECT = Symbol('browserlessAmplitudeOriginalConnect');
const ADD_TOOL_HOOK = Symbol('browserlessAmplitudeAddToolHook');
const AMPLITUDE_SHUTDOWN_TIMEOUT_MS = 2_000;

type HookedServer = Server & {
  [CONNECT_GUARD]?: boolean;
  [ORIGINAL_CONNECT]?: Server['connect'];
};

type HookedFastMcp = FastMCP & {
  [ADD_TOOL_HOOK]?: boolean;
};

let activeAnalytics: AmplitudeMCPAnalytics | undefined;
let hookInstalled = false;

const installConnectHook = (analytics: AmplitudeMCPAnalytics): void => {
  activeAnalytics = analytics;
  if (hookInstalled) return;

  const originalConnect = Server.prototype.connect;
  Server.prototype.connect = function (this: HookedServer, transport) {
    if (this[CONNECT_GUARD]) {
      return this[ORIGINAL_CONNECT]!(transport);
    }

    const currentAnalytics = activeAnalytics;
    if (!currentAnalytics) {
      return originalConnect.call(this, transport);
    }

    this[CONNECT_GUARD] = true;
    this[ORIGINAL_CONNECT] = originalConnect.bind(this);
    try {
      currentAnalytics.instrumentServer(this);
    } catch (error) {
      console.error(
        '[browserless-mcp] Amplitude instrumentation failed:',
        error,
      );
    }
    return this.connect(transport);
  };
  hookInstalled = true;
};

type Failure = {
  event_type: string;
  status: number;
  reason: string;
  count: number;
};
const failures = new Map<string, Failure>();
const statuses = new Map<number, number>();
let deliveryFlush = Promise.resolve();
let overflow = 0;
let errors = 0;
let warnings = 0;
let timer: NodeJS.Timeout | undefined;

export const amplitudeFailureReason = (message: unknown): string => {
  if (typeof message !== 'string') return 'unknown';
  const text = message
    .split(':', 1)[0]
    .replace(/\S+/g, (word) => (word.includes('@') ? '[redacted]' : word))
    .replace(/[A-Za-z0-9+/=_-]{16,}/g, '[redacted]')
    .trim();
  return escapeDiagnosticString(diagnosticPreview(text, 80)) || 'unknown';
};

const startWindow = (): void => {
  timer ??= setTimeout(flushAmplitudeDelivery, 60_000).unref();
};

export const noteAmplitudeResult = (result: {
  event?: { event_type?: unknown };
  code: number;
  message?: unknown;
}): void => {
  if (result.code === 200 || result.code === 100) return;
  statuses.set(result.code, (statuses.get(result.code) ?? 0) + 1);
  const event_type =
    typeof result.event?.event_type === 'string'
      ? escapeDiagnosticString(diagnosticPreview(result.event.event_type, 64))
      : 'unknown';
  const reason = amplitudeFailureReason(result.message);
  const key = JSON.stringify([event_type, result.code, reason]);
  const existing = failures.get(key);
  if (existing) existing.count++;
  else if (failures.size < 12)
    failures.set(key, { event_type, status: result.code, reason, count: 1 });
  else overflow++;
  startWindow();
};

export const noteAmplitudeSdkLog = (level: 'warn' | 'error'): void => {
  if (level === 'error') errors++;
  else warnings++;
  startWindow();
};

export const flushAmplitudeDelivery = (): Promise<void> => {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!failures.size && !overflow && !errors && !warnings) return deliveryFlush;
  const records = [...failures.values()];
  if (overflow)
    records.push({
      event_type: 'other',
      status: 0,
      reason: 'overflow',
      count: overflow,
    });
  const count = records.reduce((total, record) => total + record.count, 0);
  deliveryFlush = Promise.all([
    deliveryFlush,
    ...records.map((record) =>
      exportLogRecord({
        scope: 'amplitude',
        event: 'browserless.mcp.amplitude.delivery_failed',
        severity: 'WARN',
        attributes: { ...record, window_s: 60 },
      }),
    ),
  ]).then(() => {});
  console.warn(
    `[browserless-mcp] Amplitude delivery failed for ${count} events in the last 60s (${[...statuses].map(([status, n]) => `${status}: ${n}`).join(', ')}); SDK errors ${errors}, warnings ${warnings}`,
  );
  failures.clear();
  statuses.clear();
  overflow = errors = warnings = 0;
  return deliveryFlush;
};

export const createAmplitudeLogger = (): Types.ILogger & { info(): void } => {
  let level = Types.LogLevel.None;
  return {
    enable: (logLevel = Types.LogLevel.Warn) => {
      level = logLevel;
    },
    disable: () => {
      level = Types.LogLevel.None;
    },
    // Verbose payload diagnostics remain suppressed, regardless of log level.
    debug: () => {},
    log: () => {},
    info: () => {},
    warn: () => {
      if (level >= Types.LogLevel.Warn) noteAmplitudeSdkLog('warn');
    },
    error: () => {
      if (level >= Types.LogLevel.Error) noteAmplitudeSdkLog('error');
    },
  };
};

export const observeAmplitudeDelivery = <
  T extends Pick<ReturnType<typeof createInstance>, 'track'>,
>(
  amplitude: T,
): T => ({
  ...amplitude,
  track: (...args: Parameters<ReturnType<typeof createInstance>['track']>) => {
    const result = amplitude.track(...args);
    void result.promise.then(noteAmplitudeResult, () => {});
    return result;
  },
});

export const initializeAmplitudeAnalytics = (
  apiKey: string | undefined,
  serverVersion: string,
  factory: AmplitudeFactory = (key, version) => {
    const amplitude = createInstance();
    // Count severity and sanitized status/reason per minute; never log payloads.
    const loggerProvider = createAmplitudeLogger();
    amplitude.init(key, { loggerProvider });
    return new AmplitudeMCPAnalytics({
      amplitude: {
        ...observeAmplitudeDelivery(amplitude),
        configuration: { loggerProvider },
      },
      serverName: 'browserless-mcp',
      serverVersion: version,
    });
  },
): AmplitudeMCPAnalytics | undefined => {
  if (!apiKey) return undefined;

  try {
    const analytics = factory(apiKey, serverVersion);
    installConnectHook(analytics);
    return analytics;
  } catch (error) {
    console.error('[browserless-mcp] Amplitude initialization failed:', error);
    return undefined;
  }
};

export const instrumentFastMcpTools = (
  server: FastMCP,
  analytics: AmplitudeMCPAnalytics | undefined,
): void => {
  if (!analytics) return;

  const hookedServer = server as HookedFastMcp;
  if (hookedServer[ADD_TOOL_HOOK]) return;

  const originalAddTool = server.addTool.bind(server);
  server.addTool = ((tool) => {
    const execute = async (
      ...args: Parameters<typeof tool.execute>
    ): Promise<CallToolResult> =>
      // FastMCP and MCP SDK content unions differ although the runtime shape matches.
      (await tool.execute(...args)) as CallToolResult;

    return originalAddTool({
      ...tool,
      execute: analytics.instrumentTool(execute, { name: tool.name }),
    });
  }) as FastMCP['addTool'];
  hookedServer[ADD_TOOL_HOOK] = true;
};

export const getAmplitudeIdentity = (
  session: BrowserlessSession | undefined,
  token: string,
): string =>
  session?.accountId ??
  `token-${createHash('sha256').update(token).digest('base64url')}`;

export const setAmplitudeToolContext = (
  session: BrowserlessSession | undefined,
  token: string,
  prompt: string | undefined,
): void => {
  if (!activeAnalytics) return;

  try {
    if (!getCurrentContext()) return;
    setIdentity({ userId: getAmplitudeIdentity(session, token) });
    if (prompt !== undefined) setRationale(prompt);
  } catch (error) {
    console.error('[browserless-mcp] Amplitude tool context failed:', error);
  }
};

/**
 * Emit one of our own (non-SDK) events — `MCP Tool Request`, `MCP Skill` —
 * through the same Amplitude client the SDK uses, so they inherit the identity,
 * session anchor, client/server fields and transport the SDK already resolved
 * instead of carrying a parallel set of our own. No-op when Amplitude is
 * disabled or when called outside an instrumented frame. The raw Browserless
 * token is never a property here: identity comes from `setIdentity`, which
 * resolves to the account id or a hash.
 */
export const trackAmplitudeEvent = (
  eventName: string,
  properties: Record<string, unknown>,
): void => {
  if (!activeAnalytics) return;

  try {
    const ctx = getCurrentContext();
    if (!ctx) return;

    const props = { ...properties };
    // Already emitted as the reserved `[MCP] Rationale` via setRationale.
    delete props._prompt;

    if ('tool' in ctx) {
      activeAnalytics.trackToolEvent(ctx as McpToolContext, eventName, props);
    } else {
      activeAnalytics.trackServerEvent(ctx, eventName, props);
    }
  } catch (error) {
    if (
      eventName === 'Skill Retrieval Completed' ||
      eventName === 'MCP Skill'
    ) {
      skillDeliveryFailed(eventName);
    } else {
      console.error('[browserless-mcp] Amplitude custom event failed:', error);
    }
  }
};

/** `flush()` hands back an `AmplitudeReturn`, typed as `unknown` by the SDK. */
type AmplitudeFlushResult = { promise?: Promise<unknown> } | undefined;

export const shutdownAmplitudeAnalytics = async (
  analytics: AmplitudeMCPAnalytics | undefined,
): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    // Only `flush()` is awaitable; synchronous SDK shutdown cannot drain events.
    await Promise.race([
      (analytics?.flush() as AmplitudeFlushResult)?.promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, AMPLITUDE_SHUTDOWN_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);
  } catch (error) {
    console.error('[browserless-mcp] Amplitude shutdown failed:', error);
  } finally {
    if (timeout) clearTimeout(timeout);
    await flushAmplitudeDelivery();
    try {
      analytics?.shutdown();
    } catch (error) {
      console.error('[browserless-mcp] Amplitude shutdown failed:', error);
    }
  }
};

export const resetAmplitudeAnalyticsForTests = (
  originalConnect: Server['connect'],
): void => {
  Server.prototype.connect = originalConnect;
  activeAnalytics = undefined;
  hookInstalled = false;
};
