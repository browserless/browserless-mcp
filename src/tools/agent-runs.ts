import type { FastMCP } from 'fastmcp';
import { UserError } from 'fastmcp';
import { z } from 'zod';
import type { McpConfig } from '../@types/types.js';
import { matchesMediaType, mediaOrigin } from '../lib/agent-media.js';
import {
  AGENT_RUN_ID,
  AGENT_RUN_STATUSES,
  AgentRunListSchema,
  buildAgentRun,
  formatAgentRunList,
  formatAgentRunText,
  type AgentRunPayload,
} from '../lib/agent-run-view.js';
import type { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool } from '../lib/define-tool.js';
import { replayViews } from '../lib/view-store.js';
import { isCompliant } from './compliance.js';

const params = z.object({
  action: z.enum(['list', 'get']),
  runId: z.string().regex(AGENT_RUN_ID).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  cursor: z.string().max(512).optional(),
  status: z.enum(AGENT_RUN_STATUSES).optional(),
});
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

async function prepareScreenshot(
  config: McpConfig,
  owner: string,
  {
    summary,
    screenshotBase64,
    screenshotError,
  }: ReturnType<typeof buildAgentRun>,
): Promise<AgentRunPayload['screenshot']> {
  if (screenshotError !== null)
    return { state: 'unavailable', reason: screenshotError };
  if (screenshotBase64 === null) return { state: 'none' };
  if (summary.active) return { state: 'unavailable', reason: 'run_active' };
  if (!mediaOrigin(config)) return { state: 'unavailable', reason: 'client' };
  if (
    screenshotBase64.length > 4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(screenshotBase64)
  )
    return { state: 'unavailable', reason: 'invalid' };
  const body = Buffer.from(screenshotBase64, 'base64');
  if (
    body.length > MAX_SCREENSHOT_BYTES ||
    !matchesMediaType(body, 'image/png')
  )
    return { state: 'unavailable', reason: 'invalid' };
  const width = body.readUInt32BE(16),
    height = body.readUInt32BE(20);
  if (!width || !height) return { state: 'unavailable', reason: 'invalid' };
  const media = await replayViews.prepareMedia(owner, [
    {
      type: 'image',
      mimeType: 'image/png',
      body,
      label: 'Final screenshot',
      rationale: '',
      commandIndex: 1,
      width,
      height,
    },
  ]);
  return media
    ? { state: 'available', viewRef: media.viewRef }
    : { state: 'unavailable', reason: 'storage' };
}

export function registerAgentRunsTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool(server, config, analytics, {
    name: 'browserless_agent_runs',
    description:
      'Read hosted agent runs (/agent/run) for the account behind the current key. Use list for recent runs newest first, or get to open a run by its run_… ID. These are not MCP session IDs or browser session IDs. Read-only: never starts, continues, cancels or repeats a run. MCP Apps clients receive a viewRef to pass to browserless_show for the inline timeline when available.',
    collectPrompt: false,
    parameters: params,
    annotations: {
      title: 'Browserless Agent Runs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: async ({ params, client, log }) => {
      if (params.action === 'get' && !params.runId)
        throw new UserError('runId is required for action "get".');
      try {
        if (params.action === 'list') {
          const parsed = AgentRunListSchema.safeParse(
            await client.listAgentRuns({
              limit: params.limit ?? 10,
              cursor: params.cursor,
              status: params.status,
            }),
          );
          if (!parsed.success)
            throw new Error('Unexpected agent run response.');
          log.debug(`Read ${parsed.data.runs.length} agent runs`);
          return { action: 'list' as const, list: parsed.data };
        }
        const run = buildAgentRun(
          await client.getAgentRun(params.runId!),
          new Date().toISOString(),
        );
        if (run.summary.runId !== params.runId)
          throw new Error('Unexpected agent run response.');
        log.debug(
          `Read ${run.summary.turnCount} turns and ${run.summary.actionCount} actions`,
        );
        return { action: 'get' as const, run };
      } catch (error) {
        throw new UserError(
          error instanceof Error ? error.message : 'Could not read agent runs.',
        );
      }
    },
    analyticsProps: (params, result) =>
      result.action === 'list'
        ? {
            action: result.action,
            list_count: result.list.runs.length,
            had_cursor: Boolean(params.cursor),
          }
        : {
            action: result.action,
            run_status: result.run.summary.status,
            turn_count: result.run.summary.turnCount,
            action_count: result.run.summary.actionCount,
            failed_action_count: result.run.summary.failedActionCount,
            result_truncated:
              result.run.payload.turns.at(-1)?.resultTruncated ?? false,
          },
    analyticsErrorProps: ({ action }) => ({ action }),
    format: async (result, _params, { uiEnabled, viewOwner }) => {
      if (result.action === 'list')
        return [{ type: 'text', text: formatAgentRunList(result.list) }];
      const { payload, summary, screenshotBase64 } = result.run;
      if (uiEnabled && !isCompliant(config)) {
        const screenshot = await prepareScreenshot(
          config,
          viewOwner,
          result.run,
        );
        const view = replayViews.prepareAgentRun(viewOwner, summary, {
          ...payload,
          screenshot,
        });
        if (view) {
          const lines = [
            formatAgentRunText(payload, summary, { timeline: false }),
          ];
          if (screenshot.state === 'available')
            lines.push(
              `Final screenshot: call browserless_show with ${JSON.stringify({ viewRef: screenshot.viewRef })}.`,
            );
          lines.push(
            `Call browserless_show with ${JSON.stringify({ viewRef: view.viewRef })} to inspect the timeline inline.`,
          );
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: view,
            _meta: replayViews.show(view.viewRef, viewOwner)._meta,
          };
        }
      }
      const text = formatAgentRunText(payload, summary, { timeline: true });
      return [
        {
          type: 'text',
          text:
            screenshotBase64 !== null
              ? `${text}\nFinal screenshot: captured. Open this run in an MCP Apps client to view it.`
              : text,
        },
      ];
    },
  });
}
