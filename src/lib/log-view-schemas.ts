import { z } from 'zod';

export const LogsParamsSchema = z.object({
  startTime: z
    .string()
    .optional()
    .describe(
      'Inclusive RFC 3339 start time. Omit to let the account’s plan decide how ' +
        'far back to look — the available window is plan-dependent and the ' +
        'server rejects a range that exceeds it.',
    ),
  endTime: z
    .string()
    .optional()
    .describe('Exclusive RFC 3339 end time. Defaults to now when omitted.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum entries to return, 1-100. Defaults to 50.'),
  requestId: z
    .string()
    .optional()
    .describe('Return only entries for one request id.'),
  url: z
    .string()
    .optional()
    .describe('Filter by the target URL of the request.'),
  eventNames: z
    .array(z.string())
    .max(20)
    .optional()
    .describe(
      'Filter by lifecycle event name, e.g. `request.failed`, `bql.*.failed`.',
    ),
  outcome: z
    .string()
    .optional()
    .describe('Filter by request outcome, e.g. `failed` or `succeeded`.'),
  apiKeyId: z
    .string()
    .optional()
    .describe(
      'Restrict to one API key, by id. Get ids from browserless_account with action "keys".',
    ),
  endpoint: z
    .string()
    .optional()
    .describe('Filter by endpoint, e.g. `/chromium/bql` or `/screenshot`.'),
  category: z
    .string()
    .optional()
    .describe(
      'Filter by failure category, e.g. `browserless_refused`, ' +
        '`browserless_killed`, `target_error`.',
    ),
  reason: z
    .string()
    .optional()
    .describe('Filter by the specific failure reason within a category.'),
  levels: z
    .array(z.enum(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']))
    .optional()
    .describe('Severity levels to include. Omit for all levels.'),
  order: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Timestamp order. Defaults to newest first.'),
  cursor: z
    .string()
    .optional()
    .describe('Opaque cursor returned as `nextCursor` by the previous page.'),
});

export type LogsParams = z.infer<typeof LogsParamsSchema>;

export const LOG_PAGE_MAX_BYTES = 1024 * 1024;
export const LOG_VIEW_MAX_BYTES = 2 * 1024 * 1024;
export const LOG_VIEW_MAX_ENTRIES = 500;
// The page byte limit bounds storage without silently truncating field values.
const text = z.string().nullable().default(null);
export const LogEntrySchema = z.object({
  timestamp: text,
  eventName: text,
  requestId: text,
  level: text,
  endpoint: text,
  category: text,
  reason: text,
  message: z
    .string()
    .max(128 * 1024)
    .nullable()
    .default(null),
  url: text,
  status: z.number().finite().nullable().default(null),
  durationMs: z.number().finite().nullable().default(null),
  region: text,
  sessionId: text,
  outcome: text,
  totalUnits: z.number().finite().nullable().default(null),
});
export const LogSummarySchema = z.object({
  fetchedAt: z.string().datetime(),
  entryCount: z.number().int().min(0).max(100),
  hasMore: z.boolean(),
});
export const LogPayloadSchema = z.object({
  entries: z.array(LogEntrySchema).max(100),
  filters: LogsParamsSchema.omit({ cursor: true }),
  nextCursor: z.string().max(512).nullable(),
});
export type LogPayload = z.infer<typeof LogPayloadSchema>;

// Compare complete normalized entries: a request can emit several distinct events.
export const logEntryKey = (entry: z.infer<typeof LogEntrySchema>) =>
  JSON.stringify(entry);
export function mergeLogEntries(
  previous: LogPayload['entries'],
  incoming: LogPayload['entries'],
) {
  const rows = [];
  const seen = new Set<string>();
  let bytes = 2;
  let bounded = false;
  for (const entry of [...previous, ...incoming]) {
    const key = logEntryKey(entry);
    if (seen.has(key)) continue;
    const size = new TextEncoder().encode(key).length + 1;
    if (
      rows.length >= LOG_VIEW_MAX_ENTRIES ||
      bytes + size > LOG_VIEW_MAX_BYTES
    ) {
      bounded = true;
      break;
    }
    seen.add(key);
    rows.push(entry);
    bytes += size;
  }
  return { rows, bounded };
}
