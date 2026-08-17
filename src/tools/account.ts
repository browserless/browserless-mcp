import { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { accountQuery } from '../lib/account-api.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool } from '../lib/define-tool.js';
import type { McpConfig } from '../@types/types.js';

export const AccountParamsSchema = z.object({
  action: z
    .enum(['billing', 'keys'])
    .describe(
      'Which part of the account to read. `billing` returns the plan, unit ' +
        'balance and billing period; `keys` lists the account API keys by name.',
    ),
});

export type AccountParams = z.infer<typeof AccountParamsSchema>;

interface CloudUnits {
  unitsLeft: number | null;
  used: number | null;
  available: number | null;
  overageFee: number | null;
}

interface ApiKeySummary {
  apiKeyId: string | null;
  name: string | null;
  createdAt: number | null;
  revoked: boolean | null;
}

interface AccountSummary {
  accountId: string | null;
  plan: string | null;
  planType: string | null;
  pastDue: boolean | null;
  currentPeriodEnd: number | null;
  cloudUnits: CloudUnits | null;
  apiKeys: ApiKeySummary[] | null;
}

const ACCOUNT_SUMMARY_QUERY = `
  query AccountSummary($apiToken: String!) {
    accountSummary(apiToken: $apiToken) {
      accountId
      plan
      planType
      pastDue
      currentPeriodEnd
      cloudUnits {
        unitsLeft
        used
        available
        overageFee
      }
      apiKeys {
        apiKeyId
        name
        createdAt
        revoked
      }
    }
  }
`;

const formatDate = (secondsOrMs: number, unit: 'seconds' | 'ms'): string =>
  new Date(unit === 'seconds' ? secondsOrMs * 1000 : secondsOrMs)
    .toISOString()
    .slice(0, 10);

const formatBilling = (summary: AccountSummary): string => {
  const lines = [
    `## Plan`,
    ``,
    `- Plan: ${summary.plan ?? 'unknown'}${summary.planType ? ` (${summary.planType})` : ''}`,
  ];

  if (summary.currentPeriodEnd) {
    lines.push(
      `- Billing period ends: ${formatDate(summary.currentPeriodEnd, 'seconds')}`,
    );
  }

  // Stated either way: printing this only when true made "is my account past
  // due?" unanswerable, because absence reads as "no such field".
  if (summary.pastDue === true) {
    lines.push(`- Payment status: **past due**`);
  } else if (summary.pastDue === false) {
    lines.push(`- Payment status: current, no overdue invoices`);
  } else {
    lines.push(`- Payment status: unknown (billing details unavailable)`);
  }

  if (summary.accountId) {
    lines.push(`- Account id: ${summary.accountId}`);
  }

  const units = summary.cloudUnits;

  if (units) {
    lines.push(``, `## Units`, ``);
    lines.push(
      `- Remaining: ${units.unitsLeft ?? 'no limit'}`,
      `- Used this period: ${units.used ?? 0}`,
      `- Included in plan: ${units.available ?? 'unknown'}`,
    );
    if (units.overageFee != null) {
      lines.push(`- Overage: ${units.overageFee} per unit beyond the plan`);
    }
    if (
      units.available != null &&
      units.used != null &&
      units.used > units.available
    ) {
      lines.push(
        `- Consumption is above the plan allotment, so the excess is billed as overage.`,
      );
    }
  } else {
    lines.push(
      ``,
      `This account is not on a unit-based plan, so there is no unit balance to report.`,
    );
  }

  return lines.join('\n');
};

const formatKeys = (summary: AccountSummary): string => {
  const keys = summary.apiKeys ?? [];

  if (!keys.length) {
    return 'No API keys are listed for this account.';
  }

  const rows = keys.map((key) => {
    const created = key.createdAt
      ? ` — created ${formatDate(key.createdAt, 'ms')}`
      : '';
    const revoked = key.revoked ? ' — **revoked**' : '';
    return `- ${key.name ?? '(unnamed)'} \`${key.apiKeyId ?? '?'}\`${created}${revoked}`;
  });

  return [
    `## API keys (${keys.length})`,
    ``,
    ...rows,
    ``,
    'Key ids can be passed as `apiKeyId` to filter usage and request logs. ' +
      'Token values are never returned by this tool — create or rotate keys in the dashboard.',
  ].join('\n');
};

export function registerAccountTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<AccountParams, AccountSummary>(server, config, analytics, {
    name: 'browserless_account',
    description:
      'Read the Browserless account behind the current API token: plan, unit ' +
      'balance, billing period, and the names of the account API keys. Use it ' +
      'to answer "what plan am I on", "how many units are left", or "which ' +
      'keys exist". Read-only, and never returns API token values.',
    parameters: AccountParamsSchema,
    annotations: {
      title: 'Browserless Account',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: async ({ params, token, log }) => {
      const data = await accountQuery<{ accountSummary: AccountSummary }>(
        config,
        token,
        ACCOUNT_SUMMARY_QUERY,
      );
      log.debug(`Read account summary for action ${params.action}`);
      return data.accountSummary;
    },
    analyticsProps: (params, result) => ({
      action: params.action,
      plan_type: result?.planType ?? undefined,
      key_count: result?.apiKeys?.length ?? 0,
    }),
    format: (summary, params) => {
      if (!summary) {
        return [
          {
            type: 'text' as const,
            text: 'No account was found for this API token.',
          },
        ];
      }
      return [
        {
          type: 'text' as const,
          text:
            params.action === 'keys'
              ? formatKeys(summary)
              : formatBilling(summary),
        },
      ];
    },
  });
}
