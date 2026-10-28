import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';

import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { z } from 'zod';

import { accountQuery } from '../lib/account-api.js';
import {
  buildReplayHtml,
  fetchReplayArtifact,
  MAX_INLINE_BYTES_LOCAL,
  MAX_INLINE_BYTES_REMOTE,
  openCommandFor,
  replayBrowser,
  type ReplayArtifact,
  writeReplayArtifacts,
} from '../lib/session-replay-artifact.js';
import { AnalyticsHelper } from '../lib/analytics.js';
import { defineTool } from '../lib/define-tool.js';
import { isCompliant } from './compliance.js';
import { describeReadyDownload } from './agent.js';
import { downloadOwner, storeDownload } from '../lib/download-store.js';
import type { McpConfig } from '../@types/types.js';
import { replayViews } from '../lib/view-store.js';
import { ShowOutputSchema, type PreparedView } from '../lib/view-schemas.js';

export const SessionsParamsSchema = z.object({
  action: z
    .enum(['active', 'persistent', 'replays', 'replay', 'integrations'])
    .describe(
      'Which session data to read. `active` = browsers running right now; ' +
        '`persistent` = saved sessions on dedicated workers, running or not; ' +
        '`replays` = list recorded session replays; `replay` = download one ' +
        'replay and render it as a playable rrweb page (needs `sessionId`); ' +
        '`integrations` = 1Password credential integrations.',
    ),
  sessionId: z
    .string()
    .max(128)
    .optional()
    .describe(
      'Which replay to download, for action `replay`. Get ids from action `replays`.',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Maximum rows to return (max 50). Applies to every action.'),
  skip: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Rows to skip, for paging through `active` or `integrations`.'),
  page: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Page number for `replays` (1-based).'),
  search: z
    .string()
    .max(256)
    .optional()
    .describe('Filter `replays` by website or session id.'),
});

export type SessionsParams = z.infer<typeof SessionsParamsSchema>;

interface ActiveSession {
  browserId: string | null;
  startTime: string | null;
  browserName: string | null;
  type: string | null;
}

interface PersistentSession {
  id: string | null;
  browser: string | null;
  running: boolean | null;
  expiresAt: string | null;
  profile: string | null;
  url: string | null;
}

interface ReplayEntry {
  sessionId: string | null;
  website: string | null;
  duration: number | null;
  eventCount: number | null;
  timestamp: number | null;
}

interface OpIntegration {
  id: string;
  label: string;
  kind: string;
  allowedDomains: string[];
  expiresAt: string | null;
  vaults?: string[] | null;
}

interface SessionsResult {
  active?: { sessions: ActiveSession[] | null; count: number | null };
  persistent?: { sessions: PersistentSession[] | null; count: number | null };
  replays?: {
    data: ReplayEntry[] | null;
    totalCount: number | null;
    page: number | null;
    totalPages: number | null;
  };
  integrations?: OpIntegration[] | null;
  replay?: {
    artifact: ReplayArtifact;
    view?: PreparedView;
    html: string;
    htmlPath: string;
    jsonPath: string;
    openedInBrowser: boolean;
    inlined: boolean;
    local: boolean;
    bytes: number;
  };
}

// One document per action: a single query selecting all four would make every
// call pay for four backends, and `persistent` fans out across dedicated workers.
const ACTIVE_QUERY = `
  query ActiveSessions($apiToken: String, $limit: Int, $skip: Int) {
    getActiveSession(apiToken: $apiToken, limit: $limit, skip: $skip) {
      sessions {
        browserId
        startTime
        browserName
        type
      }
      count
    }
  }
`;

const PERSISTENT_QUERY = `
  query PersistentSessions($apiToken: String) {
    getPersistentSessions(apiToken: $apiToken) {
      sessions {
        id
        browser
        running
        expiresAt
        profile
        url
      }
      count
    }
  }
`;

// Replay storage is private: the server issues a short-lived signed `url`
// only to the replay's owner, so it is requested per download, not listed.
const REPLAY_QUERY = `
  query SessionReplay($apiToken: String!, $sessionId: String!) {
    sessionReplayBySessionId(apiToken: $apiToken, sessionId: $sessionId) {
      sessionId
      website
      timestamp
      url
    }
  }
`;

// `apiKey` is deliberately not selected — it is token material.
const REPLAYS_QUERY = `
  query SessionReplays(
    $apiToken: String!
    $page: Int
    $pageSize: Int
    $search: String
  ) {
    sessionReplayList(
      apiToken: $apiToken
      page: $page
      pageSize: $pageSize
      search: $search
    ) {
      data {
        sessionId
        website
        duration
        eventCount
        timestamp
      }
      totalCount
      page
      totalPages
    }
  }
`;

const INTEGRATIONS_QUERY = `
  query OnePasswordIntegrations($apiToken: String, $limit: Int, $offset: Int, $includeVaults: Boolean) {
    listOnePasswordIntegrations(
      apiToken: $apiToken
      limit: $limit
      offset: $offset
      includeVaults: $includeVaults
    ) {
      id
      label
      kind
      allowedDomains
      expiresAt
      vaults
    }
  }
`;

const formatActive = (result: SessionsResult): string => {
  const sessions = result.active?.sessions ?? [];
  if (!sessions.length) {
    return 'No browsers are running on this account right now.';
  }
  const rows = sessions.map(
    (s) =>
      `- \`${s.browserId ?? '?'}\` — ${s.browserName ?? 'unknown browser'}` +
      `${s.type ? ` (${s.type})` : ''}, started ${s.startTime ?? 'unknown'}`,
  );
  return [
    `## Active sessions (${result.active?.count ?? sessions.length})`,
    ``,
    ...rows,
  ].join('\n');
};

const formatPersistent = (result: SessionsResult): string => {
  const sessions = result.persistent?.sessions ?? [];
  if (!sessions.length) {
    return (
      'No persistent sessions were found. These live on dedicated workers, ' +
      'so a shared-fleet account will always report none.'
    );
  }
  const rows = sessions.map(
    (s) =>
      `- \`${s.id ?? '?'}\` — ${s.browser ?? 'unknown'}, ` +
      `${s.running ? 'running' : 'stopped'}` +
      `${s.profile ? `, profile ${s.profile}` : ''}` +
      `${s.url ? `, ${s.url}` : ''}` +
      `${s.expiresAt ? `, expires ${s.expiresAt}` : ''}`,
  );
  return [
    `## Persistent sessions (${result.persistent?.count ?? sessions.length})`,
    ``,
    ...rows,
  ].join('\n');
};

const formatReplays = (result: SessionsResult): string => {
  const entries = result.replays?.data ?? [];
  if (!entries.length) {
    return 'No session replays have been recorded for this account.';
  }
  const rows = entries.map((entry) => {
    const when = entry.timestamp
      ? new Date(entry.timestamp * 1000).toISOString()
      : 'unknown time';
    const seconds =
      entry.duration != null ? `${Math.round(entry.duration / 1000)}s` : '?';
    return (
      `- \`${entry.sessionId ?? '?'}\` — ${entry.website ?? 'unknown site'}, ` +
      `${seconds}, ${entry.eventCount ?? 0} events, ${when}`
    );
  });
  const { page, totalPages, totalCount } = result.replays ?? {};
  const footer =
    totalPages && totalPages > 1
      ? `\nPage ${page ?? 1} of ${totalPages} — pass \`page\` to see more.`
      : '';
  return [
    `## Session replays (${totalCount ?? entries.length})`,
    ``,
    ...rows,
    footer,
  ].join('\n');
};

const formatIntegrations = (result: SessionsResult): string => {
  const integrations = result.integrations ?? [];
  if (!integrations.length) {
    return 'No 1Password integrations are configured for this account.';
  }
  const rows = integrations.map(
    (op) =>
      `- \`${op.id}\` — "${op.label}" (${op.kind}); fills: ${op.allowedDomains.length ? op.allowedDomains.join(', ') : 'any https origin'}` +
      `${op.expiresAt ? `; expires ${op.expiresAt}` : ''}` +
      `; vaults: ${op.vaults == null ? 'unavailable (1Password did not answer)' : op.vaults.length ? op.vaults.join(', ') : 'none visible to this service account'}`,
  );
  return [
    `## 1Password integrations (${integrations.length})`,
    ``,
    ...rows,
    ``,
    'Pass the `op_int_…` id or the label as `integrationId` on the FIRST browserless_agent call and on every call after — a call without it has no vault bound and credential commands return CredentialNotResolved. `saveSecret` needs no `vault` when one vault is listed; name one of the listed titles otherwise.',
  ].join('\n');
};

const formatReplay = (result: SessionsResult, downloads?: string): string => {
  const r = result.replay;
  if (!r) return 'No replay was downloaded.';
  const { artifact, htmlPath, jsonPath, openedInBrowser, inlined, local } = r;
  const seconds =
    typeof artifact.duration === 'number'
      ? `${Math.round(artifact.duration / 1000)}s`
      : 'unknown length';
  const kb = Math.round(r.bytes / 1024);

  const head = [
    `## Replay \`${artifact.sessionId}\``,
    ``,
    `- Site: ${artifact.website ?? 'unknown'}`,
    `- Length: ${seconds}, ${artifact.events.length} events`,
    ...(local
      ? [
          `- Player (self-contained, plays offline): ${htmlPath}`,
          `- Raw rrweb events: ${jsonPath}`,
        ]
      : []),
    ``,
    `### How to show it`,
    ``,
  ];

  // The path is only reachable when the server shares the caller's machine.
  const how = local
    ? [
        openedInBrowser
          ? `Already opened in the user's browser — say it is playing, and stop.`
          : `Run this to open it in their browser:\n\n    ${openCommandFor(htmlPath)}\n`,
      ]
    : inlined
      ? [
          `An equivalent \`text/html\` resource (${kb} KB) is attached to this ` +
            `response. It is a complete, self-contained page and it is already ` +
            `built — never rebuild the player. Show it whichever way you can ` +
            `display HTML: inline if your surface renders a page that size, ` +
            `otherwise write the resource to a .html file and open or publish ` +
            `that. Most of those bytes are the player itself, so move them to ` +
            `the file without reading them into context. If your host wraps ` +
            `page content in its own HTML skeleton, insert the contents of ` +
            `this page's head and body into it — the style and script ` +
            `elements, then the markup — and drop the doctype, html, head and ` +
            `body tags themselves, since a nested head or body can stop the ` +
            `player's CSS or scripts from running.`,
        ]
      : [
          `The player is ${kb} KB — too large to attach inline. ` +
            `Download the HTML to a local file using the save command below, ` +
            `then open it in the user's browser or publish it as an artifact. ` +
            `It is self-contained and plays offline; never rebuild the player.`,
          downloads ?? '',
          `Downloads are single-use and expire after 15 minutes or when the MCP session ends.`,
        ];

  return [
    ...head,
    ...how,
    ``,
    `**Do not read either file.** They are hundreds of kilobytes of DOM-event ` +
      `JSON — cat/jq/Read on them wastes the context window and shows the user ` +
      `nothing. Never paste raw events, and never describe the replay instead of ` +
      `showing it.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
};

const FORMATTERS: Record<
  SessionsParams['action'],
  (result: SessionsResult, downloads?: string) => string
> = {
  active: formatActive,
  persistent: formatPersistent,
  replays: formatReplays,
  replay: formatReplay,
  integrations: formatIntegrations,
};

export function registerSessionsTool(
  server: FastMCP,
  config: McpConfig,
  analytics?: AnalyticsHelper,
): void {
  defineTool<SessionsParams, SessionsResult>(server, config, analytics, {
    name: 'browserless_sessions',
    description:
      'Inspect the sessions on the Browserless account behind the current API ' +
      'token: browsers running right now, persistent sessions saved on ' +
      'dedicated workers, recorded session replays, and 1Password credential ' +
      'integrations. Use it to answer "what is running", "did my session ' +
      'survive", or "what got recorded". Read-only — it never stops a session. ' +
      'Action `replay` downloads one recording and returns a fully self-contained ' +
      'playable rrweb page, needing no network to render: display it inline if ' +
      'you can render HTML, otherwise ' +
      'build an artifact from the returned instructions so the user can watch it. ' +
      'Always show the replay — never just summarise it in words.' +
      (isCompliant(config)
        ? ''
        : ' For MCP Apps clients, action replay returns a viewRef without rendering. Call browserless_show with that exact reference to display the recording; do not read or repeat the recording data.'),
    parameters: SessionsParamsSchema,
    ...(!isCompliant(config)
      ? {
          outputSchema: z.object({
            action: SessionsParamsSchema.shape.action,
            summary: z.string(),
            viewRef: ShowOutputSchema.shape.viewRef.optional(),
            kind: ShowOutputSchema.shape.kind.optional(),
            expiresAt: ShowOutputSchema.shape.expiresAt.optional(),
            data: ShowOutputSchema.shape.data.optional(),
          }),
        }
      : {}),
    annotations: {
      title: 'Browserless Sessions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: async ({ params, token, log, uiEnabled, viewOwner }) => {
      const { action, limit, skip, page, search } = params;
      log.debug(`Reading sessions (${action})`);

      switch (action) {
        case 'active': {
          const data = await accountQuery<{
            getActiveSession: SessionsResult['active'];
          }>(config, token, ACTIVE_QUERY, { limit, skip });
          return { active: data.getActiveSession };
        }
        case 'persistent': {
          const data = await accountQuery<{
            getPersistentSessions: SessionsResult['persistent'];
          }>(config, token, PERSISTENT_QUERY);
          return { persistent: data.getPersistentSessions };
        }
        case 'replays': {
          const data = await accountQuery<{
            sessionReplayList: SessionsResult['replays'];
          }>(config, token, REPLAYS_QUERY, { page, pageSize: limit, search });
          return { replays: data.sessionReplayList };
        }
        case 'replay': {
          if (!params.sessionId) {
            throw new UserError(
              'A sessionId is required to download a replay. List them with action "replays" first.',
            );
          }
          const { sessionReplayBySessionId: entry } = await accountQuery<{
            sessionReplayBySessionId: {
              website?: string | null;
              timestamp?: number | null;
              url?: string | null;
            } | null;
          }>(config, token, REPLAY_QUERY, { sessionId: params.sessionId });
          if (!entry?.url) {
            throw new UserError(
              `No replay found for session "${params.sessionId}". It may have been deleted or expired.`,
            );
          }

          const artifact = await fetchReplayArtifact(
            entry.url,
            {
              sessionId: params.sessionId,
              website: entry.website ?? undefined,
              timestamp: entry.timestamp ?? undefined,
            },
            config.requestTimeout,
          );
          const view =
            uiEnabled && !isCompliant(config)
              ? replayViews.prepare(viewOwner, artifact)
              : undefined;
          if (uiEnabled && !isCompliant(config) && !view) {
            log.warn(
              'Inline replay unavailable; preserving the existing player fallback.',
            );
          }
          const html = buildReplayHtml(artifact);
          const bytes = Buffer.byteLength(html);
          const { htmlPath, jsonPath } = await writeReplayArtifacts(
            artifact,
            html,
          );
          // Only open a browser when the server runs on the caller's own machine;
          // on a hosted deployment that would open one on a worker.
          const openedInBrowser =
            config.transport === 'stdio' && !isCompliant(config) && !view
              ? replayBrowser.open(htmlPath)
              : false;
          log.debug(
            `Replay ${params.sessionId}: ${artifact.events.length} events → ${htmlPath}`,
          );
          return {
            replay: {
              artifact,
              view,
              html,
              htmlPath,
              jsonPath,
              openedInBrowser,
              // Remote clients get a download when the inline copy is too large.
              local: config.transport === 'stdio',
              bytes,
              inlined:
                !view &&
                bytes <=
                  (config.transport === 'stdio'
                    ? MAX_INLINE_BYTES_LOCAL
                    : MAX_INLINE_BYTES_REMOTE),
            },
          };
        }
        case 'integrations': {
          const data = await accountQuery<{
            listOnePasswordIntegrations: OpIntegration[] | null;
          }>(config, token, INTEGRATIONS_QUERY, {
            limit,
            offset: skip,
            includeVaults: true,
          });
          return { integrations: data.listOnePasswordIntegrations };
        }
      }
    },
    analyticsProps: (params, result) => ({
      action: params.action,
      row_count:
        result?.active?.sessions?.length ??
        result?.persistent?.sessions?.length ??
        result?.replays?.data?.length ??
        result?.integrations?.length ??
        0,
    }),
    format: async (result, params, { token, sessionId }) => {
      const replay = result?.replay;
      let downloads: string | undefined;
      if (replay && !replay.local && !replay.inlined) {
        // ponytail: handles are process-local; use shared storage before scaling
        // the hosted MCP deployment beyond one worker.
        const records = await Promise.all(
          [
            storeDownload(
              basename(replay.htmlPath),
              'text/html',
              Buffer.from(replay.html),
              downloadOwner(token),
              sessionId,
            ),
            storeDownload(
              basename(replay.jsonPath),
              'application/json',
              Buffer.from(JSON.stringify(replay.artifact, null, 2)),
              downloadOwner(token),
              sessionId,
            ),
          ].map((record) =>
            record.catch((error: unknown) => {
              if (!replay.view) throw error;
              return undefined;
            }),
          ),
        );
        downloads = records
          .flatMap((record) =>
            record
              ? [
                  describeReadyDownload(
                    record,
                    replay.view ? { ...config } : { ...config, token },
                  ),
                ]
              : [],
          )
          .concat(
            records.some((record) => !record)
              ? [
                  'One or more offline downloads are unavailable. The inline replay is still available.',
                ]
              : [],
          )
          .join('\n\n');
      }
      const blocks: Content[] = [
        {
          type: 'text' as const,
          text: replay?.view
            ? `${replay.view.summary} Call browserless_show with the returned viewRef to play it.

${
  replay.local
    ? `Offline player: ${replay.htmlPath}`
    : `Offline player download (single use, 15 minutes or MCP session end):
${downloads}`
}`
            : FORMATTERS[params.action](result ?? {}, downloads),
        },
      ];
      if (replay?.inlined) {
        blocks.push({
          type: 'resource' as const,
          resource: {
            uri: pathToFileURL(replay.htmlPath).href,
            mimeType: 'text/html',
            text: replay.html,
          },
        });
      }
      return isCompliant(config)
        ? blocks
        : {
            content: blocks,
            structuredContent: {
              action: params.action,
              ...(replay?.view ?? {
                summary: replay
                  ? 'Session replay downloaded.'
                  : FORMATTERS[params.action](result ?? {}),
              }),
            },
          };
    },
  });
}
