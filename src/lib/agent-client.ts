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

import { createSkillState } from '../skills/index.js';
import type { SkillFireState } from '../skills/index.js';

export interface ActiveSession {
  ws: WebSocket;
  msgId: number;
  apiUrl: string;
  token: string;
  reconnecting?: Promise<WebSocket>;
  skillState: SkillFireState;
  lastUsedAt: number;
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

const getSessionKey = (
  mcpSessionId: string | undefined,
  token: string,
): string => mcpSessionId ?? `stdio:${token}`;

const connect = (apiUrl: string, token: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const wsUrl = `${apiUrl.replace(/^http/, 'ws')}/chromium/agent?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Agent WebSocket connection timed out after 30s'));
    }, 30_000);

    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });

    ws.addEventListener('error', (event) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Agent WebSocket connection failed: ${(event as Event & { message?: string }).message ?? 'unknown error'}`,
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
): Promise<ActiveSession> => {
  sweepSessions();
  const key = getSessionKey(mcpSessionId, token);
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
    const ws = await connect(apiUrl, token);
    const session: ActiveSession = {
      ws,
      msgId: 0,
      apiUrl,
      token,
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
      session.reconnecting = connect(session.apiUrl, session.token).finally(
        () => {
          session.reconnecting = undefined;
        },
      );
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
): void => {
  const key = getSessionKey(mcpSessionId, token);
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
 */
export const destroySession = (
  mcpSessionId: string | undefined,
  token: string,
): void => {
  const key = getSessionKey(mcpSessionId, token);
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
