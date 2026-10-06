// OpenTelemetry metrics + logs for the MCP server, exported over OTLP to a
// collector configured via OTEL_EXPORTER_OTLP_ENDPOINT. This module is the ONLY
// place that touches OpenTelemetry; the lib modules stay OTel-free and expose
// plain read accessors that the observable instruments below pull from.
//
// Safety contract (see initTelemetry / index.ts):
//   - Only started on the httpStream transport. In stdio mode stdout is the
//     JSON-RPC channel, so no exporter is ever constructed there and nothing can
//     pollute the protocol. All diagnostics here go to stderr (console.error).
//   - Started best-effort inside try/catch: a telemetry failure must never crash
//     or block the server. `recordToolRequest` is always safe to call — when the
//     SDK isn't started it resolves to a no-op meter.

import { metrics, type BatchObservableResult } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  trackedSessionCount,
  inFlightExecCount,
  reapedSessionTotal,
} from './session-reaper.js';
import {
  activeAgentSessionCount,
  inFlightCommandCount,
  sweptSessionTotal,
} from './agent-client.js';

const METER_NAME = 'browserless-mcp';
const DEFAULT_EXPORT_INTERVAL_MS = 60_000;

// Export cadence, overridable for ops tuning / tests. Floored at 1s so a fumbled
// value can't hammer the collector; anything invalid falls back to the default.
const resolveExportIntervalMs = (): number => {
  const parsed = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 1000
    ? parsed
    : DEFAULT_EXPORT_INTERVAL_MS;
};

export interface TelemetryOptions {
  /** OTLP base endpoint, e.g. http://localhost:4318 (signal paths appended). */
  endpoint: string;
  serviceName: string;
  serviceVersion: string;
  /** Live FastMCP httpStream session count (server.sessions.length). */
  getLiveSessionCount: () => number;
}

// Request instruments are created lazily so `recordToolRequest` is safe to call
// before (or without) init: `metrics.getMeter` returns a no-op meter until a
// global MeterProvider is registered, so every record is a no-op in stdio mode.
let toolRequests: ReturnType<
  ReturnType<typeof metrics.getMeter>['createCounter']
>;
let toolDuration: ReturnType<
  ReturnType<typeof metrics.getMeter>['createHistogram']
>;
const ensureRequestInstruments = (): void => {
  if (toolRequests) return;
  const meter = metrics.getMeter(METER_NAME);
  toolRequests = meter.createCounter('mcp.tool.requests', {
    description: 'MCP tool invocations, by tool and outcome',
  });
  toolDuration = meter.createHistogram('mcp.tool.duration_ms', {
    description: 'MCP tool invocation duration',
    unit: 'ms',
  });
};

/**
 * Record one completed tool invocation. Always safe to call — a no-op until
 * telemetry is started (stdio or disabled). Never throws.
 */
export const recordToolRequest = (
  tool: string,
  success: boolean,
  durationMs: number,
): void => {
  try {
    ensureRequestInstruments();
    const attrs = { tool, success };
    toolRequests.add(1, attrs);
    if (Number.isFinite(durationMs)) toolDuration.record(durationMs, attrs);
  } catch {
    // Telemetry must never break a tool call.
  }
};

let provider: MeterProvider | undefined;
let loggerProvider: LoggerProvider | undefined;
let restoreConsole: (() => void) | undefined;

// Mirror console.error / console.warn to OTLP logs so the server's existing
// stderr diagnostics also reach the collector, without rewriting every call
// site. Additive: the original console still writes to stderr. Only installed
// on the httpStream transport, so stdio's stdout protocol is never involved.
const bridgeConsole = (): (() => void) => {
  // Capture the raw originals (Node's console methods are safe to call
  // detached) so restore returns console to exactly what it was.
  const original = {
    error: console.error,
    warn: console.warn,
  };
  const logger = logs.getLogger(METER_NAME);
  const toBody = (args: unknown[]): string =>
    args
      .map((a) =>
        typeof a === 'string'
          ? a
          : a instanceof Error
            ? (a.stack ?? a.message)
            : (() => {
                try {
                  return JSON.stringify(a);
                } catch {
                  return String(a);
                }
              })(),
      )
      .join(' ');
  const mirror =
    (
      severityNumber: SeverityNumber,
      severityText: string,
      write: typeof original.error,
    ) =>
    (...args: unknown[]): void => {
      write(...args);
      try {
        logger.emit({ severityNumber, severityText, body: toBody(args) });
      } catch {
        // Never let a log-export failure break logging.
      }
    };
  console.error = mirror(SeverityNumber.ERROR, 'ERROR', original.error);
  console.warn = mirror(SeverityNumber.WARN, 'WARN', original.warn);
  return () => {
    console.error = original.error;
    console.warn = original.warn;
  };
};

/**
 * Start metrics + logs export to the OTLP collector. Hosted mode only; call
 * inside try/catch. Returns a shutdown fn that flushes the final batch.
 */
export const initTelemetry = (
  opts: TelemetryOptions,
): (() => Promise<void>) => {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion,
  });

  provider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${opts.endpoint}/v1/metrics`,
        }),
        exportIntervalMillis: resolveExportIntervalMs(),
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);

  loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${opts.endpoint}/v1/logs` }),
      }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  registerRuntimeInstruments(opts.getLiveSessionCount);
  restoreConsole = bridgeConsole();

  return async () => {
    restoreConsole?.();
    restoreConsole = undefined;
    try {
      // Flush the final batch, but never let a flush to an unreachable collector
      // block process exit (the OTLP export timeout is far longer than any
      // shutdown should wait). Race it against a short, unref'd deadline.
      await Promise.race([
        Promise.all([provider?.shutdown(), loggerProvider?.shutdown()]),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000).unref();
        }),
      ]);
    } catch {
      // Best-effort flush — a telemetry failure must not delay shutdown.
    } finally {
      provider = undefined;
      loggerProvider = undefined;
    }
  };
};

// Register the observable runtime + session-state instruments against one batch
// callback, so each export collects every signal in a single pass (and resets
// the event-loop-delay histogram exactly once per window).
const registerRuntimeInstruments = (
  getLiveSessionCount: () => number,
): void => {
  const meter = metrics.getMeter(METER_NAME);

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let prevElu = performance.eventLoopUtilization();

  const delayP50 = meter.createObservableGauge('mcp.eventloop.delay.p50_ms', {
    description: 'Event-loop delay, 50th percentile, over the export window',
    unit: 'ms',
  });
  const delayP99 = meter.createObservableGauge('mcp.eventloop.delay.p99_ms', {
    description: 'Event-loop delay, 99th percentile, over the export window',
    unit: 'ms',
  });
  const eluGauge = meter.createObservableGauge('mcp.eventloop.utilization', {
    description: 'Event-loop utilization (0..1) over the export window',
  });
  const memGauge = meter.createObservableGauge('mcp.process.memory_bytes', {
    description: 'Process memory usage',
    unit: 'By',
  });
  const resourcesGauge = meter.createObservableGauge(
    'mcp.process.active_resources',
    { description: 'Active libuv resources (handles + requests)' },
  );

  // "What the server is currently holding" — the session pools the idle reaper
  // and sweep keep bounded. A flat `sessions.tracked` confirms they stay
  // bounded; a steady climb is the regression signal.
  const liveSessions = meter.createObservableGauge('mcp.sessions.live', {
    description: 'Live FastMCP httpStream sessions',
  });
  const trackedSessions = meter.createObservableGauge('mcp.sessions.tracked', {
    description: 'Session ids tracked by the idle reaper',
  });
  const inFlightExec = meter.createObservableGauge(
    'mcp.sessions.in_flight_exec',
    { description: 'Sessions with a tool execution in flight' },
  );
  const agentSessions = meter.createObservableGauge(
    'mcp.agent.sessions.active',
    { description: 'Agent browser sessions held in the pool' },
  );
  const agentCommands = meter.createObservableGauge(
    'mcp.agent.commands.in_flight',
    { description: 'Pooled agent sessions with a command in flight' },
  );
  const reaped = meter.createObservableCounter('mcp.sessions.reaped', {
    description: 'Idle MCP sessions closed by the reaper (cumulative)',
  });
  const swept = meter.createObservableCounter('mcp.agent.sessions.swept', {
    description: 'Idle agent sessions proper-closed by the sweep (cumulative)',
  });

  meter.addBatchObservableCallback(
    (obs: BatchObservableResult) => {
      const cur = performance.eventLoopUtilization();
      const delta = performance.eventLoopUtilization(cur, prevElu);
      prevElu = cur;
      obs.observe(eluGauge, delta.utilization);

      obs.observe(delayP50, loopDelay.percentile(50) / 1e6);
      obs.observe(delayP99, loopDelay.percentile(99) / 1e6);
      loopDelay.reset();

      const mem = process.memoryUsage();
      obs.observe(memGauge, mem.rss, { type: 'rss' });
      obs.observe(memGauge, mem.heapUsed, { type: 'heap_used' });
      obs.observe(resourcesGauge, process.getActiveResourcesInfo().length);

      obs.observe(liveSessions, getLiveSessionCount());
      obs.observe(trackedSessions, trackedSessionCount());
      obs.observe(inFlightExec, inFlightExecCount());
      obs.observe(agentSessions, activeAgentSessionCount());
      obs.observe(agentCommands, inFlightCommandCount());
      obs.observe(reaped, reapedSessionTotal());
      obs.observe(swept, sweptSessionTotal());
    },
    [
      delayP50,
      delayP99,
      eluGauge,
      memGauge,
      resourcesGauge,
      liveSessions,
      trackedSessions,
      inFlightExec,
      agentSessions,
      agentCommands,
      reaped,
      swept,
    ],
  );
};
