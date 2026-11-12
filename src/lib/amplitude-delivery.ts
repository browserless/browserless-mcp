import {
  diagnosticPreview,
  escapeDiagnosticString,
} from './diagnostic-string.js';
import { exportLogRecord } from './otlp-log.js';

type Failure = {
  event_type: string;
  status: number;
  reason: string;
  count: number;
};
const failures = new Map<string, Failure>();
let overflow = 0;
let errors = 0;
let warnings = 0;
let timer: NodeJS.Timeout | undefined;

export const amplitudeFailureReason = (message: unknown): string => {
  if (typeof message !== 'string') return 'unknown';
  const text = message
    .split(':', 1)[0]
    .replace(/[A-Za-z0-9+/=_-]{16,}/g, '[redacted]')
    .trim();
  return escapeDiagnosticString(diagnosticPreview(text, 80)) || 'unknown';
};

const startWindow = (): void => {
  timer ??= setTimeout(flushAmplitudeDelivery, 60_000).unref();
};

export const noteAmplitudeResult = (result: {
  event?: { event_type?: unknown };
  code: number;
  message?: unknown;
}): void => {
  if (result.code === 200 || result.code === 100) return;
  const event_type =
    typeof result.event?.event_type === 'string'
      ? escapeDiagnosticString(diagnosticPreview(result.event.event_type, 64))
      : 'unknown';
  const reason = amplitudeFailureReason(result.message);
  const key = JSON.stringify([event_type, result.code, reason]);
  const existing = failures.get(key);
  if (existing) existing.count++;
  else if (failures.size < 12)
    failures.set(key, { event_type, status: result.code, reason, count: 1 });
  else overflow++;
  startWindow();
};

export const noteAmplitudeSdkLog = (level: 'warn' | 'error'): void => {
  if (level === 'error') errors++;
  else warnings++;
  startWindow();
};

export const flushAmplitudeDelivery = (): void => {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (!failures.size && !overflow && !errors && !warnings) return;
  const records = [...failures.values()];
  if (overflow)
    records.push({
      event_type: 'other',
      status: 0,
      reason: 'overflow',
      count: overflow,
    });
  const statuses = new Map<number, number>();
  let count = 0;
  for (const record of records) {
    count += record.count;
    statuses.set(
      record.status,
      (statuses.get(record.status) ?? 0) + record.count,
    );
    void exportLogRecord({
      scope: 'amplitude',
      event: 'browserless.mcp.amplitude.delivery_failed',
      severity: 'WARN',
      attributes: { ...record, window_s: 60 },
    });
  }
  console.warn(
    `[browserless-mcp] Amplitude delivery failed for ${count} events in the last 60s (${[...statuses].map(([status, n]) => `${status}: ${n}`).join(', ')}); SDK errors ${errors}, warnings ${warnings}`,
  );
  failures.clear();
  overflow = errors = warnings = 0;
};
