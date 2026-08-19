import { pathToFileURL } from 'node:url';

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
import { DEFAULT_REPLAY_CDN_URL } from '../config.js';
import type { McpConfig } from '../@types/types.js';

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
  // Only selected for the download path; the list never renders it.
  path?: string | null;
}

interface OpIntegration {
  id: string;
  label: string;
  kind: string;
  allowedDomains: string[];
  expiresAt: string | null;
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
        path
      }
      totalCount
      page
      totalPages
    }
  }
`;

const INTEGRATIONS_QUERY = `
  query OnePasswordIntegrations($apiToken: String, $limit: Int, $offset: Int) {
    listOnePasswordIntegrations(
      apiToken: $apiToken
      limit: $limit
      offset: $offset
    ) {
      id
      label
      kind
      allowedDomains
      expiresAt
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
      `- ${op.label} (${op.kind}) — domains: ${op.allowedDomains.join(', ') || 'none'}` +
      `${op.expiresAt ? `, expires ${op.expiresAt}` : ''}`,
  );
  return [
    `## 1Password integrations (${integrations.length})`,
    ``,
    ...rows,
  ].join('\n');
};

const formatReplay = (result: SessionsResult): string => {
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
    `- Player (events embedded; loads rrweb-player from CDN): ${htmlPath}`,
    `- Raw rrweb events: ${jsonPath}`,
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
            `response — render it inline as-is; do not rebuild it. The file path ` +
            `above is on the machine running this server, so it only helps the ` +
            `user if that is also their own machine.`,
        ]
      : [
          `The player is ${kb} KB — too large to attach inline, and the path above ` +
            `is on the machine running this server, not necessarily the user's. ` +
            `Tell them the replay is ready, give them the path, and say it must be ` +
            `opened on that host.`,
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
  (result: SessionsResult) => string
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
      'Action `replay` downloads one recording and returns a playable rrweb page ' +
      'with the events embedded (the player itself loads from a CDN on first ' +
      'open): render it inline if you can display HTML, otherwise ' +
      'build an artifact from the returned instructions so the user can watch it. ' +
      'Always show the replay — never just summarise it in words.',
    parameters: SessionsParamsSchema,
    annotations: {
      title: 'Browserless Sessions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    run: async ({ params, token, log }) => {
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
          // Search by id rather than paging the whole list to find one row.
          const data = await accountQuery<{
            sessionReplayList: SessionsResult['replays'];
          }>(config, token, REPLAYS_QUERY, {
            search: params.sessionId,
            pageSize: 50,
          });
          const entry = (data.sessionReplayList?.data ?? []).find(
            (row) => row.sessionId === params.sessionId,
          );
          if (!entry?.path) {
            throw new UserError(
              `No replay found for session "${params.sessionId}". It may have been deleted or expired.`,
            );
          }

          const artifact = await fetchReplayArtifact(
            config.replayCdnUrl ?? DEFAULT_REPLAY_CDN_URL,
            entry.path,
            {
              sessionId: params.sessionId,
              website: entry.website ?? undefined,
              timestamp: entry.timestamp ?? undefined,
            },
            config.requestTimeout,
          );
          const html = buildReplayHtml(artifact);
          const bytes = Buffer.byteLength(html);
          const { htmlPath, jsonPath } = await writeReplayArtifacts(
            artifact,
            html,
          );
          // Only open a browser when the server runs on the caller's own machine;
          // on a hosted deployment that would open one on a worker.
          const openedInBrowser =
            config.transport === 'stdio' && !isCompliant(config)
              ? replayBrowser.open(htmlPath)
              : false;
          log.debug(
            `Replay ${params.sessionId}: ${artifact.events.length} events → ${htmlPath}`,
          );
          return {
            replay: {
              artifact,
              html,
              htmlPath,
              jsonPath,
              openedInBrowser,
              // A local client can open the path, so inlining is pure context
              // cost; a remote one can only ever see the inline copy.
              local: config.transport === 'stdio',
              bytes,
              inlined:
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
          }>(config, token, INTEGRATIONS_QUERY, { limit, offset: skip });
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
    format: (result, params) => {
      const blocks: Content[] = [
        {
          type: 'text' as const,
          text: FORMATTERS[params.action](result ?? {}),
        },
      ];
      const replay = result?.replay;
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
      return blocks;
    },
  });
}
