import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UserError } from 'fastmcp';

// Ported from browserless-account's src/lib/session-replay-download.ts so the
// artifact is byte-comparable with what the dashboard hands users.
const RRWEB_PLAYER_VERSION = '1.0.0-alpha.4';
export const RRWEB_PLAYER_CSS = `https://cdn.jsdelivr.net/npm/rrweb-player@${RRWEB_PLAYER_VERSION}/dist/style.css`;
export const RRWEB_PLAYER_JS = `https://cdn.jsdelivr.net/npm/rrweb-player@${RRWEB_PLAYER_VERSION}/dist/index.js`;
// Recompute on a version bump:
//   curl -fsSL <url> | openssl dgst -sha384 -binary | openssl base64 -A
export const RRWEB_PLAYER_CSS_SRI =
  'sha384-KkV3xosCYjwvyxFBgSDymv2R75UVsSEajt5pp/ANxMkGCES+Gx+0thrpA8yjOKcP';
export const RRWEB_PLAYER_JS_SRI =
  'sha384-8wpRIGXF6jLCcei4LQ/8mu1JVvFjyIJIPUNShjd7Z0xt3k421PeGOmVJSouiUMt0';

/** A replay is a DOM-event log, so it can be tens of MB — never inline blindly. */
export const MAX_INLINE_ARTIFACT_BYTES = 2 * 1024 * 1024;

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
    });
  } finally {
    clearTimeout(timer);
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

/** Self-contained rrweb player: the events are inlined, only the CDN player is remote. */
export const buildReplayHtml = (replay: ReplayArtifact): string => {
  const host = hostFromUrl(replay.website);
  const recordedAt = replay.timestamp
    ? new Date(replay.timestamp * 1000).toISOString()
    : '';
  const title = ['Session Replay', host, replay.sessionId]
    .filter(Boolean)
    .join(' — ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${RRWEB_PLAYER_CSS}" integrity="${RRWEB_PLAYER_CSS_SRI}" crossorigin="anonymous" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0b0b0f; color: #e7e7ea; min-height: 100vh; display: flex; flex-direction: column; }
  header { padding: 16px 24px; border-bottom: 1px solid rgba(255,255,255,.08);
           display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header .meta { font-size: 13px; color: #9aa0a6; }
  main { flex: 1; display: flex; justify-content: center; align-items: flex-start; padding: 24px; overflow: auto; }
  #player { max-width: 100%; }
  .notice { padding: 24px; text-align: center; color: #f87171; font-size: 14px; }
</style>
</head>
<body>
  <header>
    <h1>Session Replay</h1>
    <span class="meta">${escapeHtml(host || 'unknown host')}</span>
    <span class="meta">${escapeHtml(replay.sessionId)}</span>
    ${recordedAt ? `<span class="meta">${escapeHtml(recordedAt)}</span>` : ''}
  </header>
  <main>
    <div id="player"></div>
    <div id="fallback" class="notice" hidden>
      Unable to load the player. Be online the first time you open this file so
      rrweb-player can be fetched from the CDN.
    </div>
  </main>
  <script id="replay-data" type="application/json">${escapeScriptClose(JSON.stringify(replay))}</script>
  <script src="${RRWEB_PLAYER_JS}" integrity="${RRWEB_PLAYER_JS_SRI}" crossorigin="anonymous"></script>
  <script>
    (function () {
      const fallback = document.getElementById("fallback");
      try {
        const data = JSON.parse(document.getElementById("replay-data").textContent);
        const events = Array.isArray(data.events) ? data.events : [];
        const PlayerCtor = typeof rrwebPlayer !== "undefined" ? rrwebPlayer : window.rrwebPlayer;
        if (!PlayerCtor || events.length < 2) { fallback.hidden = false; return; }
        new PlayerCtor({
          target: document.getElementById("player"),
          props: {
            events: events,
            autoPlay: false,
            showController: true,
            width: Math.min(window.innerWidth - 48, 1280),
            height: Math.min(window.innerHeight - 160, 720),
          },
        });
      } catch (err) {
        console.error("Failed to initialize rrweb-player:", err);
        fallback.hidden = false;
      }
    })();
  </script>
</body>
</html>
`;
};

/** Writes both artifacts next to each other and returns their paths. */
export const writeReplayArtifacts = async (
  replay: ReplayArtifact,
  html: string,
): Promise<{ htmlPath: string; jsonPath: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'browserless-replay-'));
  const htmlPath = join(dir, replayFilename(replay, 'html'));
  const jsonPath = join(dir, replayFilename(replay, 'json'));
  await Promise.all([
    writeFile(htmlPath, html, 'utf8'),
    writeFile(jsonPath, JSON.stringify(replay, null, 2), 'utf8'),
  ]);
  return { htmlPath, jsonPath };
};

const OPENERS: Record<string, string> = {
  darwin: 'open',
  linux: 'xdg-open',
  win32: 'start',
};

// Only meaningful when the server runs on the caller's own machine — a hosted
// deployment would open the browser on a worker.
export const openInBrowser = (filePath: string): boolean => {
  const opener = OPENERS[process.platform];
  if (!opener) return false;
  try {
    spawn(opener, [filePath], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
};
