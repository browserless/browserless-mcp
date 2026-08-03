import { createHash } from 'node:crypto';
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

export const initializeAmplitudeAnalytics = (
  apiKey: string | undefined,
  serverVersion: string,
  factory: AmplitudeFactory = (key, version) =>
    new AmplitudeMCPAnalytics({
      apiKey: key,
      serverName: 'browserless-mcp',
      serverVersion: version,
    }),
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
    console.error('[browserless-mcp] Amplitude custom event failed:', error);
  }
};

/** `flush()` hands back an `AmplitudeReturn`, typed as `unknown` by the SDK. */
type AmplitudeFlushResult = { promise?: Promise<unknown> } | undefined;

export const shutdownAmplitudeAnalytics = async (
  analytics: AmplitudeMCPAnalytics | undefined,
): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    // `shutdown()` is synchronous and returns void — only `flush()` yields an
    // awaitable, so awaiting shutdown alone resolves on the next tick and
    // `process.exit()` drops whatever is still in flight.
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
