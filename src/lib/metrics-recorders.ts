// Thin, no-op-safe metric recorders, split out from metrics.ts so the lib
// modules that call them (agent-client, session-reaper, define-tool, index) do
// not import the OTel-SDK module — metrics.ts imports THEM for its observable
// gauges, and a reverse import would be a cycle. This module imports only the
// OTel API (never the SDK, never the lib modules), so it sits at the bottom of
// the graph.
//
// Every recorder is safe to call on any transport and from any hot path: the
// instruments are created once (createSyncInstruments, from initTelemetry,
// against the started provider) and are undefined until then, so each recorder
// no-ops before init and never throws into the calling path.

import { metrics, type Counter, type Histogram } from '@opentelemetry/api';
import { hashToken } from './utils.js';

export const METER_NAME = 'browserless-mcp';

// Per-window per-account load, for abuse / top-talker attribution. Keyed by a
// one-way SHA-256 hash of the token (hashToken) — never the raw token, which is a
// secret — so a flooding account is identifiable without exposing its credential.
// Bounded two ways: it only accumulates while telemetry is active (so stdio never
// grows it), and the window is cleared every export (so size is one window's
// distinct accounts), and only the top N are emitted (so label cardinality is
// capped regardless of how many accounts are active).
const TOP_ACCOUNTS = 20;
// Hard cap on distinct accounts tracked per window. Any non-empty token is
// accepted before backend validation, so a flood of distinct bogus tokens could
// otherwise grow this map without bound between exports (TOP_ACCOUNTS caps only
// what is emitted, not the map). Once full we drop NEW hashes but keep counting
// existing ones, so real top-talkers are still attributed and the flood still
// shows up as a pinned-high accounts.active.
const MAX_WINDOW_ACCOUNTS = 10_000;
const accountWindow = new Map<string, number>();
let accountsEnabled = false;

let toolRequests: Counter | undefined;
let toolDuration: Histogram | undefined;
let upstreamDuration: Histogram | undefined;
let redisDuration: Histogram | undefined;
let redisErrors: Counter | undefined;
let sessionLifetime: Histogram | undefined;
let mcpRequests: Counter | undefined;
let mcpDuration: Histogram | undefined;
let gcPause: Histogram | undefined;

// Inbound MCP requests (POST /mcp) authenticating now; read by the metrics.ts
// gauge, maintained by the authenticate hook via mcpInFlightAdd.
let mcpInFlight = 0;

/** Create the sync instruments once the provider is started (from initTelemetry). */
export const createSyncInstruments = (): void => {
  const meter = metrics.getMeter(METER_NAME);
  toolRequests = meter.createCounter('browserless.mcp.tool.requests', {
    description: 'MCP tool invocations, by tool and outcome',
  });
  toolDuration = meter.createHistogram('browserless.mcp.tool.duration_ms', {
    description: 'MCP tool invocation duration',
    unit: 'ms',
  });
  upstreamDuration = meter.createHistogram(
    'browserless.mcp.agent.upstream.duration_ms',
    {
      description:
        'Agent upstream command round-trip duration (browser runtime)',
      unit: 'ms',
    },
  );
  redisDuration = meter.createHistogram(
    'browserless.mcp.redis.op.duration_ms',
    {
      description: 'Redis operation duration (OAuth state store)',
      unit: 'ms',
    },
  );
  redisErrors = meter.createCounter('browserless.mcp.redis.errors', {
    description: 'Redis client errors (cumulative)',
  });
  sessionLifetime = meter.createHistogram(
    'browserless.mcp.session.lifetime_ms',
    {
      description: 'Session lifetime at close, by kind (mcp | agent)',
      unit: 'ms',
    },
  );
  mcpRequests = meter.createCounter('browserless.mcp.requests', {
    description: 'Inbound MCP requests (POST /mcp), by authentication outcome',
  });
  mcpDuration = meter.createHistogram('browserless.mcp.request.duration_ms', {
    description: 'Inbound MCP request authentication duration (POST /mcp)',
    unit: 'ms',
  });
  gcPause = meter.createHistogram('browserless.mcp.gc.pause_ms', {
    description: 'V8 garbage-collection pause duration',
    unit: 'ms',
  });
  accountsEnabled = true;
};

/** Drop the instruments on shutdown so a later record no-ops against a dead provider. */
export const resetSyncInstruments = (): void => {
  toolRequests = undefined;
  toolDuration = undefined;
  upstreamDuration = undefined;
  redisDuration = undefined;
  redisErrors = undefined;
  sessionLifetime = undefined;
  mcpRequests = undefined;
  mcpDuration = undefined;
  gcPause = undefined;
  accountsEnabled = false;
  accountWindow.clear();
};

/**
 * Record one completed tool invocation. Safe on any transport — a no-op until
 * telemetry is started. Never throws into the tool flow.
 */
export const recordToolRequest = (
  tool: string,
  success: boolean,
  durationMs: number,
  errorCategory?: string,
): void => {
  if (!toolRequests) return;
  try {
    const attrs: Record<string, string | boolean> = { tool, success };
    if (!success && errorCategory) attrs.error_category = errorCategory;
    toolRequests.add(1, attrs);
    if (Number.isFinite(durationMs)) toolDuration?.record(durationMs, attrs);
  } catch {
    // Telemetry must never break a tool call.
  }
};

/** Record an agent upstream command round-trip (to the browser runtime). */
export const recordUpstreamCall = (
  method: string,
  success: boolean,
  durationMs: number,
): void => {
  if (!upstreamDuration || !Number.isFinite(durationMs)) return;
  try {
    upstreamDuration.record(durationMs, { method, success });
  } catch {
    /* never break the command path */
  }
};

/** Record a Redis operation's duration (OAuth state store). */
export const recordRedisOp = (
  op: string,
  success: boolean,
  durationMs: number,
): void => {
  if (!redisDuration || !Number.isFinite(durationMs)) return;
  try {
    redisDuration.record(durationMs, { op, success });
  } catch {
    /* never break the Redis path */
  }
};

/** Count one Redis client error. */
export const recordRedisError = (): void => {
  try {
    redisErrors?.add(1);
  } catch {
    /* ignore */
  }
};

/** Record a closed session's lifetime. kind: 'mcp' (reaped) | 'agent' (swept/closed). */
export const recordSessionLifetime = (
  kind: 'mcp' | 'agent',
  ageMs: number,
): void => {
  if (!sessionLifetime || !Number.isFinite(ageMs) || ageMs < 0) return;
  try {
    sessionLifetime.record(ageMs, { kind });
  } catch {
    /* ignore */
  }
};

/** Record an inbound MCP request (POST /mcp) when auth settles, via FastMCP's
 *  authenticate hook: durationMs = auth latency, outcome = pass/fail. Never throws. */
export const recordMcpRequest = (
  outcome: 'authenticated' | 'rejected',
  durationMs: number,
): void => {
  if (!mcpRequests) return;
  try {
    mcpRequests.add(1, { outcome });
    if (Number.isFinite(durationMs))
      mcpDuration?.record(durationMs, { outcome });
  } catch {
    /* never break request handling */
  }
};

/** Record a V8 GC pause (called by metrics.ts's PerformanceObserver). */
export const recordGcPause = (durationMs: number): void => {
  if (!gcPause || !Number.isFinite(durationMs)) return;
  try {
    gcPause.record(durationMs);
  } catch {
    /* ignore */
  }
};

/** Adjust the in-flight MCP-request gauge (+1 on entry, -1 on completion). */
export const mcpInFlightAdd = (delta: number): void => {
  mcpInFlight += delta;
};

/** Current in-flight MCP-request count (read by the observable gauge). */
export const getMcpInFlight = (): number => mcpInFlight;

/** Attribute one unit of load to an account (hashed token). No-op until started. */
export const noteAccountRequest = (token: string | undefined): void => {
  if (!accountsEnabled || !token) return;
  const hash = hashToken(token);
  if (!accountWindow.has(hash) && accountWindow.size >= MAX_WINDOW_ACCOUNTS)
    return;
  accountWindow.set(hash, (accountWindow.get(hash) ?? 0) + 1);
};

export interface AccountWindow {
  /** Distinct accounts (hashed) that drove load this window. */
  active: number;
  /** The heaviest accounts this window; `hash` is a one-way SHA-256 token hash. */
  top: Array<{ hash: string; count: number }>;
}

/**
 * Read and reset the account-load window. Called once per export by the
 * observable callback, so each export reflects one window and the map stays
 * bounded. Returns the distinct-account count and the top-N heaviest accounts.
 */
export const collectAccountWindow = (): AccountWindow => {
  const active = accountWindow.size;
  const top = [...accountWindow.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ACCOUNTS)
    .map(([hash, count]) => ({ hash, count }));
  accountWindow.clear();
  return { active, top };
};
