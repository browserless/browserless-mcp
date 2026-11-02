import { FastMCP, UserError } from 'fastmcp';
import { z } from 'zod';
import { defineTool } from '../lib/define-tool.js';
import { getActiveSessionByHandle } from '../lib/agent-client.js';
import { prepareHandoff, findHandoff, readHandoff } from '../lib/handoff.js';
import { VIEW_UNAVAILABLE } from '../lib/view-store.js';
import { isCompliant } from './compliance.js';
import type { PreparedView } from '../lib/view-schemas.js';
import { LiveURLInstructionsSchema } from './schemas.js';
import type { AnalyticsHelper } from '../lib/analytics.js';
import type {
  BrowserPages,
  LiveURLCreated,
  LiveURLState,
  McpConfig,
} from '../@types/types.js';

const stepsSchema = z.array(z.string().trim().min(1).max(300)).max(10);
const currentStepSchema = z.number().int().min(1).max(10);
const instructionsFormatSchema = z.enum(['text', 'markdown']);

export const LiveURLParamsSchema = z.object({
  action: z.enum([
    'create',
    'status',
    'close',
    'pages',
    'handoff',
    'handoff_status',
  ]),
  browserId: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Running browser ID from browserless_sessions action active, not an agent sessionId.',
    )
    .optional(),
  sessionId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'Existing browserless_agent session handle, required for handoff. Keep that browser open first.',
    ),
  viewRef: z
    .string()
    .max(128)
    .optional()
    .describe('Reference returned by handoff, required for handoff_status.'),
  liveURLId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Required for status and close.'),
  targetId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'For create: a targetId from action pages; the link stays on that tab unless mode is follow.',
    ),
  mode: z
    .enum(['follow', 'tab'])
    .optional()
    .describe(
      'For create: tab stays on one tab (default with targetId); follow jumps to new tabs (default without targetId).',
    ),
  mint: z
    .boolean()
    .optional()
    .describe(
      'For pages: also return a view-only liveURL per tab. A tab that already has a link returns it unchanged, with interactable.',
    ),
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
  instructions: LiveURLInstructionsSchema.optional().describe(
    'Tell the person what to do, for example: Sign in, then click Done.',
  ),
  instructionsTitle: z.string().trim().max(80).optional(),
  steps: stepsSchema.optional(),
  currentStep: currentStepSchema.optional(),
  doneLabel: z.string().trim().max(40).optional(),
  failLabel: z.string().trim().max(40).optional(),
  requesterName: z.string().trim().max(60).optional(),
  instructionsFormat: instructionsFormatSchema.optional(),
});

export function registerLiveURLTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<
    z.infer<typeof LiveURLParamsSchema>,
    | LiveURLCreated
    | LiveURLState
    | BrowserPages
    | PreparedView
    | { closed: true }
  >(server, config, analytics, {
    name: 'browserless_live_url',
    description:
      'Create, inspect, or close a live viewer link for an existing browser through REST, without an agent connection. ' +
      'Use pages to list browser tabs; mint=true adds per-tab live links. Reused links may be interactive, while new bulk links are view-only and pinned to their tabs. ' +
      'Pages returns targetId, url, title, active, and browserContextId. Create accepts targetId to stream a specific tab; mode follow jumps to new tabs, while tab stays on one tab. ' +
      'Create options default on the server: view-only, jpeg, quality 70, not resizable, browser interface shown (hidden with targetId). ' +
      'Link lifetime defaults to 15 minutes, capped by remaining browser session time; creating a link does not keep the browser alive. ' +
      'For a human handoff, pass instructions explaining what to do and when to click Done. ' +
      'Instructions accept a string or an object with layout, format, title, summary, steps, and currentStep. ' +
      'For string instructions use instructionsTitle, steps, currentStep, and instructionsFormat beside instructions. ' +
      'doneLabel, failLabel, and requesterName are always top-level options. ' +
      'Status returns status, reason, interactable, viewerCount, and expiresAt (epoch ms). ' +
      'Ended links remain inspectable until their browser closes; closing an ended link returns not found. ' +
      (!isCompliant(config) && config.transport === 'httpStream'
        ? 'For MCP Apps, use action handoff with the existing agent sessionId and plain-text instructions. Keep the browser open first. This pauses automation and returns a viewRef: display it with browserless_show. Wait for the person, then use handoff_status with that viewRef; continue with a fresh snapshot in the same session only when reason is userDone. Never open a replacement browser.'
        : ''),
    parameters: LiveURLParamsSchema,
    annotations: {
      title: 'Browserless Live URL',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    run: async ({
      client,
      params,
      token,
      apiUrl,
      userId,
      viewOwner,
      uiEnabled,
    }) => {
      if (params.action === 'handoff') {
        if (
          isCompliant(config) ||
          config.transport !== 'httpStream' ||
          !uiEnabled
        )
          throw new UserError(
            'Inline handoff requires the full HTTP surface and MCP Apps support. Use the agent liveURL command for an external viewer.',
          );
        if (
          !params.sessionId ||
          typeof params.instructions !== 'string' ||
          !params.instructions.trim() ||
          params.instructions.length > 2000
        )
          throw new UserError(
            'Handoff requires an existing agent sessionId and plain-text instructions.',
          );
        const session = getActiveSessionByHandle(
          params.sessionId,
          apiUrl,
          token,
          userId,
          false,
        );
        return prepareHandoff(
          session,
          viewOwner,
          client,
          params.instructions.trim().slice(0, 2000),
          params.timeout,
          session.apiUrl === config.browserlessApiUrl
            ? config.publicBrowserlessUrl
            : undefined,
        );
      }
      if (params.action === 'handoff_status') {
        const view = params.viewRef && findHandoff(params.viewRef, viewOwner);
        if (!view) throw new UserError(VIEW_UNAVAILABLE);
        return readHandoff(view, client);
      }
      const {
        action,
        browserId,
        liveURLId,
        mint,
        sessionId: _sessionId,
        viewRef: _viewRef,
        ...options
      } = LiveURLParamsSchema.parse(params);
      if (!browserId)
        throw new UserError(
          'browserId is required for create, status, close, and pages.',
        );
      if (action === 'pages') return client.listPages(browserId, mint);
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
