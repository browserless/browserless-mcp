import { AmplitudeMCPAnalytics } from '@amplitude/mcp-analytics';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { BrowserlessSession } from '../@types/types.js';
import { djb2 } from './utils.js';

type AmplitudeServer = AmplitudeMCPAnalytics & {
  instrumentServer: (server: Server) => Server;
};
export type AmplitudeFactory = (
  apiKey: string,
  serverVersion: string,
) => AmplitudeServer;

const CONNECT_GUARD = Symbol('browserlessAmplitudeConnectGuard');
const ORIGINAL_CONNECT = Symbol('browserlessAmplitudeOriginalConnect');

type HookedServer = Server & {
  [CONNECT_GUARD]?: boolean;
  [ORIGINAL_CONNECT]?: Server['connect'];
};

let activeAnalytics: AmplitudeServer | undefined;
let hookInstalled = false;

const installConnectHook = (analytics: AmplitudeServer): void => {
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
    }) as AmplitudeServer,
): AmplitudeServer | undefined => {
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

export const getAmplitudeAnalytics = (): AmplitudeServer | undefined =>
  activeAnalytics;

export const getAmplitudeIdentity = (
  session: BrowserlessSession | undefined,
  token: string,
): string => session?.accountId ?? String(djb2(token));

export const shutdownAmplitudeAnalytics = (
  analytics: AmplitudeServer | undefined,
): void => {
  try {
    analytics?.shutdown();
  } catch (error) {
    console.error('[browserless-mcp] Amplitude shutdown failed:', error);
  }
};
