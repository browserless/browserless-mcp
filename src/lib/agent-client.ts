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
import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { createSkillState } from '../skills/index.js';
import type { SkillFireState } from '../skills/index.js';
import { PROXY_FIELDS } from '../tools/schemas.js';
import type { ProxyOptions } from '../tools/schemas.js';

/**
 * Thrown when the agent WebSocket upgrade is rejected with a non-101 HTTP
 * response. Carries the server's status code and response body so the tool
 * layer can render a status-specific UserError.
 */
export class UpgradeError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusMessage: string,
    public readonly body: string,
  ) {
    const detail = body.trim() || statusMessage || 'no body';
    super(`Agent WebSocket upgrade rejected: HTTP ${statusCode} — ${detail}`);
    this.name = 'UpgradeError';
  }
}

/**
 * Specialization of UpgradeError for the profile-not-found case (HTTP 404 on
 * the WS upgrade when `?profile=` was supplied). Mirrors the typed error in
 * api-client.ts so smart-scrape, crawl, and agent all surface profile errors
 * through the same UserError pattern.
 */
// Reject server bodies that are obviously not a real message — empty, just
// whitespace, or a literal `null`/`undefined` from a misbehaving JSON layer.
// In those cases we'd rather surface the canned fallback than echo garbage.
const isMeaningfulBody = (s: string): boolean =>
  s.length > 0 && !/^(?:null|undefined)$/i.test(s);

export class ProfileNotFoundError extends UpgradeError {
  constructor(
    public readonly profile: string,
    statusMessage: string,
    body: string,
  ) {
    super(404, statusMessage, body);
    this.name = 'ProfileNotFoundError';
    const trimmed = body.trim();
    this.message = isMeaningfulBody(trimmed)
      ? trimmed
      : `Profile "${profile}" was not found for the configured token.`;
  }
}

// Upgrade statuses where a one-shot retry cannot help: the request is
// structurally bad (400), auth is wrong (401), the plan or policy forbids it
// (403), or a referenced resource is absent (404). Retrying just wastes time
// and emits a misleading "second attempt also failed" message to the user.
const NON_RETRYABLE_UPGRADE_STATUSES = new Set([400, 401, 403, 404]);

export const isRetryableUpgradeError = (err: unknown): boolean => {
  if (err instanceof UpgradeError) {
    return !NON_RETRYABLE_UPGRADE_STATUSES.has(err.statusCode);
  }
  return true;
};

export interface ActiveSession {
  ws: WebSocket;
  msgId: number;
  // Identity fields: these feed the session-cache key (see getSessionKey).
  // Mutating them post-creation would desync the cache, so they're readonly.
  readonly apiUrl: string;
  readonly token: string;
  readonly proxy?: ProxyOptions;
  readonly profile?: string;
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

// HTTP-status failures arrive on `unexpected-response` (typed as
// UpgradeError), so a 1006 close here only means a transport failure or a
// server crash before any HTTP response.
const describeConnectCloseCode = (code: number, reason: string): string => {
  if (reason) return `code=${code}, reason="${reason}"`;
  if (code === 1006)
    return 'code=1006 (abnormal close before HTTP response — likely a network failure or server crash)';
  if (code === 1008) return 'code=1008 (policy violation)';
  if (code === 1011) return 'code=1011 (server error during upgrade)';
  return `code=${code}`;
};

// Decode the Node `Error.code` field that `ws` propagates from the underlying
// socket on transport failure (DNS, refused connection, TLS validation).
const describeConnectErrorCode = (err: unknown): string | undefined => {
  if (!err || typeof err !== 'object') return;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return;
  switch (code) {
    case 'ENOTFOUND':
      return 'DNS resolution failed (ENOTFOUND) — verify the apiUrl host';
    case 'ECONNREFUSED':
      return 'Connection refused (ECONNREFUSED) — server may be down or the port is blocked';
    case 'ETIMEDOUT':
      return 'Connection timed out (ETIMEDOUT) — network or firewall issue';
    case 'ECONNRESET':
      return 'Connection reset by peer (ECONNRESET)';
    case 'CERT_HAS_EXPIRED':
      return 'TLS certificate expired (CERT_HAS_EXPIRED)';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `TLS verification failed (${code})`;
    default:
      return `network error (${code})`;
  }
};

// Bound the body buffer so a misbehaving or malicious server can't OOM the
// MCP process by streaming gigabytes into an error response. 64 KiB is far
// more than any legitimate plain-text error or sanitized HTML page needs.
const MAX_UPGRADE_BODY_BYTES = 64 * 1024;

const TRUNCATION_MARKER = `\n…[response truncated at ${MAX_UPGRADE_BODY_BYTES} bytes]`;

const readUpgradeError = (
  res: IncomingMessage,
  profile: string | undefined,
): Promise<UpgradeError> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let settled = false;

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_UPGRADE_BODY_BYTES) {
        const overflow = total - MAX_UPGRADE_BODY_BYTES;
        chunks.push(chunk.subarray(0, chunk.length - overflow));
        truncated = true;
        // Resolve eagerly with the truncated payload — `res.destroy()` may
        // suppress the 'end' event, so don't wait for it.
        res.destroy();
        finish();
        return;
      }
      chunks.push(chunk);
    };

    const onError = (err: Error): void => {
      // Stream errors mid-body (TLS abort, decompression failure) would
      // otherwise vanish into an UpgradeError with a partial body. Log so
      // operators see the root cause; still settle with whatever was buffered.
      console.error(`[agent-client] upgrade-response stream error: ${err.message}`);
      finish();
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      res.off('data', onData);
      res.off('end', finish);
      res.off('error', onError);
      res.off('close', finish);
      // Some upstream stacks prepend an extra CRLF between the header block
      // and the body — trim so renderers don't open with a blank line.
      let body = Buffer.concat(chunks).toString('utf8').trim();
      if (truncated) body += TRUNCATION_MARKER;
      const status = res.statusCode ?? 0;
      const statusMessage = res.statusMessage ?? '';
      if (status === 404 && profile) {
        resolve(new ProfileNotFoundError(profile, statusMessage, body));
        return;
      }
      resolve(new UpgradeError(status, statusMessage, body));
    };

    res.on('data', onData);
    res.on('end', finish);
    res.on('error', onError);
    // `res.destroy()` can fire 'close' without 'end' or 'error'; settle here too.
    res.on('close', finish);
  });

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

    const settle = (err: Error | null, value?: WebSocket): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        reject(err);
      } else {
        resolve(value!);
      }
    };

    const timeout = setTimeout(() => {
      settle(new Error('Agent WebSocket connection timed out after 30s'));
    }, 30_000);

    ws.on('open', () => settle(null, ws));

    // Claim `settled` synchronously so the close/error events that race the
    // async body read can't overwrite the typed UpgradeError we're building.
    ws.on('unexpected-response', (_req, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      readUpgradeError(res, profile).then((err) => {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        reject(err);
      });
    });

    ws.on('error', (err: Error) => {
      const decoded = describeConnectErrorCode(err);
      const detail = decoded ?? err.message ?? '';
      settle(
        new Error(
          `Agent WebSocket connection failed${detail ? `: ${detail}` : ''}`,
        ),
      );
    });

    // Close before settle means the transport dropped without ever producing
    // an HTTP response; auth/proxy/profile failures are handled by the
    // `unexpected-response` branch above.
    ws.on('close', (code: number, reason: Buffer) => {
      settle(
        new Error(
          `Agent WebSocket closed during connect: ${describeConnectCloseCode(code, reason?.toString('utf8') || '')}`,
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
      ws.off('message', handler);
      ws.off('close', closeHandler);
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

    const handler = (data: WebSocket.RawData) => {
      let response: AgentResponse;
      const raw = data.toString('utf8');
      try {
        response = JSON.parse(raw) as AgentResponse;
      } catch {
        console.error(
          '[agent-client] dropping unparseable WS frame:',
          raw.slice(0, 200),
        );
        return;
      }
      // Only accept the response whose id matches the request we sent.
      if (response.id !== msg.id) return;
      cleanup();
      resolve(response);
    };

    ws.on('message', handler);
    ws.on('close', closeHandler);
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
    ws.on('close', (code: number, reason: Buffer) => {
      if (code !== 1000) {
        console.error(
          `[agent-client] WebSocket closed unexpectedly: code=${code} reason=${reason?.toString('utf8') || 'none'}`,
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
        ws.on('close', () => {
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
