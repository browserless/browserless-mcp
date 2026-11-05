import { FastMCP } from 'fastmcp';

import { accountQuery } from '../lib/account-api.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool } from '../lib/define-tool.js';
import type { McpConfig } from '../@types/types.js';
import { replayViews } from '../lib/view-store.js';
import { isCompliant } from './compliance.js';

export { LogsParamsSchema, type LogsParams } from '../lib/log-view-schemas.js';
import { LogsParamsSchema, type LogsParams } from '../lib/log-view-schemas.js';

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
      'refused. Read-only. When an inline view can be prepared, MCP Apps clients receive a viewRef; use browserless_show to display the request-log explorer. Its rows and pagination cursors stay in widget-only metadata. Otherwise returns the standard Markdown result.',
    collectPrompt: false,
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
      filter_count: Object.keys(params).filter((key) => key !== 'cursor')
        .length,
    }),
    format: (result, params, { uiEnabled, viewOwner }) => {
      if (uiEnabled && !isCompliant(config)) {
        const { cursor: _cursor, ...filters } = params;
        const view = replayViews.prepareLogs(viewOwner, {
          entries: result?.entries ?? [],
          filters,
          nextCursor: result?.nextCursor ?? null,
        });
        if (view)
          return {
            content: [
              {
                type: 'text',
                text: `${view.summary} Call browserless_show with ${JSON.stringify({ viewRef: view.viewRef })} to inspect it inline.`,
              },
            ],
            structuredContent: view,
            _meta: replayViews.show(view.viewRef, viewOwner)._meta,
          };
      }
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
