import { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { accountQuery } from '../lib/account-api.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool } from '../lib/define-tool.js';
import type { McpConfig } from '../@types/types.js';

export const UsageParamsSchema = z.object({
  timeframe: z
    .enum(['hour', 'day', 'week'])
    .optional()
    .describe(
      'Window the usage counts cover: the last hour, day, or week. Defaults to day.',
    ),
  apiKeyIds: z
    .array(z.string())
    .max(50)
    .optional()
    .describe(
      'Restrict the numbers to specific API keys, by id. Omit for the whole ' +
        'account. Get ids from browserless_account with action "keys".',
    ),
});

export type UsageParams = z.infer<typeof UsageParamsSchema>;

interface UsageSummary {
  successful: number | null;
  errored: number | null;
  timedout: number | null;
  queued: number | null;
  rejected: number | null;
  maxConcurrent: number | null;
  captcha: number | null;
  proxy: number | null;
}

interface UsageResponse {
  accountUsage: { summary: UsageSummary | null } | null;
  accountSummary: {
    currentPeriodEnd: number | null;
    cloudUnits: {
      used: number | null;
      available: number | null;
      overageFee: number | null;
    } | null;
  } | null;
}

// Two sources: `accountUsage` counters are empty on a cloud-unit shared fleet,
// so the `accountSummary` ledger is what actually answers "how much have I used".
const ACCOUNT_USAGE_QUERY = `
  query AccountUsage(
    $apiToken: String!
    $timeframe: timeframe!
    $apiKeyIds: [String!]
  ) {
    accountUsage(
      apiToken: $apiToken
      timeframe: $timeframe
      apiKeyIds: $apiKeyIds
    ) {
      summary {
        successful
        errored
        timedout
        queued
        rejected
        maxConcurrent
        captcha
        proxy
      }
    }
    accountSummary(apiToken: $apiToken) {
      currentPeriodEnd
      cloudUnits {
        used
        available
        overageFee
      }
    }
  }
`;

const DEFAULT_TIMEFRAME = 'day' as const;

const formatUsage = (usage: UsageResponse, params: UsageParams): string => {
  const summary = usage.accountUsage?.summary;
  const units = usage.accountSummary?.cloudUnits;
  const scope = params.apiKeyIds?.length
    ? `${params.apiKeyIds.length} selected key(s)`
    : 'the whole account';
  const lines: string[] = [];

  if (units) {
    lines.push(`## Billed units — this billing period`, ``);
    lines.push(`- Used: ${units.used ?? 0}`);
    if (units.available != null) {
      lines.push(`- Included in plan: ${units.available}`);
      const over = (units.used ?? 0) - units.available;
      if (over > 0) {
        lines.push(
          `- Over the plan allotment by ${over}, billed as overage` +
            (units.overageFee != null
              ? ` at ${units.overageFee} per unit`
              : ''),
        );
      }
    }
    if (usage.accountSummary?.currentPeriodEnd) {
      lines.push(
        `- Period ends: ${new Date(usage.accountSummary.currentPeriodEnd * 1000).toISOString().slice(0, 10)}`,
      );
    }
    lines.push(``);
  }

  const counters = [
    ['Successful', summary?.successful],
    ['Errored', summary?.errored],
    ['Timed out', summary?.timedout],
    ['Queued', summary?.queued],
    ['Rejected', summary?.rejected],
    ['Peak concurrency', summary?.maxConcurrent],
    ['Captchas solved', summary?.captcha],
    ['Proxy bytes', summary?.proxy],
  ] as const;
  const counterTotal = counters.reduce((sum, [, v]) => sum + (v ?? 0), 0);

  lines.push(
    `## Requests — last ${params.timeframe ?? DEFAULT_TIMEFRAME}, ${scope}`,
    ``,
  );

  if (!summary || counterTotal === 0) {
    // "Nothing ran" and "this account keeps no counters" look identical in the
    // response, and the second reads as a bug when the ledger above is non-zero.
    lines.push(
      (units?.used ?? 0) > 0
        ? 'No per-request counters are recorded for this account, even though ' +
            'units were consumed above — these counters are only populated for ' +
            'dedicated workers. Use browserless_logs for per-request detail.'
        : 'No requests recorded in this window.',
    );
    return lines.join('\n');
  }

  for (const [label, value] of counters) {
    if (value) lines.push(`- ${label}: ${value}`);
  }

  const completed =
    (summary.successful ?? 0) +
    (summary.errored ?? 0) +
    (summary.timedout ?? 0);

  if (completed > 0) {
    const failed = (summary.errored ?? 0) + (summary.timedout ?? 0);
    lines.push(
      ``,
      `${((failed / completed) * 100).toFixed(1)}% of completed requests failed. ` +
        `Use browserless_logs to see why individual requests failed.`,
    );
  }

  return lines.join('\n');
};

export function registerUsageTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<UsageParams, UsageResponse>(server, config, analytics, {
    name: 'browserless_usage',
    description:
      'Read request and unit consumption for the Browserless account behind ' +
      'the current API token: successes, errors, timeouts, queueing, peak ' +
      'concurrency, captchas, proxy bytes and units. Use it to answer "how ' +
      'much have I used" or "why is my bill high". For per-request detail on ' +
      'failures, use browserless_logs instead. Read-only.',
    parameters: UsageParamsSchema,
    annotations: {
      title: 'Browserless Usage',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: async ({ params, token, log }) => {
      const data = await accountQuery<UsageResponse>(
        config,
        token,
        ACCOUNT_USAGE_QUERY,
        {
          // Non-null on the resolver: an unset variable fails GraphQL validation.
          timeframe: params.timeframe ?? DEFAULT_TIMEFRAME,
          apiKeyIds: params.apiKeyIds,
        },
      );
      log.debug(
        `Read account usage (timeframe: ${params.timeframe ?? DEFAULT_TIMEFRAME})`,
      );
      return data;
    },
    analyticsProps: (params, result) => ({
      timeframe: params.timeframe ?? DEFAULT_TIMEFRAME,
      key_filter_count: params.apiKeyIds?.length ?? 0,
      units_used: result?.accountSummary?.cloudUnits?.used ?? undefined,
    }),
    format: (usage, params) => [
      {
        type: 'text' as const,
        text: usage
          ? formatUsage(usage, params)
          : 'No usage has been recorded for this account yet.',
      },
    ],
  });
}
