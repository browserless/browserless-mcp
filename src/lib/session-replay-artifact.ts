import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { UserError } from 'fastmcp';

// The player is inlined rather than linked: MCP clients render this page inside
// a sandbox whose CSP forbids every external host, so a CDN <script> silently
// never loads there. Inlining also lets a downloaded replay play offline.
const requireFrom = createRequire(import.meta.url);

// Filled by replacing an empty tag rather than a {{…}} placeholder: prettier
// parses the contents of script and style blocks, and rewrites a placeholder
// sitting in statement position into a bare identifier, which silently yields a
// player-less page. A missing slot throws instead.
const PLAYER_CSS_SLOT = '<style id="rrweb-player-css"></style>';
const PLAYER_JS_SLOT = '<script id="rrweb-player"></script>';

const fillSlot = (html: string, slot: string, markup: string): string => {
  if (!html.includes(slot)) {
    throw new Error(`The replay template no longer contains ${slot}`);
  }
  return html.replace(slot, () => markup);
};
let cachedPlayerCss: string | undefined;
let cachedPlayerJs: string | undefined;

// A local client can just open the file, so inlining only burns context. A remote
// one cannot reach the path at all, making the inline copy the only way to show it.
export const MAX_INLINE_BYTES_LOCAL = 256 * 1024;
export const MAX_INLINE_BYTES_REMOTE = 4 * 1024 * 1024;

export interface ReplayArtifact {
  sessionId: string;
  website?: string;
  timestamp?: number;
  events: unknown[];
  [key: string]: unknown;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeForFilename = (value: string) =>
  value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

const hostFromUrl = (url?: string) => {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

const replayFilename = (
  replay: Pick<ReplayArtifact, 'sessionId' | 'website'>,
  extension: 'json' | 'html',
) =>
  [
    'session-replay',
    sanitizeForFilename(hostFromUrl(replay.website)),
    sanitizeForFilename(replay.sessionId),
  ]
    .filter(Boolean)
    .join('-') + `.${extension}`;

// The path is origin-checked against the configured base, so a server-supplied
// value cannot redirect the fetch somewhere else.
export const fetchReplayArtifact = async (
  cdnUrl: string,
  path: string,
  meta: { sessionId: string; website?: string; timestamp?: number },
  timeoutMs: number,
): Promise<ReplayArtifact> => {
  const base = new URL(cdnUrl.endsWith('/') ? cdnUrl : `${cdnUrl}/`);
  const requestUrl = new URL(path.replace(/^\/+/, ''), base);

  if (requestUrl.origin !== base.origin) {
    throw new UserError(
      'The replay path does not resolve to the configured replay CDN origin.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(requestUrl.toString(), {
      signal: controller.signal,
      // The origin check above only covers the first hop; following a redirect
      // would let the CDN move the download off the configured origin.
      redirect: 'manual',
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new UserError(
      'The replay CDN redirected the download. Refusing to follow it off the configured origin.',
    );
  }

  if (!response.ok) {
    throw new UserError(
      `Could not download the replay artifact (${response.status}). It may have expired.`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  return {
    ...data,
    events: Array.isArray(data.events) ? data.events : [],
    sessionId: meta.sessionId,
    website: (meta.website ?? data.website) as string | undefined,
    timestamp: (meta.timestamp ?? data.timestamp) as number | undefined,
  };
};

const escapeScriptClose = (value: string) =>
  value.replace(/<\/script/gi, '<\\/script');

// The player markup, styling and controls live in session-replay-player.html —
// a real HTML file rather than a template literal, so each language is editable.
const TEMPLATE_URL = new URL('./session-replay-player.html', import.meta.url);
let cachedTemplate: string | undefined;

/** Self-contained: the events and rrweb-player itself are both inlined. */
export const buildReplayHtml = (replay: ReplayArtifact): string => {
  cachedTemplate ??= readFileSync(TEMPLATE_URL, 'utf8');
  cachedPlayerCss ??= readFileSync(
    requireFrom.resolve('rrweb-player/dist/style.css'),
    'utf8',
  );
  cachedPlayerJs ??= readFileSync(
    join(
      dirname(requireFrom.resolve('rrweb-player')),
      'rrweb-player.umd.min.cjs',
    ),
    'utf8',
  );

  const host = hostFromUrl(replay.website);
  const values: Record<string, string> = {
    TITLE: escapeHtml(
      ['Session Replay', host, replay.sessionId].filter(Boolean).join(' — '),
    ),
    SESSION_ID: escapeHtml(replay.sessionId),
    HOST: escapeHtml(host || 'unknown host'),
    RECORDED_AT: String(replay.timestamp ? replay.timestamp * 1000 : 0),
    REPLAY_JSON: escapeScriptClose(JSON.stringify(replay)),
  };

  // A replacer function, not a string: `$` sequences in the events JSON would
  // otherwise be read as capture-group references.
  const html = cachedTemplate.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => values[key] ?? whole,
  );

  return fillSlot(
    fillSlot(html, PLAYER_CSS_SLOT, `<style>${cachedPlayerCss}</style>`),
    PLAYER_JS_SLOT,
    `<script>${escapeScriptClose(cachedPlayerJs)}</script>`,
  );
};

// Replay artifacts are raw page content, so only the most recent few are kept;
// older directories this process created are removed as new ones appear.
const RETAINED_ARTIFACT_DIRS = 3;
const artifactDirs: string[] = [];

/** Writes both artifacts next to each other and returns their paths. */
export const writeReplayArtifacts = async (
  replay: ReplayArtifact,
  html: string,
): Promise<{ htmlPath: string; jsonPath: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'browserless-replay-'));
  artifactDirs.push(dir);
  while (artifactDirs.length > RETAINED_ARTIFACT_DIRS) {
    rm(artifactDirs.shift()!, { recursive: true, force: true }).catch(() => {});
  }
  const htmlPath = join(dir, replayFilename(replay, 'html'));
  const jsonPath = join(dir, replayFilename(replay, 'json'));
  await Promise.all([
    writeFile(htmlPath, html, 'utf8'),
    writeFile(jsonPath, JSON.stringify(replay, null, 2), 'utf8'),
  ]);
  return { htmlPath, jsonPath };
};

// `start` is a cmd builtin rather than an executable, so Windows needs the shell.
const OPENERS: Record<string, [string, string[]]> = {
  darwin: ['open', []],
  linux: ['xdg-open', []],
  win32: ['cmd', ['/c', 'start', '']],
};

/** The shell command that opens a path in the default browser on this platform. */
export const openCommandFor = (filePath: string): string =>
  process.platform === 'win32'
    ? `cmd /c start "" "${filePath}"`
    : `${OPENERS[process.platform]?.[0] ?? 'open'} '${filePath.replace(/'/g, "'\\''")}'`;

// Only meaningful when the server runs on the caller's own machine — a hosted
// deployment would open the browser on a worker.
const openInBrowser = (filePath: string): boolean => {
  const opener = OPENERS[process.platform];
  if (!opener) return false;
  const [cmd, prefix] = opener;
  try {
    spawn(cmd, [...prefix, filePath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return true;
  } catch {
    return false;
  }
};

// A seam, so a test can assert the local path without spawning a real browser.
export const replayBrowser = { open: openInBrowser };
