import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { defineTool } from '../lib/define-tool.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import type {
  McpConfig,
  StripeLinkAction,
  StripeLinkConnectionResponse,
} from '../@types/types.js';

export const StripeLinkConnectParamsSchema = z
  .object({
    action: z
      .enum(['status', 'connect', 'disconnect'])
      .describe(
        'Check Stripe Link status, start the connection flow, or disconnect the wallet.',
      ),
  })
  .strict();

type StripeLinkConnectParams = { action: StripeLinkAction };

export function registerStripeLinkConnectTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<StripeLinkConnectParams, StripeLinkConnectionResponse>(
    server,
    config,
    analytics,
    {
      name: 'browserless_link_connect',
      description:
        'Manage the Browserless Stripe Link wallet. Use action "status" to ' +
        'check availability, "connect" to get a Stripe-owned authorization ' +
        'URL, or "disconnect" to remove the connection. Never ask the user ' +
        'for raw card details.',
      parameters: StripeLinkConnectParamsSchema,
      annotations: {
        title: 'Browserless Stripe Link Connection',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      run: async ({ client, params, log }) => {
        const response = await client.stripeLinkConnection(params.action);
        log.debug(`Stripe Link ${params.action}: status=${response.status}`);
        return response;
      },
      analyticsProps: (params, result) => ({
        action: params.action,
        status: result.status,
      }),
      format: (result) => [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    },
  );
}
