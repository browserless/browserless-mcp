import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import Player from 'rrweb-player';
import 'rrweb-player/dist/style.css';
import './view.css';
import { mountHandoff } from './handoff.mjs';
import { mountAgentMedia } from './agent-media.mjs';
import { mountPerformance } from './performance.mjs';
import {
  ReplayPayloadSchema,
  ShowOutputSchema,
  ViewSourceSchema,
  VIEW_CHUNK_MAX_BYTES,
  VIEW_DATA_MAX_BYTES,
} from '../lib/view-schemas.js';

const app = new App({ name: 'Browserless views', version: '1.1.0' });
const byId = (id) => document.getElementById(id);
const card = document.querySelector('.replay-card');
const controls = document.querySelector('.controls');
const stage = byId('stage');
let player,
  currentTime = 0,
  duration = 0,
  playing = false,
  generation = 0,
  expiryTimer,
  lastResult;
let loading = new AbortController();
const textBytes = new TextEncoder();
let hostContext = {};
let handoff;
const handoffRoot = byId('handoff');
let media;
const mediaRoot = byId('agent-media');
let performanceReport;
const performanceRoot = byId('performance');
const isPerformanceView = () =>
  document.body.dataset.viewKind === 'performance' ||
  lastResult?.structuredContent?.kind === 'performance';
function updateHost(context) {
  hostContext = { ...hostContext, ...context };
  if (context.theme) applyDocumentTheme(context.theme);
  handoff?.updateHost(context);
  media?.updateHost(context);
  card.classList.toggle('expanded', hostContext.displayMode === 'fullscreen');
  byId('fullscreen').hidden =
    !hostContext.availableDisplayModes?.includes('fullscreen') &&
    !document.fullscreenEnabled;
  byId('fullscreen').setAttribute(
    'aria-label',
    hostContext.displayMode === 'fullscreen' || document.fullscreenElement
      ? 'Exit fullscreen'
      : 'Enter fullscreen',
  );
}

const clock = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
function enable(value) {
  for (const node of controls.querySelectorAll('button, input, select'))
    node.disabled = !value;
}
function setPlaying(value) {
  playing = value;
  byId('play').toggleAttribute('data-playing', value);
  byId('play').setAttribute(
    'aria-label',
    value ? 'Pause recording' : 'Play recording',
  );
  byId('state').textContent = value ? 'Playing' : 'Paused';
}
function updateTime(ms) {
  currentTime = Math.max(0, Math.min(duration, ms));
  byId('elapsed').textContent = clock(currentTime);
  byId('seek').value = String(currentTime);
  byId('seek').style.setProperty(
    '--progress',
    `${duration ? (currentTime / duration) * 100 : 0}%`,
  );
  byId('seek').setAttribute(
    'aria-valuetext',
    `${clock(currentTime)} of ${clock(duration)}`,
  );
}
function dispose() {
  clearTimeout(expiryTimer);
  player?.getReplayer().destroy();
  player?.$destroy();
  player = undefined;
  byId('player').replaceChildren();
  enable(false);
  handoff?.dispose();
  handoff = undefined;
  media?.dispose();
  media = undefined;
  performanceReport?.dispose();
  performanceReport = undefined;
}
function fail(error) {
  loading.abort();
  if (isPerformanceView()) {
    dispose();
    card.hidden = true;
    handoffRoot.hidden = true;
    mediaRoot.hidden = true;
    performanceRoot.hidden = false;
    performanceRoot.innerHTML =
      '<header class="perf-heading"><div><h1>Performance report unavailable</h1></div></header><p role="alert"></p><p class="perf-empty">Run a new audit to try again.</p>';
    performanceRoot.querySelector('[role="alert"]').textContent =
      error.message || 'The performance audit could not be completed.';
    return;
  }
  if (handoff) {
    clearTimeout(expiryTimer);
    handoff.fail(error);
    return;
  }
  if (media) {
    clearTimeout(expiryTimer);
    media.fail(error);
    return;
  }
  dispose();
  card.hidden = false;
  handoffRoot.hidden = true;
  mediaRoot.hidden = true;
  performanceRoot.hidden = true;
  byId('empty').hidden = false;
  byId('empty').dataset.error = '';
  byId('state').textContent = 'Unavailable';
  byId('message').textContent =
    error.message || 'Unable to load this recording.';
  byId('fallback').hidden = false;
  byId('retry').hidden = !lastResult || !transient(error);
}
function progress(message) {
  byId('message').textContent = message;
}
async function delay(ms, signal) {
  signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function transient(error) {
  return /unavailable.*connection|connection failed|network|timed?\s*out|timeout/i.test(
    error.message,
  );
}
async function readPage(args, signal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const result = await app.callServerTool(
        { name: 'browserless_view_data', arguments: args },
        { signal },
      );
      signal.throwIfAborted();
      if (result.isError)
        throw new Error(
          result.content?.find((item) => item.type === 'text')?.text ||
            'This replay is unavailable. Prepare a new replay.',
        );
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt >= 3 || !transient(error)) throw error;
      progress('Connection interrupted. Retrying…');
      await delay(1000 * 2 ** attempt, signal);
    }
  }
}
async function loadData(rawSource, viewRef, signal) {
  const source = ViewSourceSchema.parse(rawSource);
  if (source.viewRef !== viewRef)
    throw new Error('Mismatched replay reference.');
  let encoded = '',
    cursor,
    codec,
    totalChars;
  const seen = new Set();
  const encoding =
    typeof DecompressionStream === 'function' ? 'gzip' : 'identity';
  // Gzip can be slightly larger than poorly compressible decoded JSON.
  const wireLimit =
    Math.ceil((VIEW_DATA_MAX_BYTES + VIEW_CHUNK_MAX_BYTES) / 3) * 4;
  do {
    const page = await readPage(
      { viewRef, encoding, ...(cursor ? { cursor } : {}) },
      signal,
    );
    if (
      textBytes.encode(JSON.stringify(page)).byteLength > VIEW_CHUNK_MAX_BYTES
    )
      throw new Error('Replay response exceeds its size limit.');
    const meta = page._meta;
    if (
      !meta ||
      typeof meta.data !== 'string' ||
      !['base64-json', 'base64-gzip-json'].includes(meta.encoding)
    )
      throw new Error('Invalid replay data.');
    if (codec && codec !== meta.encoding)
      throw new Error('Inconsistent replay encoding.');
    if (
      !Number.isSafeInteger(meta.totalChars) ||
      meta.totalChars < 0 ||
      meta.totalChars > wireLimit ||
      (totalChars !== undefined && totalChars !== meta.totalChars)
    )
      throw new Error('Invalid replay size.');
    codec = meta.encoding;
    totalChars = meta.totalChars;
    encoded += meta.data;
    if (encoded.length > totalChars || encoded.length > wireLimit)
      throw new Error('Replay exceeds its size limit.');
    progress(
      `Loading replay… ${Math.floor((encoded.length / Math.max(1, totalChars)) * 100)}%`,
    );
    cursor = page.structuredContent?.nextCursor;
    if (
      typeof page.structuredContent?.complete !== 'boolean' ||
      page.structuredContent.complete !== !cursor ||
      (cursor && (typeof cursor !== 'string' || seen.has(cursor)))
    )
      throw new Error('Invalid replay cursor.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (encoded.length !== totalChars) throw new Error('Incomplete replay data.');
  const compressed = Uint8Array.from(atob(encoded), (char) =>
    char.charCodeAt(0),
  );
  let data = compressed;
  if (codec === 'base64-gzip-json') {
    const reader = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'))
      .getReader();
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const parts = [];
      let size = 0;
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > source.bytes || size > VIEW_DATA_MAX_BYTES) {
          await reader.cancel();
          throw new Error('Replay exceeds its decoded size limit.');
        }
        parts.push(value);
      }
      data = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        data.set(part, offset);
        offset += part.byteLength;
      }
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  }
  signal.throwIfAborted();
  if (data.byteLength !== source.bytes)
    throw new Error('Incomplete replay data.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}
async function render(result) {
  const current = ++generation;
  loading.abort();
  loading = new AbortController();
  const signal = loading.signal;
  dispose();
  card.hidden = false;
  handoffRoot.hidden = true;
  mediaRoot.hidden = true;
  performanceRoot.hidden = true;
  byId('empty').hidden = false;
  delete byId('empty').dataset.error;
  byId('retry').hidden = true;
  byId('fallback').hidden = true;
  progress('Loading your recording…');
  byId('state').textContent = 'Loading';
  try {
    if (result.isError)
      throw new Error(
        result.content?.find((item) => item.type === 'text')?.text ||
          (isPerformanceView()
            ? 'Performance audit failed.'
            : 'Replay unavailable.'),
      );
    if (isPerformanceView()) {
      performanceReport = mountPerformance(
        performanceRoot,
        result.structuredContent,
      );
      card.hidden = true;
      performanceRoot.hidden = false;
      return;
    }
    const view = ShowOutputSchema.parse(result.structuredContent);
    const expires = Date.parse(view.expiresAt);
    if (view.kind === 'handoff') {
      handoff = mountHandoff(
        handoffRoot,
        result._meta?.payload,
        view,
        app,
        hostContext,
      );
      card.hidden = true;
      handoffRoot.hidden = false;
    }
    if (expires <= Date.now())
      throw new Error('This view has expired. Prepare a new replay.');
    expiryTimer = setTimeout(
      () => fail(new Error('This view has expired. Prepare a new replay.')),
      expires - Date.now(),
    );
    if (handoff) return;
    if (view.kind === 'agent-media') {
      media = mountAgentMedia(
        mediaRoot,
        result._meta?.payload,
        view,
        app,
        hostContext,
      );
      card.hidden = true;
      mediaRoot.hidden = false;
      return;
    }
    byId('website').textContent =
      view.data.website || 'Recorded browser session';
    const payload = ReplayPayloadSchema.parse(
      result._meta?.source
        ? await loadData(result._meta.source, view.viewRef, signal)
        : result._meta?.payload,
    );
    if (current !== generation || signal.aborted) return;
    if (!payload.events.some((event) => event.type === 2))
      throw new Error(
        'This recording has no page snapshot to play. Use the offline player.',
      );
    player = new Player({
      target: byId('player'),
      props: {
        events: payload.events,
        width: stage.clientWidth,
        height: stage.clientHeight,
        autoPlay: false,
        showController: false,
        skipInactive: false,
        speed: 1,
      },
    });
    duration = player.getMetaData().totalTime;
    byId('seek').max = String(Math.max(1, duration));
    byId('duration').textContent = clock(duration);
    byId('speed').value = '1';
    byId('skip').checked = false;
    player.addEventListener('ui-update-current-time', ({ payload }) =>
      updateTime(payload),
    );
    player.addEventListener('ui-update-player-state', ({ payload }) =>
      setPlaying(payload === 'playing'),
    );
    player.getReplayer().on('finish', () => setPlaying(false));
    updateTime(0);
    setPlaying(false);
    enable(true);
    byId('empty').hidden = true;
    updateHost({});
  } catch (error) {
    if (current === generation && !signal.aborted) fail(error);
  }
}
byId('play').onclick = () => {
  if (playing) player?.pause();
  else player?.play();
};
byId('seek').oninput = () => {
  player?.goto(Number(byId('seek').value), playing);
  updateTime(Number(byId('seek').value));
};
byId('rewind').onclick = () => {
  player?.goto(Math.max(0, currentTime - 5000), playing);
};
byId('speed').onchange = () => player?.setSpeed(Number(byId('speed').value));
byId('skip').onchange = () => player?.toggleSkipInactive();
byId('fullscreen').onclick = async () => {
  try {
    if (hostContext.availableDisplayModes?.includes('fullscreen')) {
      const result = await app.requestDisplayMode({
        mode:
          hostContext.displayMode === 'fullscreen' ? 'inline' : 'fullscreen',
      });
      updateHost({ displayMode: result.mode });
    } else if (document.fullscreenElement) await document.exitFullscreen();
    else await card.requestFullscreen();
  } catch {
    byId('fullscreen').hidden = true;
  }
};
const resize = new ResizeObserver(() => {
  player?.$set({ width: stage.clientWidth, height: stage.clientHeight });
  queueMicrotask(() => player?.triggerResize());
});
resize.observe(stage);
byId('retry').onclick = () => {
  if (lastResult) void render(lastResult);
};
app.ontoolresult = (result) => {
  lastResult = result;
  void render(result);
};
app.ontoolcancelled = (params) => {
  generation++;
  fail(
    new Error(
      isPerformanceView()
        ? params?.reason || 'Performance audit was cancelled.'
        : 'Replay loading was cancelled.',
    ),
  );
};
app.onhostcontextchanged = updateHost;
app.onteardown = async () => {
  generation++;
  loading.abort();
  dispose();
  lastResult = undefined;
  resize.disconnect();
  return {};
};
app
  .connect()
  .then(() => {
    updateHost(app.getHostContext() ?? {});
  })
  .catch(fail);
