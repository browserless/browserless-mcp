import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';

import type { McpConfig } from '../@types/types.js';
import { accountQuery } from '../lib/account-api.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool } from '../lib/define-tool.js';

const levelSchema = z.enum([
  'TRACE',
  'DEBUG',
  'INFO',
  'WARN',
  'ERROR',
  'FATAL',
]);

export const LogsParamsSchema = z.object({
  startTime: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Inclusive RFC 3339 start time. Omit to use the plan window.'),
  endTime: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('Exclusive RFC 3339 end time. Omit to use the current time.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum request-log entries to return, from 1 through 100.'),
  requestId: z
    .string()
    .max(256)
    .optional()
    .describe('Filter by an exact Browserless request id.'),
  url: z
    .string()
    .max(2048)
    .optional()
    .describe(
      'Filter by the requested page URL; this is a log filter, not a fetch target.',
    ),
  eventNames: z
    .array(z.string().max(128))
    .max(20)
    .optional()
    .describe(
      'Filter by event names such as request.failed or bql.*.failed (up to 20).',
    ),
  outcome: z
    .string()
    .max(256)
    .optional()
    .describe('Filter by request outcome, such as successful or failed.'),
  apiKeyId: z
    .string()
    .max(256)
    .optional()
    .describe('Filter by the non-secret API key id recorded on the request.'),
  endpoint: z
    .string()
    .max(256)
    .optional()
    .describe('Filter by Browserless endpoint, for example /chromium/bql.'),
  category: z
    .string()
    .max(256)
    .optional()
    .describe(
      'Filter by category such as browserless_refused, browserless_killed, or target_error.',
    ),
  reason: z
    .string()
    .max(256)
    .optional()
    .describe(
      'Filter by failure reason such as concurrency_limit or target_error.',
    ),
  levels: z
    .array(levelSchema)
    .max(6)
    .optional()
    .describe('Filter by severity: TRACE, DEBUG, INFO, WARN, ERROR, or FATAL.'),
  order: z
    .enum(['ASC', 'DESC'])
    .optional()
    .describe(
      'Timestamp order. Use DESC for newest first or ASC for oldest first.',
    ),
  cursor: z
    .string()
    .max(512)
    .optional()
    .describe('Opaque nextCursor from a previous browserless_logs response.'),
});

type LogsParams = z.infer<typeof LogsParamsSchema>;

interface RequestLogEntry {
  timestamp?: string | null;
  eventName?: string | null;
  requestId?: string | null;
  apiKeyId?: string | null;
  level?: string | null;
  endpoint?: string | null;
  category?: string | null;
  reason?: string | null;
  message?: string | null;
  url?: string | null;
  status?: number | null;
  durationMs?: number | null;
  timeoutBudgetMs?: number | null;
  region?: string | null;
  sessionId?: string | null;
  bqlOperationId?: string | null;
  operationName?: string | null;
  resolver?: string | null;
  graphqlPath?: string | null;
  outcome?: string | null;
  timeUnits?: number | null;
  proxyUnits?: number | null;
  captchaUnits?: number | null;
  agentUnits?: number | null;
  totalUnits?: number | null;
}

interface RequestLogsResult {
  entries: RequestLogEntry[];
  nextCursor?: string | null;
}

interface RequestLogsData {
  requestLogs: RequestLogsResult;
}

export const REQUEST_LOGS_QUERY = `
  query BrowserlessLogs(
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
        apiKeyId
        level
        endpoint
        category
        reason
        message
        url
        status
        durationMs
        timeoutBudgetMs
        region
        sessionId
        bqlOperationId
        operationName
        resolver
        graphqlPath
        outcome
        timeUnits
        proxyUnits
        captchaUnits
        agentUnits
        totalUnits
      }
      nextCursor
    }
  }
`;

const formatEntry = (entry: RequestLogEntry): string => {
  const categoryAndReason = [entry.category, entry.reason]
    .filter(Boolean)
    .join('/');
  const summary = [
    entry.timestamp ?? 'unknown-time',
    (entry.level ?? 'INFO').toUpperCase(),
    entry.endpoint ?? 'unknown-endpoint',
    categoryAndReason || 'uncategorized',
    entry.message ?? entry.eventName ?? 'Request event',
  ].join(' | ');
  return `${summary} | requestId=${entry.requestId ?? 'unknown'}`;
};

export function registerLogsTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<LogsParams, RequestLogsResult>(server, config, analytics, {
    name: 'browserless_logs',
    description:
      "Return Browserless's recent request logs for the configured account to diagnose failed runs. " +
      'The available history depends on the account plan, and the tool reports the allowed limit when a requested range is refused.',
    parameters: LogsParamsSchema,
    annotations: {
      title: 'Browserless Request Logs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: async ({ params, token }) => {
      const data = await accountQuery<RequestLogsData>(
        config,
        token,
        REQUEST_LOGS_QUERY,
        params,
      );
      return data.requestLogs;
    },
    analyticsProps: (_params, result) => ({
      entry_count: result.entries.length,
      has_next_cursor: !!result.nextCursor,
    }),
    format: (result) => {
      if (result.entries.length === 0) {
        return [
          {
            type: 'text',
            text: 'No matching Browserless request-log entries were found in this window.',
          },
        ];
      }

      const lines = result.entries.map(formatEntry);
      if (result.nextCursor) {
        lines.push(
          `nextCursor=${result.nextCursor} — pass this value as cursor to browserless_logs for the next page.`,
        );
      }
      return [{ type: 'text', text: lines.join('\n') } satisfies Content];
    },
  });
}
