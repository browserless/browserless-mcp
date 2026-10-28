import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import type { McpConfig } from '../@types/types.js';
import type { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool, type ToolRunContext } from '../lib/define-tool.js';
import { accountQuery } from '../lib/account-api.js';
import { replayViews, VIEW_UNAVAILABLE } from '../lib/view-store.js';
import { ShowOutputSchema, VIEW_URI } from '../lib/view-schemas.js';

const ViewParams = z.object({ viewRef: z.string().max(128) });

// Recheck the source under the current API credential: revoked access/deleted
// recordings must not remain readable through a previously prepared reference.
async function authorize(
  config: McpConfig,
  ctx: ToolRunContext<{ viewRef: string }>,
) {
  const view = replayViews.require(ctx.params.viewRef, ctx.viewOwner);
  try {
    const result = await accountQuery<{
      sessionReplayBySessionId: { sessionId: string } | null;
    }>(
      config,
      ctx.token,
      `query ReplayViewAccess($apiToken: String!, $sessionId: String!) {
        sessionReplayBySessionId(apiToken: $apiToken, sessionId: $sessionId) { sessionId }
      }`,
      { sessionId: view.sessionId },
    );
    if (result.sessionReplayBySessionId?.sessionId !== view.sessionId)
      throw new Error('Unavailable');
  } catch {
    throw new UserError(VIEW_UNAVAILABLE);
  }
}

export function registerShowTools(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool(server, config, analytics, {
    name: 'browserless_show',
    description:
      'Display a prepared Browserless session replay inline. Pass the exact viewRef returned by browserless_sessions action replay. Does not repeat the recording download or browser operation.',
    parameters: ViewParams,
    outputSchema: ShowOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { resourceUri: VIEW_URI }, 'openai/outputTemplate': VIEW_URI },
    run: async (ctx) => {
      await authorize(config, ctx);
      return replayViews.show(ctx.params.viewRef, ctx.viewOwner);
    },
    format: (result) => result,
  });
  defineTool(server, config, analytics, {
    name: 'browserless_view_data',
    description:
      'Widget-only reader for a prepared replay. Not a rendering tool. Use the original viewRef and opaque cursor; never fetch replay data into the conversation.',
    parameters: ViewParams.extend({
      cursor: z.string().max(128).optional(),
      encoding: z.enum(['identity', 'gzip']).default('identity'),
    }),
    outputSchema: z.object({
      complete: z.boolean(),
      nextCursor: z.string().optional(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    _meta: { ui: { visibility: ['app'] } },
    run: async (ctx) => {
      await authorize(config, ctx);
      return replayViews.read(
        ctx.params.viewRef,
        ctx.viewOwner,
        ctx.params.encoding,
        ctx.params.cursor,
      );
    },
    format: (result) => result,
  });
}
