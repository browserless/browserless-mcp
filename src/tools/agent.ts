import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  downloadUri,
  getDownload,
  storeDownload,
  FILE_TRANSFER_MAX_BYTES,
  type StoredDownload,
} from '../lib/download-store.js';
import {
  getOrCreateSession,
  send,
  closeSession,
  destroySession,
  isRetryableUpgradeError,
} from '../lib/agent-client.js';
import type {
  AgentParams,
  McpConfig,
  SkillId,
  SnapshotResult,
} from '../@types/types.js';
import { classifyAgentError } from '../lib/error-classifier.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool } from '../lib/define-tool.js';
import {
  detectSkills,
  markFired,
  renderSkill,
  renderSkills,
  skillsRegistry,
} from '../skills/index.js';
import { AgentParamsSchema } from './schemas.js';
import {
  AGENT_SYSTEM_PROMPT,
  SKILL_TOOL_DESCRIPTION,
  fileTransferModeNote,
} from '../skills/system-prompt.js';
import {
  buildCrossOriginNotice,
  formatConnectError,
  formatErrorMessage,
  formatSnapshot,
} from '../lib/agent-format.js';

// export schemas, system prompt, and formatters
export { AgentParamsSchema } from './schemas.js';
export {
  buildCrossOriginNotice,
  formatConnectError,
  formatErrorMessage,
  formatSnapshot,
  sanitizeUpgradeBody,
} from '../lib/agent-format.js';

const SNAPSHOT_METHOD = 'snapshot';
const FATAL_CODES = new Set(['BROWSER_CRASHED']);

const appendSkills = (base: string, ids: ReadonlyArray<SkillId>): string => {
  if (ids.length === 0) return base;
  return `${base}\n\n${renderSkills(ids)}`;
};

const SCREENSHOT_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  png: 'image/png',
};

/**
 * Build the MCP response for a screenshot command, or null when there's no
 * base64 payload (caller falls back to JSON text). Returns the image as a
 * vision content block (~1.5K tokens) vs. ~67K inlining the base64 as text.
 */
export const formatScreenshotContent = (
  result: unknown,
  cmd: { params?: Record<string, unknown> },
  caption: string,
  skills: string,
): Content[] | null => {
  const base64 =
    typeof (result as Record<string, unknown> | null)?.base64 === 'string'
      ? ((result as Record<string, unknown>).base64 as string)
      : '';
  if (!base64) return null;

  const requestedType =
    typeof cmd.params?.type === 'string' ? cmd.params.type : 'png';
  const mimeType = SCREENSHOT_MIME[requestedType] ?? 'image/png';

  const decodedBytes = Math.floor(base64.length * 0.75);
  const sizeLabel =
    decodedBytes >= 1_048_576
      ? `${(decodedBytes / 1_048_576).toFixed(1)} MB`
      : `${Math.round(decodedBytes / 1024)} KB`;

  const captionText = [
    caption.trimEnd(),
    `Screenshot captured (${mimeType}, ~${sizeLabel}).`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const content: Content[] = [
    { type: 'text', text: captionText },
    { type: 'image', data: base64, mimeType },
  ];
  if (skills) content.push({ type: 'text', text: skills });
  return content;
};

type DownloadEntry = {
  filename?: string;
  mimeType?: string;
  size?: number;
  data?: string;
  error?: string;
  maxBytes?: number;
  sourceUrl?: string;
  inProgress?: boolean;
  receivedBytes?: number;
  totalBytes?: number;
};

const fmtBytes = (n?: number): string =>
  typeof n !== 'number'
    ? '?'
    : n >= 1_048_576
      ? `${(n / 1_048_576).toFixed(1)}MB`
      : `${Math.round(n / 1024)}KB`;

// Still-downloading entry: report progress so the caller knows to touch the
// browser again to collect it (no bytes, nothing to save yet).
const describeInProgressDownload = (d: DownloadEntry): string => {
  const got = fmtBytes(d.receivedBytes);
  const total =
    d.totalBytes && d.totalBytes > 0 ? ` / ${fmtBytes(d.totalBytes)}` : '';
  return `${d.filename ?? 'file'} — downloading (${got}${total}); touch the browser again to collect it`;
};

// Resolve each uploadFile entry to base64 `content` (from `content`, a prior
// `handle`, or a local `path` in stdio) so the model never emits base64 itself.
export const normalizeUploadCommand = async (
  cmd: { method: string; params: Record<string, unknown> },
  transport: McpConfig['transport'],
  mcpBaseUrl?: string,
): Promise<void> => {
  if (cmd.method !== 'uploadFile') return;
  const files = cmd.params.files;
  if (!Array.isArray(files)) return;
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const f = file as Record<string, unknown>;
    if (typeof f.content === 'string' && f.content) continue;

    let buf: Buffer;
    let defaultName: string;

    if (typeof f.handle === 'string' && f.handle) {
      const record = getDownload(f.handle);
      if (!record) {
        throw new UserError(
          `Unknown upload handle "${f.handle}". Pass a handle returned by ` +
            `getDownloads, or supply base64 "content".`,
        );
      }
      buf = await readFile(record.path);
      defaultName = record.filename;
      delete f.handle;
    } else if (typeof f.path === 'string' && f.path) {
      if (transport !== 'stdio') {
        const base = mcpBaseUrl ?? '<MCP_BASE_URL>';
        const tokenQ = '?token=<YOUR_BROWSERLESS_TOKEN>';
        throw new UserError(
          'uploadFile "path" is not available in HTTP mode (the server can\'t ' +
            'read your filesystem). Stage the file once over HTTP, then pass the ' +
            'returned handle — do NOT base64 it through the conversation:\n' +
            `  curl -s -F file=@"${f.path}" "${base}/upload${tokenQ}"\n` +
            'then: uploadFile { files: [{ handle: "<handle from the response>" }] }',
        );
      }
      const path = f.path;
      buf = await readFile(path).catch((e: unknown) => {
        throw new UserError(
          `Failed to read upload file "${path}": ` +
            (e instanceof Error ? e.message : String(e)),
        );
      });
      defaultName = basename(path);
      delete f.path;
    } else {
      continue;
    }

    if (buf.byteLength > FILE_TRANSFER_MAX_BYTES) {
      throw new UserError(
        `Upload file "${defaultName}" is ${buf.byteLength} bytes, over the ` +
          `50MB limit.`,
      );
    }
    f.content = buf.toString('base64');
    if (!f.name) f.name = defaultName;
  }
};

const describeFailedDownload = (d: DownloadEntry): string => {
  let s =
    `${d.filename ?? 'unknown'}: ${d.error ?? 'no data'}` +
    (d.maxBytes ? ` (max ${d.maxBytes} bytes)` : '');
  // Over-cap files can't go through the transfer flow — point at the source so
  // the caller can fetch it directly (e.g. curl) if it has network access.
  if (d.error === 'FileTooLarge' && d.sourceUrl) {
    s += ` — too large to transfer; fetch directly: ${d.sourceUrl}`;
  }
  return s;
};

// Persist a download to the server's filesystem (out of the model's context),
// tagged to the MCP session for cleanup. Returns null for failed/empty entries.
const persistDownload = async (
  d: DownloadEntry,
  sessionId?: string,
): Promise<Awaited<ReturnType<typeof storeDownload>> | null> => {
  if (d.error || !d.data || !d.filename) return null;
  return storeDownload(
    d.filename,
    d.mimeType ?? 'application/octet-stream',
    Buffer.from(d.data, 'base64'),
    sessionId,
  );
};

type FormatOpts = {
  transport: McpConfig['transport'];
  sessionId?: string;
  mcpBaseUrl?: string;
  token?: string;
};

// stdio: file is already on the local disk → return its path (reuse as
// uploadFile { path }). http: return a single-use GET URL + handle; base64
// never enters context, and fetching consumes the file.
const describeReadyDownload = (
  record: StoredDownload,
  opts: FormatOpts,
): string => {
  if (opts.transport === 'stdio') {
    return (
      `${record.path} (${record.mimeType}, ${record.size} bytes) — ` +
      `reuse as uploadFile { path: "${record.path}" }`
    );
  }
  const base = opts.mcpBaseUrl ?? '<MCP_BASE_URL>';
  const tokenQ = `?token=${opts.token ?? '<YOUR_BROWSERLESS_TOKEN>'}`;
  return (
    `${record.filename} (${record.mimeType}, ${record.size} bytes)\n` +
    `    save it:  curl -s "${base}/download/${record.id}${tokenQ}" -o "${record.filename}"   (single use)\n` +
    `    or reuse: uploadFile { files: [{ handle: "${downloadUri(record.id)}" }] }`
  );
};

// Surface captured downloads as metadata + how to retrieve them (never bytes).
export const formatDownloads = async (
  downloads: DownloadEntry[],
  prefix: string,
  skills: string,
  opts: FormatOpts,
): Promise<Content[]> => {
  const lines: string[] = [];
  for (const d of downloads) {
    if (d.inProgress) {
      lines.push(`- ${describeInProgressDownload(d)}`);
      continue;
    }
    const record = await persistDownload(d, opts.sessionId);
    lines.push(
      `- ${record ? describeReadyDownload(record, opts) : describeFailedDownload(d)}`,
    );
  }
  const header =
    opts.transport === 'stdio'
      ? 'Downloads:'
      : 'Downloads (save the ones you need — each GET works once):';
  const text = downloads.length
    ? `${prefix}${header}\n${lines.join('\n')}`
    : `${prefix}No new downloads.`;
  const content: Content[] = [{ type: 'text', text }];
  if (skills) content.push({ type: 'text', text: skills });
  return content;
};

const SkillIdSchema = z.enum(
  skillsRegistry.map((s) => s.id) as [SkillId, ...SkillId[]],
);

const SkillToolParamsSchema = z.object({
  id: SkillIdSchema.describe(
    'The skill to load (see tool description for the full list).',
  ),
});

export function registerAgentTools(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<{ id: SkillId }, string>(server, config, analytics, {
    name: 'browserless_skill',
    description: SKILL_TOOL_DESCRIPTION,
    parameters: SkillToolParamsSchema,
    annotations: {
      title: 'Load Browserless Skill',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    run: async ({ params }) => renderSkill(params.id),
    analyticsProps: (params, body) => ({
      skill: params.id,
      success: !!body,
    }),
    format: (body, params) => {
      if (!body) throw new UserError(`Unknown skill id: ${params.id}`);
      return [{ type: 'text' as const, text: body }];
    },
  });

  defineTool<AgentParams, Content[]>(server, config, analytics, {
    name: 'browserless_agent',
    description:
      AGENT_SYSTEM_PROMPT +
      fileTransferModeNote(config.transport, config.mcpBaseUrl),
    parameters: AgentParamsSchema,
    annotations: {
      title: 'Browserless Agent',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    run: async ({
      params,
      log,
      analytics,
      token,
      apiUrl,
      sessionId: mcpSessionId,
      attachSessionId,
    }) => {
      const commands: Array<{
        method: string;
        params: Record<string, unknown>;
      }> =
        params.commands && params.commands.length > 0
          ? params.commands.map((c) => ({
              method: c.method,
              params: c.params ?? {},
            }))
          : [{ method: params.method, params: params.params ?? {} }];

      const proxy = params.proxy;
      const profile = params.profile;
      const createProfile = params.createProfile;

      const sendAnalytics = (success: boolean) => {
        analytics?.fireToolRequest(token, 'browserless_agent', {
          methods: commands.map((c) => c.method).join(','),
          command_count: commands.length,
          api_url: apiUrl,
          success,
          proxy_tier: proxy?.proxy ?? null,
          proxy_country: proxy?.proxyCountry ?? null,
          proxy_sticky: !!proxy?.proxySticky,
          proxy_external: !!proxy?.externalProxyServer,
          profile_used: !!profile,
          create_profile: !!createProfile,
        });
      };

      const proxyCmd = commands.find((c) => c.method === 'proxy');
      if (proxyCmd) {
        sendAnalytics(false);
        throw new UserError(
          'Invalid command: "proxy" is not a BQL mutation. Proxy config is a top-level tool argument (proxy, proxyCountry, proxyState, proxyCity, proxySticky, proxyLocaleMatch, proxyPreset, externalProxyServer) and is read once at session creation. ' +
            'Recovery: call `close` to end the current session, then call browserless_agent again with the proxy options set at the top level (alongside `method`/`commands`), e.g. { "proxy": "residential", "proxyCountry": "us", "commands": [ ... ] }.',
        );
      }

      if (commands.length === 1 && commands[0].method === 'close') {
        closeSession(
          mcpSessionId,
          token,
          proxy,
          profile,
          createProfile,
          attachSessionId,
        );
        sendAnalytics(true);
        return [{ type: 'text' as const, text: 'Browser session closed.' }];
      }

      // Open-only call: no real command (e.g. `createProfile`/`profile`/`proxy`
      // set with no method/commands). Dispatching the empty-method default would
      // make the agent route reject it as `Missing required id/method`, so just
      // open (or reuse) the session and report it's ready for follow-up commands.
      if (commands.length === 1 && !commands[0].method) {
        try {
          await getOrCreateSession(
            mcpSessionId,
            apiUrl,
            token,
            proxy,
            profile,
            createProfile,
            attachSessionId,
          );
        } catch (connErr: unknown) {
          sendAnalytics(false);
          throw new UserError(formatConnectError(connErr));
        }
        sendAnalytics(true);
        const text = createProfile
          ? `Profile-creation session "${createProfile.name}" is open (non-headless). Send commands to drive the login, then call saveProfile.`
          : 'Browser session is open. Send commands to drive it.';
        return [{ type: 'text' as const, text }];
      }

      const runCommands = async (isRetry: boolean): Promise<Content[]> => {
        let agentSession;
        try {
          agentSession = await getOrCreateSession(
            mcpSessionId,
            apiUrl,
            token,
            proxy,
            profile,
            createProfile,
            attachSessionId,
          );
        } catch (connErr: unknown) {
          // No retry when the server gave a definitive 4xx — re-attempting
          // with the same (bad token / wrong profile / unsupported params)
          // will just produce the same response and waste time.
          if (isRetry || !isRetryableUpgradeError(connErr)) {
            throw new UserError(formatConnectError(connErr));
          }
          destroySession(
            mcpSessionId,
            token,
            proxy,
            profile,
            createProfile,
            attachSessionId,
          );
          return runCommands(true);
        }

        // Execute all commands sequentially
        const results: Array<{ method: string; result?: unknown }> = [];
        let closedDuringBatch = false;
        // Cross-origin baseline: prefer the URL from the previous snapshot,
        // else the first URL seen this batch — so [goto A, goto B, snapshot]
        // still detects the A→snapshot cross-origin transition.
        let crossOriginBaseline: string | undefined = agentSession.lastUrl;
        for (const cmd of commands) {
          if (cmd.method === 'close') {
            closeSession(
              mcpSessionId,
              token,
              proxy,
              profile,
              createProfile,
              attachSessionId,
            );
            results.push({ method: 'close', result: { closed: true } });
            closedDuringBatch = true;
            break;
          }

          log.info(`agent: ${cmd.method} ${JSON.stringify(cmd.params)}`);

          agentSession.skillState.cmdIndex += 1;

          let resp;
          try {
            resp = await send(agentSession, cmd.method, cmd.params);
          } catch (sendErr: unknown) {
            destroySession(
              mcpSessionId,
              token,
              proxy,
              profile,
              createProfile,
              attachSessionId,
            );
            const errMessage =
              sendErr instanceof Error ? sendErr.message : String(sendErr);
            if (!isRetry) {
              log.warn(
                `agent: ${cmd.method} failed (first attempt, retrying once): ${errMessage}`,
              );
              return runCommands(true);
            }
            const classified = classifyAgentError({
              err: { message: errMessage },
              cmd,
            });
            throw new UserError(
              formatErrorMessage({
                category: classified.category,
                prefix: `${cmd.method} failed: `,
                message: errMessage,
                recovery: classified.recovery,
              }),
            );
          }

          if (resp.error) {
            const err = resp.error;
            if (err.code && FATAL_CODES.has(err.code)) {
              destroySession(
                mcpSessionId,
                token,
                proxy,
                profile,
                createProfile,
                attachSessionId,
              );
              if (!isRetry) {
                return runCommands(true);
              }
            }

            const classified = classifyAgentError({ err, cmd });

            const prefix =
              commands.length > 1
                ? `Batch failed at "${cmd.method}" (after ${results.map((r) => r.method).join(' → ') || 'start'}): `
                : `${cmd.method} failed: `;

            let suggestion: string | undefined;
            if (
              err.code === 'SELECTOR_NOT_FOUND' &&
              cmd.params.selector &&
              typeof cmd.params.selector === 'string' &&
              !cmd.params.selector.startsWith('< ')
            ) {
              suggestion = `Retry with deep selector "< ${cmd.params.selector}" — the element is likely inside a shadow DOM.`;
            } else if (err.suggestion) {
              suggestion = err.suggestion;
            }

            const body = formatErrorMessage({
              category: classified.category,
              code: err.code,
              prefix,
              message: err.message,
              suggestion,
              recovery: classified.recovery,
              snapshotText: err.snapshot
                ? formatSnapshot(err.snapshot)
                : undefined,
            });

            const triggered = detectSkills(
              { snapshot: err.snapshot, error: err, cmd, apiUrl },
              agentSession.skillState,
            );
            markFired(agentSession.skillState, triggered);

            throw new UserError(appendSkills(body, triggered));
          }

          // Capture the first URL we observe in the batch as a fallback
          // baseline for the cross-origin notice.
          if (!crossOriginBaseline) {
            const r = resp.result as { url?: unknown } | undefined;
            if (r && typeof r.url === 'string') {
              crossOriginBaseline = r.url;
            }
          }

          results.push({ method: cmd.method, result: resp.result });
        }

        // If the batch ended with close, format the result around the
        // command before close (close itself has no useful payload).
        const reportable = closedDuringBatch ? results.slice(0, -1) : results;
        const last = reportable[reportable.length - 1];
        const lastResult = last.result as Record<string, unknown>;
        const lastCmd = commands[commands.length - 1];

        const closedSuffix = closedDuringBatch
          ? '\n\nBrowser session closed.'
          : '';

        const batchPrefix =
          commands.length > 1
            ? `Executed: ${results.map((r) => r.method).join(' → ')}\n\n`
            : '';

        const lastSnapshot =
          last.method === SNAPSHOT_METHOD
            ? (lastResult as unknown as SnapshotResult)
            : undefined;

        const triggered = detectSkills(
          {
            snapshot: lastSnapshot,
            cmd: lastCmd,
            resp: lastResult,
            apiUrl,
          },
          agentSession.skillState,
        );
        markFired(agentSession.skillState, triggered);

        // The whole batch was just `close` (or close-only after a no-op
        // prefix that produced nothing reportable).
        if (!last) {
          return [{ type: 'text' as const, text: 'Browser session closed.' }];
        }

        // Auto-surface files Chrome captured this batch so the model needn't call
        // getDownloads. Skipped on explicit drain/close; a failed poll is ignored.
        let autoDownloads: DownloadEntry[] = [];
        if (!closedDuringBatch && last.method !== 'getDownloads') {
          try {
            const dl = await send(agentSession, 'getDownloads', {});
            autoDownloads =
              (dl.result as { downloads?: DownloadEntry[] } | undefined)
                ?.downloads ?? [];
          } catch {
            // ignore — downloads will surface on a later call
          }
        }

        const skillsText = triggered.length > 0 ? renderSkills(triggered) : '';
        let baseContent: Content[];

        if (lastSnapshot) {
          // Snapshot: compact ref-based text.
          const notice = buildCrossOriginNotice(
            crossOriginBaseline,
            lastSnapshot.url,
          );
          const noticeBlock = notice ? `${notice}\n\n` : '';
          if (lastSnapshot.url) agentSession.lastUrl = lastSnapshot.url;
          baseContent = [
            {
              type: 'text' as const,
              text: appendSkills(
                batchPrefix +
                  noticeBlock +
                  formatSnapshot(lastSnapshot) +
                  closedSuffix,
                triggered,
              ),
            },
          ];
        } else if (last.method === 'getDownloads') {
          // Explicit drain.
          const downloads =
            (lastResult?.downloads as DownloadEntry[] | undefined) ?? [];
          const prefix =
            batchPrefix + (closedSuffix ? `${closedSuffix}\n\n` : '');
          return await formatDownloads(downloads, prefix, skillsText, {
            transport: config.transport,
            sessionId: mcpSessionId,
            mcpBaseUrl: config.mcpBaseUrl,
            token,
          });
        } else {
          // Screenshot → image content block; otherwise JSON text.
          const shot =
            last.method === 'screenshot'
              ? formatScreenshotContent(
                  lastResult,
                  lastCmd,
                  batchPrefix,
                  skillsText,
                )
              : null;
          baseContent = shot ?? [
            {
              type: 'text' as const,
              text: appendSkills(
                batchPrefix + JSON.stringify(lastResult, null, 2),
                triggered,
              ),
            },
          ];
        }

        // Append the captured-download notification (metadata only, no bytes).
        if (autoDownloads.length > 0) {
          const notice = await formatDownloads(autoDownloads, '', '', {
            transport: config.transport,
            sessionId: mcpSessionId,
            mcpBaseUrl: config.mcpBaseUrl,
            token,
          });
          baseContent = [...baseContent, ...notice];
        }

        return baseContent;
      };

      try {
        // Resolve any local upload paths to base64 once, before the (possibly
        // retried) send loop runs.
        for (const cmd of commands) {
          await normalizeUploadCommand(
            cmd,
            config.transport,
            config.mcpBaseUrl,
          );
        }
        const result = await runCommands(false);
        sendAnalytics(true);
        return result;
      } catch (err) {
        sendAnalytics(false);
        throw err;
      }
    },
    format: (content) => content,
  });
}
