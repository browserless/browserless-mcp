import { AmplitudeMCPAnalytics } from '@amplitude/mcp-analytics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FastMCP } from 'fastmcp';
import type { BrowserlessSession } from '../@types/types.js';
import { djb2 } from './utils.js';

export type AmplitudeFactory = (
  apiKey: string,
  serverVersion: string,
) => AmplitudeMCPAnalytics;

const CONNECT_GUARD = Symbol('browserlessAmplitudeConnectGuard');
const ORIGINAL_CONNECT = Symbol('browserlessAmplitudeOriginalConnect');
const ADD_TOOL_HOOK = Symbol('browserlessAmplitudeAddToolHook');

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
): string => session?.accountId ?? `token-${djb2(token)}`;

export const shutdownAmplitudeAnalytics = async (
  analytics: AmplitudeMCPAnalytics | undefined,
): Promise<void> => {
  try {
    await analytics?.shutdown();
  } catch (error) {
    console.error('[browserless-mcp] Amplitude shutdown failed:', error);
  }
};

export const resetAmplitudeAnalyticsForTests = (
  originalConnect: Server['connect'],
): void => {
  Server.prototype.connect = originalConnect;
  activeAnalytics = undefined;
  hookInstalled = false;
};
