/**
 * WebSocket client for the Browserless Agent Protocol.
 *
 * Manages persistent WebSocket connections to /chromium/agent endpoints.
 * Each connection represents a browser session that persists across tool calls.
 * Connections are keyed by MCP session ID so each MCP client gets its own browser.
 */

export interface AgentMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface AgentResponse {
  id: number;
  result?: unknown;
  error?: { message: string };
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

export interface SnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
  time: number;
}

interface ActiveSession {
  ws: WebSocket;
  msgId: number;
  apiUrl: string;
  token: string;
}

const sessions = new Map<string, ActiveSession>();

const DEFAULT_TIMEOUT = 60_000;

/**
 * Derive a stable session key. For stdio transport there's no MCP session ID,
 * so we fall back to token-based keying (one browser per token).
 */
const sessionKey = (mcpSessionId: string | undefined, token: string): string =>
  mcpSessionId ?? `stdio:${token}`;

/**
 * Connect to the agent WebSocket endpoint and return the session.
 */
const connect = (
  apiUrl: string,
  token: string,
): Promise<WebSocket> =>
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
      reject(new Error(`Agent WebSocket connection failed: ${(event as Event & { message?: string }).message ?? 'unknown error'}`));
    });
  });

/**
 * Send a JSON-RPC message and wait for the response.
 */
const sendMessage = (
  ws: WebSocket,
  msg: AgentMessage,
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<AgentResponse> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Agent command "${msg.method}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const handler = (event: MessageEvent) => {
      clearTimeout(timeout);
      ws.removeEventListener('message', handler);
      try {
        resolve(JSON.parse(String(event.data)) as AgentResponse);
      } catch (e) {
        reject(new Error(`Invalid JSON response from agent: ${e}`));
      }
    };

    ws.addEventListener('message', handler);
    ws.send(JSON.stringify(msg));
  });

/**
 * Get or create an agent session for the given MCP session.
 */
export const getOrCreateSession = async (
  mcpSessionId: string | undefined,
  apiUrl: string,
  token: string,
): Promise<ActiveSession> => {
  const key = sessionKey(mcpSessionId, token);
  const existing = sessions.get(key);

  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    return existing;
  }

  // Clean up stale session if any
  if (existing) {
    try { existing.ws.close(); } catch { /* ignore */ }
    sessions.delete(key);
  }

  const ws = await connect(apiUrl, token);
  const session: ActiveSession = { ws, msgId: 0, apiUrl, token };

  // Auto-cleanup on close
  ws.addEventListener('close', () => {
    const current = sessions.get(key);
    if (current?.ws === ws) {
      sessions.delete(key);
    }
  });

  sessions.set(key, session);
  return session;
};

/**
 * Send a command to the agent browser session.
 * If the connection is closed, transparently reconnects with a fresh browser.
 */
export const agentSend = async (
  session: ActiveSession,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<AgentResponse> => {
  if (session.ws.readyState !== WebSocket.OPEN) {
    // Reconnect transparently — each new connection gets a fresh browser
    const ws = await connect(session.apiUrl, session.token);
    session.ws = ws;
    session.msgId = 0;

    // Re-register auto-cleanup
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

  session.msgId++;
  return sendMessage(
    session.ws,
    { id: session.msgId, method, params },
    timeoutMs,
  );
};

/**
 * Close an agent session.
 */
export const closeSession = (
  mcpSessionId: string | undefined,
  token: string,
): void => {
  const key = sessionKey(mcpSessionId, token);
  const session = sessions.get(key);
  if (session) {
    try { session.ws.close(); } catch { /* ignore */ }
    sessions.delete(key);
  }
};

/**
 * Check if a session exists and is open.
 */
export const hasActiveSession = (
  mcpSessionId: string | undefined,
  token: string,
): boolean => {
  const key = sessionKey(mcpSessionId, token);
  const session = sessions.get(key);
  return !!session && session.ws.readyState === WebSocket.OPEN;
};
