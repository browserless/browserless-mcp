export interface AgentMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface AgentError {
  code?: string;
  message: string;
  retryable?: boolean;
  suggestion?: string;
  snapshot?: SnapshotResult;
}

export interface AgentResponse {
  id: number;
  result?: unknown;
  error?: AgentError;
}

export interface SnapshotElement {
  ref: number;
  role: string;
  name: string;
  selector: string;
  tag: string;
  text?: string;
  value?: string;
  type?: string;
  placeholder?: string;
  id?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  focused?: boolean;
  required?: boolean;
  ariaLabel?: string;
}

export interface TabInfo {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface SnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
  time: number;
  tabs?: TabInfo[];
  activeTargetId?: string | null;
  detectedChallenges?: string[];
}

import { createHash } from 'node:crypto';
import { createSkillState } from '../skills/index.js';
import type { SkillFireState } from '../skills/index.js';
import { PROXY_FIELDS } from '../tools/schemas.js';
import type { ProxyOptions } from '../tools/schemas.js';

export interface ActiveSession {
  ws: WebSocket;
  msgId: number;
  apiUrl: string;
  token: string;
  proxy?: ProxyOptions;
  profile?: string;
  reconnecting?: Promise<WebSocket>;
  skillState: SkillFireState;
  lastUsedAt: number;
  lastUrl?: string;
}

const sessions = new Map<string, ActiveSession>();
// In-flight session creations keyed by session key. Concurrent
// getOrCreateSession callers await the same promise instead of each
// opening their own WebSocket.
const pending = new Map<string, Promise<ActiveSession>>();

const DEFAULT_TIMEOUT = 60_000;
const IDLE_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 500;

const closeAndDelete = (key: string, reason: string): void => {
  const session = sessions.get(key);
  if (!session) return;
  try {
    session.ws.close();
  } catch {
    /* ignore */
  }
  sessions.delete(key);
  console.error(`[agent-client] evicted session key=${key} reason=${reason}`);
};

// Sweep idle sessions and enforce a hard cap. Called on every
// getOrCreateSession; cheap because the map is bounded.
const sweepSessions = (): void => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastUsedAt > IDLE_TTL_MS) {
      closeAndDelete(key, 'idle');
    }
  }
  if (sessions.size <= MAX_SESSIONS) return;
  const overage = sessions.size - MAX_SESSIONS;
  const oldest = [...sessions.entries()]
    .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
    .slice(0, overage);
  for (const [key] of oldest) {
    closeAndDelete(key, 'cap');
  }
};

// Separator between the host segment (mcpSessionId or stdio:<hash>) and
// the proxy fingerprint in a session key. NUL is illegal in any
// user-supplied field, so the two segments cannot ambiguously concatenate.
const KEY_SEP = '\u0000';

// 64-bit truncation of SHA-256 — wide enough to make accidental collisions
// astronomically unlikely, unlike the 32-bit djb2 used elsewhere.
const sha256Short = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 16);

// Hash externalProxyServer rather than serializing it raw — the session key
// is logged on eviction (closeAndDelete), and the URL may carry user:pass
// credentials. Hashing preserves per-upstream session distinctness without
// putting secrets in stderr.
const fingerprintValue = (
  field: (typeof PROXY_FIELDS)[number],
  value: unknown,
): string =>
  field === 'externalProxyServer'
    ? `external#${sha256Short(String(value))}`
    : String(value);

/**
 * Build a stable, credential-free key segment for a proxy config. Two
 * logically identical configs produce the same fingerprint regardless of
 * key order. `externalProxyServer` is SHA-256 hashed so credentials never
 * land in the eviction log.
 */
export const proxyFingerprint = (proxy?: ProxyOptions): string => {
  if (!proxy) return '';
  const parts = PROXY_FIELDS.map((k) =>
    proxy[k] === undefined ? null : `${k}=${fingerprintValue(k, proxy[k])}`,
  ).filter(Boolean);
  return parts.length ? KEY_SEP + parts.join('&') : '';
};

// Hash the profile rather than serializing it raw — like externalProxyServer,
// the session key is logged on eviction (closeAndDelete), and a profile name
// may be a user-identifying label. Hashing preserves per-profile session
// distinctness without putting the raw name in stderr.
const getSessionKey = (
  mcpSessionId: string | undefined,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
): string =>
  (mcpSessionId ?? `stdio:${sha256Short(token)}`) +
  proxyFingerprint(proxy) +
  (profile ? KEY_SEP + 'profile#' + sha256Short(profile) : '');

/**
 * Build the WebSocket URL for `/chromium/agent`. Normalizes trailing
 * slashes on `apiUrl`, case-insensitively swaps http(s)→ws(s), and appends
 * `token` plus any proxy params. Boolean proxy flags follow enterprise's
 * presence-only contract: only set when truthy.
 */
export const buildAgentWsUrl = (
  apiUrl: string,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
): string => {
  const base = apiUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const url = new URL(base + '/chromium/agent');
  url.searchParams.set('token', token);
  if (proxy?.proxy) url.searchParams.set('proxy', proxy.proxy);
  if (proxy?.proxyCountry)
    url.searchParams.set('proxyCountry', proxy.proxyCountry);
  if (proxy?.proxyState) url.searchParams.set('proxyState', proxy.proxyState);
  if (proxy?.proxyCity) url.searchParams.set('proxyCity', proxy.proxyCity);
  if (proxy?.proxySticky) url.searchParams.set('proxySticky', 'true');
  if (proxy?.proxyLocaleMatch) url.searchParams.set('proxyLocaleMatch', 'true');
  if (proxy?.proxyPreset)
    url.searchParams.set('proxyPreset', proxy.proxyPreset);
  if (proxy?.externalProxyServer)
    url.searchParams.set('externalProxyServer', proxy.externalProxyServer);
  if (profile) url.searchParams.set('profile', profile);
  return url.toString();
};

// Best-effort interpretation of a WebSocket close code seen *during connect*.
// Node's built-in WebSocket reports HTTP-upgrade failures as close events with
// code 1006 (abnormal closure) and no reason string, which is why naive
// "unknown error" messages dominate without this mapping.
const describeConnectCloseCode = (code: number, reason: string): string => {
  if (reason) return `code=${code}, reason="${reason}"`;
  if (code === 1006)
    return 'code=1006 (abnormal close during upgrade — likely auth (401), proxy plan-gate (401/403), an unknown profile for the configured token, or a network error reaching the server)';
  if (code === 1008) return 'code=1008 (policy violation)';
  if (code === 1011) return 'code=1011 (server error during upgrade)';
  return `code=${code}`;
};

const connect = (
  apiUrl: string,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const wsUrl = buildAgentWsUrl(apiUrl, token, proxy, profile);
    const ws = new WebSocket(wsUrl);
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('Agent WebSocket connection timed out after 30s'));
    }, 30_000);

    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.addEventListener('error', (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const detail = (event as Event & { message?: string }).message;
      reject(
        new Error(
          `Agent WebSocket connection failed${detail ? `: ${detail}` : ''}`,
        ),
      );
    });

    // Capture failed-upgrade information that the 'error' event drops on
    // the floor (Node's WebSocket doesn't expose upgrade-response status).
    // Close-during-connect carries the only useful diagnostic the runtime
    // offers — surface it so users can distinguish auth from network failure.
    ws.addEventListener('close', (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Agent WebSocket closed during connect: ${describeConnectCloseCode(event.code, event.reason || '')}`,
        ),
      );
    });
  });

const sendMessage = (
  ws: WebSocket,
  msg: AgentMessage,
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<AgentResponse> =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener('message', handler);
      ws.removeEventListener('close', closeHandler);
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Agent command "${msg.method}" timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    const closeHandler = () => {
      cleanup();
      reject(
        new Error(
          `WebSocket closed while waiting for "${msg.method}" response`,
        ),
      );
    };

    const handler = (event: MessageEvent) => {
      let response: AgentResponse;
      try {
        response = JSON.parse(String(event.data)) as AgentResponse;
      } catch {
        console.error(
          '[agent-client] dropping unparseable WS frame:',
          String(event.data).slice(0, 200),
        );
        return;
      }
      // Only accept the response whose id matches the request we sent.
      if (response.id !== msg.id) return;
      cleanup();
      resolve(response);
    };

    ws.addEventListener('message', handler);
    ws.addEventListener('close', closeHandler);
    ws.send(JSON.stringify(msg));
  });

export const getOrCreateSession = async (
  mcpSessionId: string | undefined,
  apiUrl: string,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
): Promise<ActiveSession> => {
  sweepSessions();
  const key = getSessionKey(mcpSessionId, token, proxy, profile);
  const existing = sessions.get(key);

  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  // Another caller is already creating a session for this key — share it.
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  // Clean up stale session if any
  if (existing) {
    try {
      existing.ws.close();
    } catch {
      /* ignore */
    }
    sessions.delete(key);
  }

  const creation = (async (): Promise<ActiveSession> => {
    const ws = await connect(apiUrl, token, proxy, profile);
    const session: ActiveSession = {
      ws,
      msgId: 0,
      apiUrl,
      token,
      proxy,
      profile,
      skillState: createSkillState(),
      lastUsedAt: Date.now(),
    };

    // Auto-cleanup on close
    ws.addEventListener('close', (event) => {
      if (event.code !== 1000) {
        console.error(
          `[agent-client] WebSocket closed unexpectedly: code=${event.code} reason=${event.reason || 'none'}`,
        );
      }
      const current = sessions.get(key);
      if (current?.ws === ws) {
        sessions.delete(key);
      }
    });

    sessions.set(key, session);
    return session;
  })();

  pending.set(key, creation);
  try {
    return await creation;
  } finally {
    // Clear the placeholder whether connect succeeded or threw, so a failed
    // attempt doesn't block future retries.
    if (pending.get(key) === creation) {
      pending.delete(key);
    }
  }
};

export const send = async (
  session: ActiveSession,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<AgentResponse> => {
  if (session.ws.readyState !== WebSocket.OPEN) {
    if (!session.reconnecting) {
      session.reconnecting = connect(
        session.apiUrl,
        session.token,
        session.proxy,
        session.profile,
      ).finally(() => {
        session.reconnecting = undefined;
      });
    }
    const ws = await session.reconnecting;

    if (session.ws !== ws) {
      session.ws = ws;
      session.msgId = 0;

      const key = [...sessions.entries()].find(([, s]) => s === session)?.[0];
      if (key) {
        ws.addEventListener('close', () => {
          const current = sessions.get(key);
          if (current?.ws === ws) {
            sessions.delete(key);
          }
        });
      }
    }
  }

  session.msgId++;
  session.lastUsedAt = Date.now();
  return sendMessage(
    session.ws,
    { id: session.msgId, method, params },
    timeoutMs,
  );
};

export const closeSession = (
  mcpSessionId: string | undefined,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
): void => {
  const key = getSessionKey(mcpSessionId, token, proxy, profile);
  const session = sessions.get(key);
  if (session) {
    try {
      session.ws.close();
    } catch {
      /* ignore */
    }
    sessions.delete(key);
  }
};

/**
 * Force-destroy a session. Used when the server signals the browser has
 * crashed or the session is otherwise unrecoverable, so the next tool
 * call will create a fresh connection instead of reusing a dead one.
 * Unlike `closeSession`, this also drops any in-flight connect for the
 * same key so a concurrent `getOrCreateSession` won't resolve to a doomed
 * WebSocket.
 */
export const destroySession = (
  mcpSessionId: string | undefined,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
): void => {
  const key = getSessionKey(mcpSessionId, token, proxy, profile);
  const session = sessions.get(key);
  if (session) {
    try {
      session.ws.close();
    } catch {
      /* ignore */
    }
    sessions.delete(key);
  }
  pending.delete(key);
};
