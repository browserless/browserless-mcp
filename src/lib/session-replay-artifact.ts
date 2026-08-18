import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UserError } from 'fastmcp';

// Ported from browserless-account's src/lib/session-replay-download.ts so the
// artifact is byte-comparable with what the dashboard hands users.
const RRWEB_PLAYER_VERSION = '1.0.0-alpha.4';
const RRWEB_PLAYER_CSS = `https://cdn.jsdelivr.net/npm/rrweb-player@${RRWEB_PLAYER_VERSION}/dist/style.css`;
const RRWEB_PLAYER_JS = `https://cdn.jsdelivr.net/npm/rrweb-player@${RRWEB_PLAYER_VERSION}/dist/index.js`;
// Recompute on a version bump:
//   curl -fsSL <url> | openssl dgst -sha384 -binary | openssl base64 -A
const RRWEB_PLAYER_CSS_SRI =
  'sha384-KkV3xosCYjwvyxFBgSDymv2R75UVsSEajt5pp/ANxMkGCES+Gx+0thrpA8yjOKcP';
const RRWEB_PLAYER_JS_SRI =
  'sha384-8wpRIGXF6jLCcei4LQ/8mu1JVvFjyIJIPUNShjd7Z0xt3k421PeGOmVJSouiUMt0';

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

/** Self-contained player: events are inlined, only rrweb-player is remote. */
export const buildReplayHtml = (replay: ReplayArtifact): string => {
  cachedTemplate ??= readFileSync(TEMPLATE_URL, 'utf8');

  const host = hostFromUrl(replay.website);
  const values: Record<string, string> = {
    TITLE: escapeHtml(
      ['Session Replay', host, replay.sessionId].filter(Boolean).join(' — '),
    ),
    SESSION_ID: escapeHtml(replay.sessionId),
    HOST: escapeHtml(host || 'unknown host'),
    RECORDED_AT: String(replay.timestamp ? replay.timestamp * 1000 : 0),
    PLAYER_CSS: RRWEB_PLAYER_CSS,
    PLAYER_CSS_SRI: RRWEB_PLAYER_CSS_SRI,
    PLAYER_JS: RRWEB_PLAYER_JS,
    PLAYER_JS_SRI: RRWEB_PLAYER_JS_SRI,
    REPLAY_JSON: escapeScriptClose(JSON.stringify(replay)),
  };

  // A replacer function, not a string: `$` sequences in the events JSON would
  // otherwise be read as capture-group references.
  return cachedTemplate.replace(
    /\{\{(\w+)\}\}/g,
    (whole, key: string) => values[key] ?? whole,
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
