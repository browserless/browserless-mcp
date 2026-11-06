export type LogSeverity = 'INFO' | 'WARN' | 'ERROR';
export type LogAttributes = Record<string, string | number | boolean>;

/** Shared gate for SDK startup and the base-endpoint log fallback. */
export const isHostedTelemetryEnabled = (
  transport: string | undefined,
): boolean =>
  transport === 'httpStream' &&
  process.env.OTEL_ENABLED === 'true' &&
  process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() !== 'true';

let inFlight = 0;

/** Best-effort OTLP/HTTP JSON shared by operator diagnostics. */
export const exportLogRecord = async ({
  scope,
  event,
  severity,
  attributes: fields,
}: {
  scope: string;
  event: string;
  severity: LogSeverity;
  attributes: LogAttributes;
}): Promise<void> => {
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const fallback =
    base && isHostedTelemetryEnabled(process.env.TRANSPORT)
      ? `${base.replace(/\/+$/, '')}/v1/logs`
      : undefined;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? fallback;
  if (!endpoint || inFlight >= 16) return;
  inFlight++;
  try {
    const attributes = Object.entries({ ...fields, 'event.name': event }).map(
      ([key, value]) => ({
        key,
        value:
          typeof value === 'number'
            ? { intValue: String(value) }
            : typeof value === 'boolean'
              ? { boolValue: value }
              : { stringValue: value },
      }),
    );
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(1000),
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [
                {
                  key: 'service.name',
                  value: { stringValue: 'browserless-mcp' },
                },
              ],
            },
            scopeLogs: [
              {
                scope: { name: scope },
                logRecords: [
                  {
                    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
                    severityNumber: { INFO: 9, WARN: 13, ERROR: 17 }[severity],
                    severityText: severity,
                    body: { stringValue: event },
                    attributes,
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    await response.body?.cancel();
  } catch {
    // An exporter cannot report its own failure through itself. No retries.
  } finally {
    inFlight--;
  }
};
