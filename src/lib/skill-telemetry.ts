import { z } from 'zod';

const common = {
  domain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9.\-:[\]]+$/),
  request_id: z.uuid(),
  run_id: z.uuid().optional(),
  attempt: z.number().int().min(1).max(100),
  duration_ms: z.number().int().nonnegative(),
  http_status: z.number().int().min(100).max(599).optional(),
  stage: z.enum(['fetch', 'decode', 'validate']),
};

// Strip unknown properties before either transport; the queue's token is
// added separately for its existing server-side identity enrichment.
export const retrievalSchema = z.discriminatedUnion('result', [
  z.object({
    ...common,
    result: z.literal('hit'),
    skill_count: z.number().int().positive(),
  }),
  z.object({ ...common, result: z.literal('miss'), skill_count: z.literal(0) }),
  z.object({
    ...common,
    result: z.literal('error'),
    error_category: z.enum([
      'timeout',
      'network_error',
      'http_error',
      'invalid_json',
      'invalid_shape',
    ]),
  }),
]);

export const skillSource = (source: string): string =>
  [
    'cli_agent',
    'script_builder',
    'autologin',
    'agent_run',
    'mcp_client',
  ].includes(source)
    ? source
    : 'unknown';

let inFlight = 0;
let nextDiagnosticAt = 0;

/** OTLP/HTTP JSON to the operator's collector. Disabled unless configured. */
export const logSkillEvent = async (
  event: 'skill.retrieval.failed' | 'skill.telemetry.delivery_failed',
  fields: Record<string, string | number>,
): Promise<void> => {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (!endpoint || inFlight >= 16) return;
  inFlight++;
  try {
    const attributes = Object.entries({ ...fields, 'event.name': event }).map(
      ([key, value]) => ({
        key,
        value:
          typeof value === 'number'
            ? { intValue: String(value) }
            : { stringValue: value },
      }),
    );
    await fetch(endpoint, {
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
                scope: { name: 'skill-catalog' },
                logRecords: [
                  {
                    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
                    severityNumber: 13,
                    severityText: 'WARN',
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
  } catch {
    // An exporter cannot report its own failure through itself. No retries.
  } finally {
    inFlight--;
  }
};

export const skillDeliveryFailed = (event: string): void => {
  if (
    !['Skill Retrieval Completed', 'Skill Lookup', 'MCP Skill'].includes(event)
  )
    return;
  const now = Date.now();
  if (now < nextDiagnosticAt && nextDiagnosticAt - now <= 60_000) return;
  nextDiagnosticAt = now + 60_000;
  void logSkillEvent('skill.telemetry.delivery_failed', {
    originating_event: event,
    error_category: 'delivery_error',
  });
};
