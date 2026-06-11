import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { z } from 'zod';
import { createSkillState } from '../skills/index.js';
import { hashToken, isMeaningfulBody } from './utils.js';
import type { CreateProfileParams } from '../tools/schemas.js';
import type {
  ActiveSession,
  AgentMessage,
  AgentResponse,
  ProxyOptions,
} from '../@types/types.js';

// Re-export the protocol types consumers of `@browserless.io/mcp/agent-client`
// need (e.g. a hosted Agent constructor that takes `proxy?: ProxyOptions`).
export type {
  ProxyOptions,
  ActiveSession,
  AgentMessage,
  AgentResponse,
  AgentError,
} from '../@types/types.js';

/* ------------------------------------------------------------------ */
/*  Proxy schemas — used by agent.ts's AgentParamsSchema and by the    */
/*  session key fingerprinting below. Co-located here to avoid a       */
/*  circular dep with agent.ts.                                         */
/* ------------------------------------------------------------------ */

const ProxyOptionsObjectSchema = z.object({
  proxy: z
    .enum(['residential'])
    .optional()
    .describe('Routing tier. Only "residential" is supported today.'),
  proxyCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'Must be a 2-letter ISO-2 country code')
    .transform((v) => v.toLowerCase())
    .optional()
    .describe('ISO-2 country code (e.g. "us", "de"). Normalized to lowercase.'),
  proxyState: z
    .string()
    .optional()
    .describe(
      'US state name (whitespace replaced with underscores, e.g. "new_york"). ' +
        'Plan-gated — non-eligible tokens get a 401.',
    ),
  proxyCity: z
    .string()
    .optional()
    .describe(
      'City-level targeting. Requires paid/enterprise plan — non-eligible tokens get a 401.',
    ),
  proxySticky: z
    .boolean()
    .optional()
    .describe(
      'Stable IP while the underlying WebSocket stays open. Reconnects ' +
        '(idle drop, network blip, browser crash) allocate a new sticky id.',
    ),
  proxyLocaleMatch: z
    .boolean()
    .optional()
    .describe('Match navigator locale to the proxy IP country.'),
  proxyPreset: z
    .string()
    .optional()
    .describe(
      'Named proxy preset (e.g. "px_amazon01"). Supported presets are ' +
        'plan-dependent; ask Browserless support for the list available to your token.',
    ),
  externalProxyServer: z
    .string()
    .regex(
      /^https?:\/\//i,
      'externalProxyServer must start with http:// or https://',
    )
    .optional()
    .describe('Bring-your-own upstream, e.g. http://user:pass@host:port'),
});

const DEPENDENT_PROXY_FIELDS = [
  'proxyCountry',
  'proxyState',
  'proxyCity',
  'proxySticky',
  'proxyLocaleMatch',
  'proxyPreset',
] as const;

export const ProxyOptionsSchema = ProxyOptionsObjectSchema.refine(
  (v) => {
    const hasDependent = DEPENDENT_PROXY_FIELDS.some((k) => v[k] !== undefined);
    return (
      !hasDependent || v.proxy === 'residential' || !!v.externalProxyServer
    );
  },
  {
    message:
      'proxyCountry/proxyState/proxyCity/proxySticky/proxyLocaleMatch/proxyPreset ' +
      "require proxy: 'residential' or externalProxyServer to be set; otherwise the API silently ignores them.",
  },
);

export const PROXY_FIELDS = Object.keys(
  ProxyOptionsObjectSchema.shape,
) as Array<keyof ProxyOptions>;

/**
 * Thrown when the agent WebSocket upgrade is rejected with a non-101 HTTP
 * response. Carries the status code and body so the tool layer can render a
 * status-specific UserError.
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
 * UpgradeError specialization for the profile-not-found case (404 on the WS
 * upgrade when `?profile=` was supplied). Mirrors api-client.ts so all tools
 * surface profile errors through the same UserError pattern.
 */
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

// Upgrade statuses where a one-shot retry cannot help: bad request (400),
// bad auth (401), forbidden by plan/policy (403), or missing resource (404).
// Retrying just wastes time and emits a misleading "second attempt failed".
const NON_RETRYABLE_UPGRADE_STATUSES = new Set([400, 401, 403, 404]);

export const isRetryableUpgradeError = (err: unknown): boolean => {
  if (err instanceof UpgradeError) {
    // A 2xx UpgradeError is a structurally-bad success response — retrying
    // can't fix the shape (and may duplicate side effects), so don't.
    if (err.statusCode >= 200 && err.statusCode < 300) return false;
    return !NON_RETRYABLE_UPGRADE_STATUSES.has(err.statusCode);
  }
  return true;
};

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

// Hash externalProxyServer rather than serialize it raw: the session key is
// logged on eviction and the URL may carry user:pass credentials. Hashing
// keeps per-upstream distinctness without putting secrets in stderr.
const fingerprintValue = (
  field: (typeof PROXY_FIELDS)[number],
  value: unknown,
): string =>
  field === 'externalProxyServer'
    ? `external#${hashToken(String(value))}`
    : String(value);

/**
 * Build a stable, credential-free key segment for a proxy config — identical
 * configs fingerprint the same regardless of key order. `externalProxyServer`
 * is SHA-256 hashed so credentials never land in the eviction log.
 */
export const proxyFingerprint = (proxy?: ProxyOptions): string => {
  if (!proxy) return '';
  const parts = PROXY_FIELDS.map((k) =>
    proxy[k] === undefined ? null : `${k}=${fingerprintValue(k, proxy[k])}`,
  ).filter(Boolean);
  return parts.length ? KEY_SEP + parts.join('&') : '';
};

// Hash the profile rather than serialize it raw: like externalProxyServer,
// the eviction-logged session key may otherwise leak a user-identifying
// profile name. Hashing keeps per-profile distinctness without that leak.
const getSessionKey = (
  mcpSessionId: string | undefined,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
  createProfile?: CreateProfileParams,
  attachSessionId?: string,
): string =>
  (mcpSessionId ?? `stdio:${hashToken(token)}`) +
  proxyFingerprint(proxy) +
  (profile ? KEY_SEP + 'profile#' + hashToken(profile) : '') +
  (createProfile ? KEY_SEP + 'create#' + hashToken(createProfile.name) : '') +
  (attachSessionId ? KEY_SEP + 'attach#' + attachSessionId : '');

/**
 * Build the WebSocket URL for `/chromium/agent`: normalize trailing slashes,
 * swap http(s)→ws(s), and append `token` plus proxy params. Boolean proxy
 * flags follow the API's presence-only contract (set only when truthy).
 */
export const buildAgentWsUrl = (
  apiUrl: string,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
  sessionId?: string,
): string => {
  const base = apiUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const url = new URL(base + '/chromium/agent');
  url.searchParams.set('token', token);
  // A creation session already owns its proxy/profile (baked in at POST /profile);
  // the WS only needs to attach to it by id, so proxy/profile params are skipped.
  if (sessionId) {
    url.searchParams.set('sessionId', sessionId);
    return url.toString();
  }
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
const READ_TIMEOUT_MARKER = '\n…[response body read timed out]';

// Bound the body-read phase so a server that sends non-101 headers and then
// stalls the body stream can't hang connect() indefinitely. The connect-level
// 30s timeout has already been cleared by the time we get here.
const UPGRADE_BODY_READ_TIMEOUT_MS = 10_000;

const readUpgradeError = (
  res: IncomingMessage,
  profile: string | undefined,
): Promise<UpgradeError> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const readTimeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // res.destroy() fires 'close' → finish() → resolve with whatever
      // bytes arrived before the deadline.
      res.destroy();
    }, UPGRADE_BODY_READ_TIMEOUT_MS);

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
      console.error(
        `[agent-client] upgrade-response stream error: ${err.message}`,
      );
      finish();
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(readTimeout);
      res.off('data', onData);
      res.off('end', finish);
      res.off('error', onError);
      res.off('close', finish);
      // Some upstream stacks prepend an extra CRLF between the header block
      // and the body — trim so renderers don't open with a blank line.
      let body = Buffer.concat(chunks).toString('utf8').trim();
      if (truncated) body += TRUNCATION_MARKER;
      else if (timedOut) body += READ_TIMEOUT_MARKER;
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

/** Result of POST /profile: a tracked, non-headless creation session. */
interface CreationSessionInfo {
  id: string;
  name: string;
  connect: string;
  stop: string;
}

// POST /profile launches a non-headless browser, which can take several seconds.
const CREATE_PROFILE_TIMEOUT_MS = 60_000;

/**
 * Open a profile-creation session via POST /profile. Returns the tracked
 * session id the agent WS then attaches to with `?sessionId`. Non-2xx responses
 * throw UpgradeError so the tool layer's retry/4xx classification applies
 * uniformly with the WS-upgrade path.
 */
const postCreateProfile = async (
  apiUrl: string,
  token: string,
  createProfile: CreateProfileParams,
): Promise<CreationSessionInfo> => {
  const base = apiUrl.replace(/\/+$/, '');
  const url = new URL(base + '/profile');
  url.searchParams.set('token', token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_PROFILE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createProfile),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      `POST /profile failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new UpgradeError(res.status, res.statusText, body);
  }
  const json: unknown = await res.json();
  if (
    typeof json !== 'object' ||
    json === null ||
    typeof (json as { id?: unknown }).id !== 'string' ||
    !(json as { id: string }).id
  ) {
    throw new UpgradeError(
      res.status,
      res.statusText,
      `POST /profile returned a malformed response (missing or invalid "id")`,
    );
  }
  return json as CreationSessionInfo;
};

const connect = (
  apiUrl: string,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
  sessionId?: string,
): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const wsUrl = buildAgentWsUrl(apiUrl, token, proxy, profile, sessionId);
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
  createProfile?: CreateProfileParams,
  attachSessionId?: string,
): Promise<ActiveSession> => {
  sweepSessions();
  const key = getSessionKey(
    mcpSessionId,
    token,
    proxy,
    profile,
    createProfile,
    attachSessionId,
  );
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
    // Three modes for the session to attach to:
    //  - attachSessionId: a session the caller already created (autologin
    //    runner did POST /profile itself) — attach by id, no POST here.
    //  - createProfile: open a tracked session via POST /profile, then attach.
    //  - neither: launch a fresh agent browser.
    const creationSessionId = attachSessionId
      ? attachSessionId
      : createProfile
        ? (await postCreateProfile(apiUrl, token, createProfile)).id
        : undefined;
    const ws = await connect(apiUrl, token, proxy, profile, creationSessionId);
    const session: ActiveSession = {
      ws,
      msgId: 0,
      apiUrl,
      token,
      proxy,
      profile,
      createProfile,
      creationSessionId,
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
      // A creation session must re-attach to the same browser by id — a fresh
      // connect() would launch a new one and lose all auth progress.
      session.reconnecting = connect(
        session.apiUrl,
        session.token,
        session.proxy,
        session.profile,
        session.creationSessionId,
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
  createProfile?: CreateProfileParams,
  attachSessionId?: string,
): void => {
  const key = getSessionKey(
    mcpSessionId,
    token,
    proxy,
    profile,
    createProfile,
    attachSessionId,
  );
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
 * Force-destroy a session after a browser crash or unrecoverable state, so
 * the next call reconnects fresh. Unlike `closeSession`, it also drops any
 * in-flight connect for the key so a concurrent caller can't reuse a dead WS.
 */
export const destroySession = (
  mcpSessionId: string | undefined,
  token: string,
  proxy?: ProxyOptions,
  profile?: string,
  createProfile?: CreateProfileParams,
  attachSessionId?: string,
): void => {
  const key = getSessionKey(
    mcpSessionId,
    token,
    proxy,
    profile,
    createProfile,
    attachSessionId,
  );
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
