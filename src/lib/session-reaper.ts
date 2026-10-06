// Bounds FastMCP httpStream sessions so an abandoned client cannot leak server
// resources until the next process restart.
//
// Every FastMCPSession on the httpStream transport starts a keepalive ping on a
// 5-second `setInterval`. fastmcp clears that interval only in
// `FastMCPSession.close()`, but its disconnect paths (`#removeSession` and the
// httpStream `onClose` callback) merely splice the session out of the registry
// and emit `disconnect` — they never call `close()`. The live ping interval then
// pins the whole session graph (the MCP server, its transport, and the resolved
// Browserless auth payload) so it can never be garbage-collected, and keeps
// doing real work (a failing `server.ping()`) every 5s. Across the uptime of a
// long-running hosted server this is a steady, restart-only climb in memory,
// CPU, and load.
//
// Two paths cover the two ways a client goes away:
//   1. Clean / churned disconnect (the common case — remote clients replace the
//      transport between turns and after a 401): the `disconnect` handler in
//      index.ts calls `session.close()` directly, releasing the ping at once.
//   2. Abandoned transport (half-open socket, LB idle cut): `onClose` never
//      fires, so no `disconnect` arrives. This reaper is the backstop — it
//      closes sessions with no inbound activity for longer than a TTL.
//
// Inbound activity is recorded per mcp session id: `connect` stamps it, every
// tool invocation refreshes it (defineTool), and `disconnect` forgets it. A
// live-but-idle client that holds its stream open without issuing a tool call is
// reaped after the TTL and transparently reconnects; the TTL is deliberately
// generous so this is rare.

// 30 minutes of no inbound activity before an abandoned session is reaped.
const DEFAULT_TTL_MS = 30 * 60 * 1000;
// How often the backstop runs.
const DEFAULT_INTERVAL_MS = 60_000;
// setInterval's delay is a signed 32-bit int; larger values wrap to ~1ms.
const MAX_DELAY_MS = 2_147_483_647;

// mcp session id -> last time an inbound request was seen on it.
const lastSeen = new Map<string, number>();
// mcp session id -> count of tool executions currently in flight on it. A long
// call holds one request open with no further inbound activity, so without this
// it could be reaped mid-flight once its idle window elapsed.
const activeExec = new Map<string, number>();

/** Record inbound activity for an mcp session (connect and every tool call). */
export const touchSession = (
  id: string | undefined,
  now: number = Date.now(),
): void => {
  if (id) lastSeen.set(id, now);
};

/** Forget an mcp session's activity (on disconnect or after it is reaped). */
export const forgetSession = (id: string | undefined): void => {
  if (id) {
    lastSeen.delete(id);
    activeExec.delete(id);
  }
};

/** Mark a tool execution started on a session so the reaper won't close it. */
export const beginSessionExec = (id: string | undefined): void => {
  if (id) activeExec.set(id, (activeExec.get(id) ?? 0) + 1);
};

/** Mark a tool execution finished, and refresh the session's idle clock. */
export const endSessionExec = (
  id: string | undefined,
  now: number = Date.now(),
): void => {
  if (!id) return;
  const remaining = (activeExec.get(id) ?? 1) - 1;
  if (remaining > 0) activeExec.set(id, remaining);
  else activeExec.delete(id);
  lastSeen.set(id, now);
};

/** Number of sessions with tracked activity — diagnostics and tests. */
export const trackedSessionCount = (): number => lastSeen.size;

/** The subset of FastMCPSession this module needs; keeps the core testable. */
export interface ReapableSession {
  readonly sessionId?: string;
  close: () => Promise<void> | void;
}

const safeClose = (session: ReapableSession): void => {
  try {
    // close() clears the ping interval synchronously, then closes the server
    // asynchronously; the transport is usually already gone, so ignore errors.
    void Promise.resolve(session.close()).catch(() => {});
  } catch {
    /* ignore */
  }
};

/**
 * Close and forget every session whose last inbound activity is older than
 * `ttlMs`. A session seen for the first time here (never touched) is recorded
 * now and given a full TTL before it can be reaped. Sessions without an id
 * (stdio) are never reaped. Returns the number closed.
 */
export const reapIdleSessions = (
  getSessions: () => readonly ReapableSession[],
  {
    now = Date.now(),
    ttlMs = DEFAULT_TTL_MS,
  }: { now?: number; ttlMs?: number } = {},
): number => {
  let closed = 0;
  const liveIds = new Set<string>();
  // Snapshot first: closing an idle session synchronously splices it out of
  // FastMCP's live `server.sessions` array, which would skip the next entry if we
  // iterated that array directly — dropping a live session from liveIds and
  // letting the prune below delete its tracking and in-flight guard.
  const sessions = [...getSessions()];
  for (const session of sessions) {
    const id = session.sessionId;
    if (!id) continue;
    liveIds.add(id);
    // A tool execution in flight keeps the session alive and refreshed, so a
    // long-running call is never reaped mid-flight.
    if ((activeExec.get(id) ?? 0) > 0) {
      lastSeen.set(id, now);
      continue;
    }
    const seen = lastSeen.get(id);
    if (seen === undefined) {
      lastSeen.set(id, now);
      continue;
    }
    if (now - seen <= ttlMs) continue;
    safeClose(session);
    lastSeen.delete(id);
    closed++;
    console.error(`[session-reaper] closed idle mcp session id=${id}`);
  }
  // Drop tracking for ids with no live session. `touchSession` stamps the
  // mcp-session-id before auth (and rejected/unknown requests carry arbitrary
  // ids), so without this an unauthenticated caller could grow these maps
  // without bound. This bounds them to live sessions plus one sweep's transients.
  for (const id of lastSeen.keys()) if (!liveIds.has(id)) lastSeen.delete(id);
  for (const id of activeExec.keys())
    if (!liveIds.has(id)) activeExec.delete(id);
  return closed;
};

const clampDelay = (envName: string, fallback: number): number => {
  const configured = Number(process.env[envName]);
  return Number.isFinite(configured) &&
    configured >= 1 &&
    configured <= MAX_DELAY_MS
    ? configured
    : fallback;
};

const resolveTtlMs = (): number =>
  clampDelay('MCP_SESSION_TTL_MS', DEFAULT_TTL_MS);

let reapTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Start the backstop reaper. Idempotent; the timer is unref'd so it never keeps
 * the process alive. `MCP_SESSION_TTL_MS` tunes the idle window and
 * `MCP_SESSION_REAP_MS` the cadence (both clamped to a valid setInterval delay).
 */
export const startSessionReaper = (
  getSessions: () => readonly ReapableSession[],
): void => {
  if (reapTimer) return;
  const intervalMs = clampDelay('MCP_SESSION_REAP_MS', DEFAULT_INTERVAL_MS);
  reapTimer = setInterval(() => {
    // A reap error must never reach the event loop: an unhandled throw in a
    // timer crashes the whole process. Log and let the next tick retry.
    try {
      reapIdleSessions(getSessions, { ttlMs: resolveTtlMs() });
    } catch (err) {
      console.error(
        '[session-reaper] sweep failed:',
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
  }, intervalMs);
  reapTimer.unref();
};

export const stopSessionReaper = (): void => {
  if (reapTimer) clearInterval(reapTimer);
  reapTimer = undefined;
};

export const resetSessionReaperForTests = (): void => {
  stopSessionReaper();
  lastSeen.clear();
  activeExec.clear();
};
