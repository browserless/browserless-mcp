import { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { accountQuery } from '../lib/account-api.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool } from '../lib/define-tool.js';
import type { McpConfig } from '../@types/types.js';

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

interface LogEntry {
  timestamp: string | null;
  eventName: string | null;
  requestId: string | null;
  level: string | null;
  endpoint: string | null;
  category: string | null;
  reason: string | null;
  message: string | null;
  url: string | null;
  status: number | null;
  durationMs: number | null;
  region: string | null;
  sessionId: string | null;
  outcome: string | null;
  totalUnits: number | null;
}

interface LogsResult {
  entries: LogEntry[];
  nextCursor: string | null;
}

const REQUEST_LOGS_QUERY = `
  query RequestLogs(
    $apiToken: String
    $startTime: String
    $endTime: String
    $limit: Int
    $requestId: String
    $url: String
    $eventNames: [String!]
    $outcome: String
    $apiKeyId: String
    $endpoint: String
    $category: String
    $reason: String
    $levels: [RequestLogLevel!]
    $order: RequestLogOrder
    $cursor: String
  ) {
    requestLogs(
      apiToken: $apiToken
      startTime: $startTime
      endTime: $endTime
      limit: $limit
      requestId: $requestId
      url: $url
      eventNames: $eventNames
      outcome: $outcome
      apiKeyId: $apiKeyId
      endpoint: $endpoint
      category: $category
      reason: $reason
      levels: $levels
      order: $order
      cursor: $cursor
    ) {
      entries {
        timestamp
        eventName
        requestId
        level
        endpoint
        category
        reason
        message
        url
        status
        durationMs
        region
        sessionId
        outcome
        totalUnits
      }
      nextCursor
    }
  }
`;

const formatEntry = (entry: LogEntry): string => {
  const head = [
    entry.timestamp ?? 'unknown time',
    entry.level ?? 'INFO',
    entry.endpoint ?? entry.eventName ?? 'unknown endpoint',
  ].join(' · ');

  const detail = [
    entry.category && entry.reason
      ? `${entry.category}/${entry.reason}`
      : (entry.category ?? entry.reason),
    entry.outcome,
    entry.status != null ? `HTTP ${entry.status}` : undefined,
    entry.durationMs != null ? `${Math.round(entry.durationMs)}ms` : undefined,
    entry.totalUnits != null ? `${entry.totalUnits} units` : undefined,
    entry.region,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines = [`- **${head}**`];
  if (detail) lines.push(`  ${detail}`);
  if (entry.message) lines.push(`  ${entry.message}`);
  if (entry.url) lines.push(`  ${entry.url}`);
  const ids = [
    entry.requestId ? `request \`${entry.requestId}\`` : undefined,
    entry.sessionId ? `session \`${entry.sessionId}\`` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  if (ids) lines.push(`  ${ids}`);

  return lines.join('\n');
};

export function registerLogsTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<LogsParams, LogsResult>(server, config, analytics, {
    name: 'browserless_logs',
    description:
      "Read Browserless's own record of the account's recent requests: what " +
      'was attempted, whether it failed, why it stopped, how long it took and ' +
      'what it cost. This is the tool for diagnosing a run that failed on the ' +
      'Browserless side rather than in your own code. The window available ' +
      'depends on the account plan; the server reports the limit if a range is ' +
      'refused. Read-only.',
    parameters: LogsParamsSchema,
    annotations: {
      title: 'Browserless Request Logs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: async ({ params, token, log }) => {
      const data = await accountQuery<{ requestLogs: LogsResult }>(
        config,
        token,
        REQUEST_LOGS_QUERY,
        {
          ...params,
          // The GraphQL enum is ASC/DESC. Time bounds pass through untouched so
          // the server applies the plan's own default.
          ...(params.order ? { order: params.order.toUpperCase() } : {}),
        },
      );
      log.debug(`Read ${data.requestLogs?.entries?.length ?? 0} log entries`);
      return data.requestLogs;
    },
    analyticsProps: (params, result) => ({
      entry_count: result?.entries?.length ?? 0,
      had_cursor: Boolean(params.cursor),
      filtered_by_outcome: params.outcome ?? undefined,
      filtered_by_endpoint: params.endpoint ?? undefined,
    }),
    format: (result) => {
      const entries = result?.entries ?? [];

      if (!entries.length) {
        return [
          {
            type: 'text' as const,
            text:
              'No request log entries matched. Widen the time range or drop a ' +
              'filter — and note the available window depends on the account plan.',
          },
        ];
      }

      const blocks = [
        `## Request logs (${entries.length})`,
        ``,
        entries.map(formatEntry).join('\n'),
      ];

      if (result.nextCursor) {
        blocks.push(
          ``,
          `More entries are available — pass \`cursor: "${result.nextCursor}"\` for the next page.`,
        );
      }

      return [{ type: 'text' as const, text: blocks.join('\n') }];
    },
  });
}
