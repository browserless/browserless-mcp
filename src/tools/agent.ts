import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import {
  downloadUri,
  getDownload,
  storeDownload,
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

// Hard ceiling mirrored from the enterprise side (MAX_FILE_TRANSFER_MB cap).
// The server enforces its own (possibly lower) limit; this just stops the MCP
// from reading/shipping an oversized local upload before it ever hits the wire.
const FILE_TRANSFER_MAX_BYTES = 50 * 1024 * 1024;

type DownloadEntry = {
  filename?: string;
  mimeType?: string;
  size?: number;
  data?: string;
  error?: string;
  maxBytes?: number;
  message?: string;
};

// Resolve each uploadFile entry to base64 `content` before it hits the wire,
// so the model never has to emit a multi-MB base64 string itself:
//   - `content` (base64): used as-is.
//   - `handle`: a download handle/URI/path from a prior getDownloads — the MCP
//     server reads the stored file. Works in both transports (server-side).
//   - `path`: a local filesystem path — stdio only (HTTP can't read the client
//     filesystem).
export const normalizeUploadCommand = async (
  cmd: { method: string; params: Record<string, unknown> },
  transport: McpConfig['transport'],
  mcpBaseUrl?: string,
  token?: string,
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
        const tokenQ = `?token=${token ?? '<YOUR_BROWSERLESS_TOKEN>'}`;
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

const describeFailedDownload = (d: DownloadEntry): string =>
  `${d.filename ?? 'unknown'}: ${d.error ?? 'no data'}` +
  (d.maxBytes ? ` (max ${d.maxBytes} bytes)` : '');

// Persist a download to the server's filesystem (out of the model's context)
// and return its handle. Returns null for failed/empty entries.
const persistDownload = async (
  d: DownloadEntry,
): Promise<Awaited<ReturnType<typeof storeDownload>> | null> => {
  if (d.error || !d.data || !d.filename) return null;
  return storeDownload(
    d.filename,
    d.mimeType ?? 'application/octet-stream',
    Buffer.from(d.data, 'base64'),
  );
};

// stdio: files live on the same machine, so the handle is the on-disk path. The
// model gets paths it can hand straight to uploadFile — no base64 in context.
export const formatDownloadsStdio = async (
  downloads: DownloadEntry[],
  prefix: string,
  skills: string,
): Promise<Content[]> => {
  const lines: string[] = [];
  for (const d of downloads) {
    const record = await persistDownload(d);
    if (!record) {
      lines.push(`- ${describeFailedDownload(d)}`);
      continue;
    }
    lines.push(
      `- ${record.path} (${record.mimeType}, ${record.size} bytes) — ` +
        `reuse as uploadFile { path: "${record.path}" }`,
    );
  }
  const text = downloads.length
    ? `${prefix}Saved ${downloads.length} download(s):\n${lines.join('\n')}`
    : `${prefix}No new downloads.`;
  const content: Content[] = [{ type: 'text', text }];
  if (skills) content.push({ type: 'text', text: skills });
  return content;
};

// httpStream: no shared disk. Return a resource_link per file (a small handle,
// not the bytes) — the client reads it on demand via resources/read, and the
// same handle can be passed back to uploadFile. The base64 never enters context.
export const formatDownloadsHttp = async (
  downloads: DownloadEntry[],
  prefix: string,
  skills: string,
): Promise<Content[]> => {
  const content: Content[] = [
    {
      type: 'text',
      text: downloads.length
        ? `${prefix}${downloads.length} download(s) — read via the resource ` +
          `link, or reuse the URI as uploadFile { handle }:`
        : `${prefix}No new downloads.`,
    },
  ];
  for (const d of downloads) {
    const record = await persistDownload(d);
    if (!record) {
      content.push({ type: 'text', text: describeFailedDownload(d) });
      continue;
    }
    content.push({
      type: 'resource_link',
      uri: downloadUri(record.id),
      name: record.filename,
      mimeType: record.mimeType,
    });
  }
  if (skills) content.push({ type: 'text', text: skills });
  return content;
};

// Zod parses params at the tool boundary, so this only needs to supply the {}
// default when the field was omitted — the schema never delivers a string,
// array, or null here.
const coerceParams = (
  params: Record<string, unknown> | undefined,
): Record<string, unknown> => params ?? {};

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
    description: AGENT_SYSTEM_PROMPT,
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
    }) => {
      const commands: Array<{
        method: string;
        params: Record<string, unknown>;
      }> =
        params.commands && params.commands.length > 0
          ? params.commands.map((c) => ({
              method: c.method,
              params: coerceParams(c.params),
            }))
          : [{ method: params.method, params: coerceParams(params.params) }];

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
        closeSession(mcpSessionId, token, proxy, profile, createProfile);
        sendAnalytics(true);
        return [{ type: 'text' as const, text: 'Browser session closed.' }];
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
          );
        } catch (connErr: unknown) {
          // No retry when the server gave a definitive 4xx — re-attempting
          // with the same (bad token / wrong profile / unsupported params)
          // will just produce the same response and waste time.
          if (isRetry || !isRetryableUpgradeError(connErr)) {
            throw new UserError(formatConnectError(connErr));
          }
          destroySession(mcpSessionId, token, proxy, profile, createProfile);
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
            closeSession(mcpSessionId, token, proxy, profile, createProfile);
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
            destroySession(mcpSessionId, token, proxy, profile, createProfile);
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

        // Snapshot: format as compact ref-based text
        if (lastSnapshot) {
          const notice = buildCrossOriginNotice(
            crossOriginBaseline,
            lastSnapshot.url,
          );
          const noticeBlock = notice ? `${notice}\n\n` : '';
          if (lastSnapshot.url) agentSession.lastUrl = lastSnapshot.url;
          return [
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
        }

        // Downloads: branch on transport. stdio writes files to disk and
        // returns paths; httpStream returns the bytes as resource blocks. Either
        // way the base64 stays out of the model's text context.
        if (last.method === 'getDownloads') {
          const downloads =
            (lastResult?.downloads as DownloadEntry[] | undefined) ?? [];
          const skills = triggered.length > 0 ? renderSkills(triggered) : '';
          const prefix = batchPrefix + (closedSuffix ? `${closedSuffix}\n\n` : '');
          return config.transport === 'stdio'
            ? await formatDownloadsStdio(downloads, prefix, skills)
            : await formatDownloadsHttp(downloads, prefix, skills);
        }

        // Screenshot: return as image content block (vision input ≈ 1.5K tokens
        // vs. ~67K tokens if we dumped the base64 inline as text).
        if (last.method === 'screenshot') {
          const content = formatScreenshotContent(
            lastResult,
            lastCmd,
            batchPrefix,
            triggered.length > 0 ? renderSkills(triggered) : '',
          );
          if (content) return content;
        }

        // Everything else: return as JSON text
        return [
          {
            type: 'text' as const,
            text: appendSkills(
              batchPrefix + JSON.stringify(lastResult, null, 2),
              triggered,
            ),
          },
        ];
      };

      try {
        // Resolve any local upload paths to base64 once, before the (possibly
        // retried) send loop runs.
        for (const cmd of commands) {
          await normalizeUploadCommand(
            cmd,
            config.transport,
            config.mcpBaseUrl,
            token,
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
