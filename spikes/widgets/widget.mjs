import { App } from '@modelcontextprotocol/ext-apps';
import Player from 'rrweb-player';
import 'rrweb-player/dist/style.css';

const app = new App({ name: 'Local shared widget probe', version: '0.1.2' });
const status = document.querySelector('#status');
const target = document.querySelector('#view');
let player;
let generation = 0;
function clear() {
  player?.$destroy();
  player = undefined;
  target.replaceChildren();
}
function error(reason) {
  clear();
  status.textContent = reason.message;
}
function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
async function readChunk(args, current) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (current !== generation) return;
    try {
      return await app.callServerTool({
        name: 'browserless_view_data',
        arguments: args,
      });
    } catch (reason) {
      if (
        attempt === 3 ||
        !/unavailable|connection failed|network|timed?\s*out|timeout/i.test(
          reason.message ?? '',
        )
      )
        throw reason;
      status.textContent = 'Connection interrupted. Retrying…';
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
async function decompress(data, expectedBytes) {
  const reader = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedBytes || total > 50 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('View exceeds its decoded size limit.');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
async function render(result) {
  const current = ++generation;
  clear();
  if (result.isError)
    throw new Error(
      result.content?.find((block) => block.type === 'text')?.text ??
        'View unavailable.',
    );
  status.textContent = 'Loading…';
  let payload = result._meta?.payload ?? result.structuredContent?.data;
  if (result._meta?.source) {
    const { viewRef, bytes } = result._meta.source;
    if (bytes > 50 * 1024 * 1024) throw new Error('View too large.');
    let encoded = '',
      cursor,
      encoding;
    const seen = new Set();
    do {
      const page = await readChunk(
        {
          viewRef,
          encoding:
            typeof DecompressionStream === 'function' ? 'gzip' : 'identity',
          ...(cursor ? { cursor } : {}),
        },
        current,
      );
      if (current !== generation) return;
      if (page.isError) throw new Error('View unavailable.');
      const codec = page._meta.encoding ?? 'base64-json';
      if (encoding && codec !== encoding)
        throw new Error('Inconsistent view encoding.');
      encoding = codec;
      encoded += page._meta.data;
      status.textContent = `Loading replay… ${Math.min(100, Math.floor((encoded.length / (page._meta.totalChars ?? Math.ceil(bytes / 3) * 4)) * 100))}%`;
      if (encoded.length > Math.ceil((50 * 1024 * 1024) / 3) * 4)
        throw new Error('View too large.');
      cursor = page.structuredContent.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Repeated cursor.');
      seen.add(cursor);
    } while (cursor);
    let data = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    if (encoding === 'base64-gzip-json') data = await decompress(data, bytes);
    else if (encoding !== 'base64-json')
      throw new Error('Unsupported view encoding.');
    if (data.byteLength !== bytes) throw new Error('Incomplete view data.');
    payload = JSON.parse(new TextDecoder().decode(data));
  }
  if (current !== generation) return;
  const kind = result.structuredContent.kind;
  status.textContent = result.structuredContent.summary;
  target.dataset.kind = kind;
  if (kind === 'replay') {
    player = new Player({
      target,
      props: {
        events: payload.events,
        width: Math.max(240, Math.min(innerWidth - 32, 1000)),
        height: 400,
        autoPlay: false,
      },
    });
  } else if (kind === 'active-sessions') {
    const refresh = element('button', 'Refresh');
    refresh.id = 'refresh';
    refresh.onclick = async () => {
      try {
        await render(
          await app.callServerTool({
            name: 'widget_probe_sessions',
            arguments: {},
          }),
        );
      } catch (reason) {
        error(reason);
      }
    };
    target.append(refresh, element('pre', JSON.stringify(payload, null, 2)));
  } else if (kind === 'usage') {
    const select = document.createElement('select');
    select.id = 'timeframe';
    select.setAttribute('aria-label', 'Usage timeframe');
    for (const value of ['hour', 'day', 'week']) {
      const option = element('option', value);
      option.value = value;
      select.append(option);
    }
    select.value = payload.timeframe;
    select.onchange = async () => {
      try {
        await render(
          await app.callServerTool({
            name: 'widget_probe_usage',
            arguments: { timeframe: select.value },
          }),
        );
      } catch (reason) {
        error(reason);
      }
    };
    target.append(
      select,
      element(
        'p',
        `${payload.used} / ${payload.included} units (${payload.timeframe})`,
      ),
    );
  } else if (kind === 'performance') {
    for (const [name, score] of Object.entries(payload.scores))
      target.append(
        element(
          'p',
          `${name}: ${score === null ? 'Unavailable' : score + '/100'}`,
        ),
      );
  } else throw new Error('Unsupported view kind.');
}
app.ontoolresult = (result) => {
  void render(result).catch(error);
};
app.onteardown = async () => {
  generation++;
  clear();
  return {};
};
app.connect().catch(error);
