import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { defineTool } from '../lib/define-tool.js';
import type { AnalyticsHelper } from '../lib/analytics.js';
import type {
  LiveURLCreated,
  LiveURLState,
  McpConfig,
} from '../@types/types.js';

export const LiveURLParamsSchema = z.object({
  action: z.enum(['create', 'status', 'close']),
  browserId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Running browser ID from browserless_sessions action active, not an agent sessionId.',
    ),
  liveURLId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Required for status and close.'),
  interactable: z.boolean().optional(),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Link lifetime in ms; server clamps to remaining session time and 15 minutes.',
    ),
  quality: z.number().int().min(1).max(100).optional(),
  type: z.enum(['jpeg', 'png']).optional(),
  resizable: z.boolean().optional(),
  showBrowserInterface: z.boolean().optional(),
  instructions: z.string().optional(),
});

export function registerLiveURLTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<
    z.infer<typeof LiveURLParamsSchema>,
    LiveURLCreated | LiveURLState | { closed: true }
  >(server, config, analytics, {
    name: 'browserless_live_url',
    description:
      'Create, inspect, or close a live viewer link for an existing browser through REST, without an agent connection. ' +
      'Create options default on the server: view-only, jpeg, quality 70, not resizable, browser interface shown. ' +
      'Status returns status, reason, interactable, viewerCount, and expiresAt (epoch ms). ' +
      'Ended links remain inspectable until their browser closes; closing an ended link returns not found.',
    parameters: LiveURLParamsSchema,
    annotations: {
      title: 'Browserless Live URL',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: async ({ client, params }) => {
      const { action, browserId, liveURLId, ...options } =
        LiveURLParamsSchema.parse(params);
      if (action === 'create') {
        if (
          options.type === 'png' &&
          options.quality !== undefined &&
          options.quality !== 100
        ) {
          throw new UserError('PNG only supports explicit quality 100.');
        }
        return client.createLiveURL(browserId, options);
      }
      if (!liveURLId)
        throw new UserError('liveURLId is required for status and close.');
      if (action === 'status') return client.getLiveURL(browserId, liveURLId);
      await client.closeLiveURL(browserId, liveURLId);
      return { closed: true };
    },
    analyticsProps: (params) => ({ action: params.action }),
    format: (result) => [{ type: 'text', text: JSON.stringify(result) }],
  });
}
