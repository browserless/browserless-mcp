import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startProbe } from './server.mjs';
import { URI, INLINE_LIMIT, CHUNK_LIMIT } from './tools.mjs';

const chromePath = process.env.CHROME_PATH;
if (!chromePath)
  throw new Error(
    'Set CHROME_PATH to a Chromium executable before running this check.',
  );
const puppeteerModule = process.env.PUPPETEER_MODULE ?? 'puppeteer-core';

const reserve = createServer();
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
let clock = Date.now();
const probe = await startProbe({ port, now: () => clock, ttlMs: 1000 });
const evidence = new URL('./evidence/', import.meta.url);
await mkdir(evidence, { recursive: true });
const clients = [],
  checks = [],
  browserErrors = [];
const pass = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const connect = async (owner = 'local-alice', ui = true) => {
  const client = new Client(
    { name: 'Local widget checks', version: '0.1.0' },
    {
      capabilities: ui
        ? {
            extensions: {
              'io.modelcontextprotocol/ui': {
                mimeTypes: ['text/html;profile=mcp-app'],
              },
            },
          }
        : {},
    },
  );
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${owner}` } } },
  );
  await client.connect(transport);
  return { client, transport };
};
const call = (client, name, args = {}) =>
  client.callTool({ name, arguments: args });
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const hash = (value) => createHash('sha256').update(value).digest('hex');
let browser;
try {
  const a = await connect();
  const b = await connect('local-bob');
  const descriptors = (await a.client.listTools()).tools;
  assert(descriptors.every((tool) => tool.outputSchema));
  assert.deepEqual(
    descriptors
      .filter((tool) => tool._meta?.ui?.resourceUri)
      .map((tool) => tool.name),
    ['browserless_show'],
  );
  assert.deepEqual(
    descriptors.find((tool) => tool.name === 'browserless_view_data')._meta.ui
      .visibility,
    ['app'],
  );
  const resource = (await a.client.readResource({ uri: URI })).contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  pass(
    'only show has UI metadata; reader is app-only; output schemas and resource are discoverable',
  );

  const prepared = await call(a.client, 'widget_probe_replay');
  assert.notEqual(prepared.isError, true, JSON.stringify(prepared));
  const ref = prepared.structuredContent.viewRef;
  assert(!prepared._meta);
  const producerCount = probe.state.stats.replay;
  const shown = await call(a.client, 'browserless_show', { viewRef: ref });
  assert.equal(shown._meta.payload.events.length, 6);
  assert.equal(probe.state.stats.replay, producerCount);
  assert(
    !JSON.stringify({
      content: shown.content,
      structuredContent: shown.structuredContent,
    }).includes('Step 1: Opened page'),
  );
  pass(
    'two-call replay uses an opaque ref, hides events from model-visible fields, and does not rerun producer',
  );

  const foreign = await call(b.client, 'browserless_show', { viewRef: ref });
  const unknown = await call(a.client, 'browserless_show', {
    viewRef: 'unknown',
  });
  assert.equal(foreign.isError, true);
  assert.equal(unknown.isError, true);
  assert.deepEqual(foreign.content, unknown.content);
  const oldSession = a.transport.sessionId;
  await a.client.close();
  const reconnect = await connect();
  assert.notEqual(reconnect.transport.sessionId, oldSession);
  assert.equal(
    (await call(reconnect.client, 'browserless_show', { viewRef: ref }))._meta
      .payload.events.length,
    6,
  );
  pass(
    'foreign owner denied without disclosure; same owner resolves ref after a new transport session',
  );

  const plain = await connect('local-alice', false);
  const fallback = await call(plain.client, 'browserless_show', {
    viewRef: ref,
  });
  assert.equal(fallback.content[0].type, 'text');
  assert(fallback.content[0].text.length);
  pass('client without MCP Apps gets useful text from show');

  const large = await call(reconnect.client, 'widget_probe_replay', {
    large: true,
  });
  const largeRef = large.structuredContent.viewRef;
  const largeShow = await call(reconnect.client, 'browserless_show', {
    viewRef: largeRef,
  });
  assert(largeShow._meta.source);
  assert(bytes(largeShow) < INLINE_LIMIT);
  let cursor,
    encoded = '',
    pageCount = 0,
    firstCursor;
  do {
    const page = await call(reconnect.client, 'browserless_view_data', {
      viewRef: largeRef,
      ...(cursor ? { cursor } : {}),
    });
    assert(bytes(page) <= CHUNK_LIMIT);
    encoded += page._meta.data;
    cursor = page.structuredContent.nextCursor;
    firstCursor ??= cursor;
    pageCount++;
    assert(pageCount < 100);
  } while (cursor);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  assert.equal(
    hash(decoded),
    hash(JSON.stringify(probe.state.views.get(largeRef).payload)),
  );
  assert(decoded.includes('PRIVATE-REPLAY-🚀'));
  const deniedChunk = await call(b.client, 'browserless_view_data', {
    viewRef: largeRef,
  });
  assert.equal(deniedChunk.isError, true);
  const wrongCursor = await call(reconnect.client, 'browserless_view_data', {
    viewRef: ref,
    cursor: firstCursor,
  });
  assert.equal(wrongCursor.isError, true);
  pass(
    `large Unicode replay reconstructs exactly across ${pageCount} bounded chunks; foreign reads and cross-view cursors denied`,
  );
  const compressed = await call(reconnect.client, 'browserless_view_data', {
    viewRef: largeRef,
    encoding: 'gzip',
  });
  assert.equal(compressed._meta.encoding, 'base64-gzip-json');
  assert.equal(compressed.structuredContent.complete, true);
  assert(bytes(compressed) <= CHUNK_LIMIT);
  assert.equal(
    hash(gunzipSync(Buffer.from(compressed._meta.data, 'base64'))),
    hash(decoded),
  );
  assert.equal(
    (
      await call(reconnect.client, 'browserless_view_data', {
        viewRef: largeRef,
        encoding: 'gzip',
        cursor: firstCursor,
      })
    ).isError,
    true,
  );
  pass(
    'gzip reader preserves full decoded payload in one bounded reply and rejects a cursor from the identity encoding',
  );

  const zero = await call(reconnect.client, 'widget_probe_replay', {
    paddingBytes: 0,
  });
  const overhead = bytes(
    await call(reconnect.client, 'browserless_show', {
      viewRef: zero.structuredContent.viewRef,
    }),
  );
  for (const delta of [-1, 0, 1]) {
    const boundary = await call(reconnect.client, 'widget_probe_replay', {
      paddingBytes: INLINE_LIMIT - overhead + delta,
    });
    const result = await call(reconnect.client, 'browserless_show', {
      viewRef: boundary.structuredContent.viewRef,
    });
    if (delta <= 0) {
      assert(result._meta.payload);
      assert.equal(bytes(result), INLINE_LIMIT + delta);
    } else assert(result._meta.source);
  }
  pass(
    'complete serialized results at 2 MiB - 1 and exactly 2 MiB inline; 2 MiB + 1 uses chunk source',
  );

  const { default: puppeteer } = await import(puppeteerModule);
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox'],
    defaultViewport: { width: 1150, height: 850 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  const response = await page.goto(`http://127.0.0.1:${port}/probe`);
  assert.equal(response.status(), 200);
  await page.waitForFunction(() => window.ready === true);
  const waitKind = async (kind) => {
    await page.waitForFunction(
      (value) =>
        document
          .querySelector('#widget')
          ?.contentDocument?.querySelector('#view')?.dataset.kind === value,
      {},
      kind,
    );
    return (await page.$('#widget')).contentFrame();
  };
  const uiRef = await page.evaluate(
    async () =>
      (await window.probe.prepare('widget_probe_replay')).structuredContent
        .viewRef,
  );
  assert.equal(await page.$('#widget'), null);
  const countBeforeShow = probe.state.stats.replay;
  const widgetResponse = page.waitForResponse((response) =>
    response.url().endsWith('/probe/widget'),
  );
  await page.evaluate((viewRef) => window.probe.show(viewRef), uiRef);
  assert(
    (await widgetResponse)
      .headers()
      ['content-security-policy'].includes("frame-src 'none'"),
  );
  let frame = await (await page.$('#widget')).contentFrame();
  await frame.waitForSelector('.rr-controller');
  assert.equal(probe.state.stats.replay, countBeforeShow);
  const renderedText = () =>
    frame.evaluate(
      () =>
        document.querySelector('.replayer-wrapper iframe')?.contentDocument
          ?.body?.textContent ?? '',
    );
  assert((await renderedText()).includes('Step 1: Opened page'));
  await frame.click('.rr-controller__btns button');
  await frame.waitForFunction(
    () =>
      document
        .querySelector('.replayer-wrapper iframe')
        ?.contentDocument?.body?.textContent.includes('Step 2: Filled form'),
    { timeout: 6000 },
  );
  await frame.click('.rr-controller__btns button');
  const paused = await frame.$eval(
    '.rr-timeline__time',
    (element) => element.textContent,
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(
    await frame.$eval('.rr-timeline__time', (element) => element.textContent),
    paused,
  );
  const track = await (await frame.$('.rr-progress')).boundingBox();
  await page.mouse.click(
    track.x + track.width * 0.8,
    track.y + track.height / 2,
  );
  await frame.waitForFunction(() =>
    document
      .querySelector('.replayer-wrapper iframe')
      ?.contentDocument?.body?.textContent.includes('Step 4: Success'),
  );
  await page.screenshot({ path: new URL('replay.png', evidence).pathname });
  pass(
    'local official AppBridge mounts only on show; actual replay plays, pauses, and seeks under enforced CSP',
  );

  await page.click('button[data-tool="widget_probe_sessions"]');
  frame = await waitKind('active-sessions');
  await frame.waitForSelector('#refresh');
  const mounts = await page.evaluate(() => window.probe.mounts);
  const shows = probe.state.stats.show,
    sessions = probe.state.stats.sessions;
  const priorText = await frame.$eval('pre', (element) => element.textContent);
  await frame.click('#refresh');
  await frame.waitForFunction(
    (text) => document.querySelector('pre')?.textContent !== text,
    {},
    priorText,
  );
  assert.equal(probe.state.stats.sessions, sessions + 1);
  assert.equal(probe.state.stats.show, shows);
  assert.equal(await page.evaluate(() => window.probe.mounts), mounts);
  assert.equal(await (await page.$('#widget')).contentFrame(), frame);
  await page.screenshot({ path: new URL('sessions.png', evidence).pathname });
  pass(
    'sessions refresh calls actual MCP producer via bridge, changes snapshot, and never calls show or remounts',
  );

  await page.click('button[data-tool="widget_probe_usage"]');
  frame = await waitKind('usage');
  await frame.waitForSelector('#timeframe');
  const usageMounts = await page.evaluate(() => window.probe.mounts),
    usageShows = probe.state.stats.show;
  await frame.select('#timeframe', 'week');
  await frame.waitForFunction(() =>
    document
      .querySelector('#view p')
      ?.textContent.includes('1680 / 2000 units (week)'),
  );
  assert.equal(await page.evaluate(() => window.probe.mounts), usageMounts);
  assert.equal(probe.state.stats.show, usageShows);
  await page.screenshot({ path: new URL('usage.png', evidence).pathname });
  pass(
    'usage timeframe switch updates in mounted widget through MCP without calling show',
  );

  await page.click('button[data-tool="widget_probe_performance"]');
  frame = await waitKind('performance');
  await frame.waitForFunction(() =>
    document
      .querySelector('#view')
      ?.textContent.includes('accessibility: Unavailable'),
  );
  await page.screenshot({
    path: new URL('performance.png', evidence).pathname,
  });
  pass('same resource dispatches scorecard; null score remains unavailable');

  const chunksBefore = probe.state.stats.chunks;
  const producerBeforeChunked = probe.state.stats.replay;
  const showBeforeChunked = probe.state.stats.show;
  await page.evaluate(() => {
    window.probe.chunkAttempts = 0;
    window.probe.chunkFailures = 0;
    window.probe.failChunkAt = 7;
    window.probe.forceIdentityChunks = true;
  });
  await page.click('button[data-large]');
  await page.waitForFunction(() => window.probe.chunkFailures === 1);
  console.log(
    'Injected one real bridge UNAVAILABLE response during chunk loading.',
  );
  frame = await waitKind('replay');
  await frame.waitForSelector('.rr-controller', { timeout: 15000 });
  assert.equal(probe.state.stats.chunks - chunksBefore, 47);
  assert.equal(probe.state.stats.replay, producerBeforeChunked + 1);
  assert.equal(probe.state.stats.show, showBeforeChunked + 1);
  assert.equal(await page.evaluate(() => window.probe.chunkFailures), 1);
  assert.equal(await page.evaluate(() => window.probe.chunkAttempts), 48);
  assert((await renderedText()).includes('Step 1: Opened page'));
  pass(
    'browser recovers from one transient bridge failure, retains prior chunks, and renders replay after 48 attempts for 47 pages',
  );
  const compressedChunksBefore = probe.state.stats.chunks;
  const compressedMountsBefore = await page.evaluate(() => {
    window.probe.chunkAttempts = 0;
    window.probe.chunkFailures = 0;
    window.probe.failChunkAt = 0;
    window.probe.forceIdentityChunks = false;
    return window.probe.mounts;
  });
  await page.click('button[data-large]');
  await page.waitForFunction(
    (mounts) => window.probe.mounts > mounts,
    {},
    compressedMountsBefore,
  );
  frame = await waitKind('replay');
  await frame.waitForSelector('.rr-controller');
  assert.equal(probe.state.stats.chunks - compressedChunksBefore, 1);
  assert.equal(await page.evaluate(() => window.probe.chunkAttempts), 1);
  assert((await renderedText()).includes('Step 1: Opened page'));
  await page.screenshot({
    path: new URL('compressed-replay.png', evidence).pathname,
  });
  pass(
    'browser decompresses the original large replay and renders it with one bridge data call under enforced CSP',
  );
  assert.deepEqual(browserErrors, []);

  const expiring = await call(reconnect.client, 'widget_probe_sessions');
  const expires = expiring.structuredContent.expiresAt;
  clock += 999;
  assert.equal(
    (
      await call(reconnect.client, 'browserless_show', {
        viewRef: expiring.structuredContent.viewRef,
      })
    ).isError,
    undefined,
  );
  assert.equal(
    probe.state.views.get(expiring.structuredContent.viewRef).expires,
    Date.parse(expires),
  );
  clock++;
  const expired = await call(reconnect.client, 'browserless_show', {
    viewRef: expiring.structuredContent.viewRef,
  });
  assert.equal(expired.isError, true);
  assert.deepEqual(expired.content, unknown.content);
  pass(
    'reads do not extend TTL; exact expiry denies access with same non-disclosing error',
  );
  await writeFile(
    new URL('results.json', evidence),
    JSON.stringify(
      {
        status: 'PASS',
        checks,
        stats: probe.state.stats,
        browserErrors,
        limitations: [
          'Synthetic producers and identities, not production account/OAuth integration',
          'Local AppBridge CSP only, not ChatGPT or Claude enforced CSP',
          'Process-local storage; no replica, durable restart, video preview, or 15-minute real-time soak claim',
        ],
      },
      null,
      2,
    ),
  );
  console.log(`${checks.length} checks passed; evidence: ${evidence.pathname}`);
} catch (error) {
  await writeFile(
    new URL('results.json', evidence),
    JSON.stringify(
      { status: 'FAIL', checks, browserErrors, error: error.stack },
      null,
      2,
    ),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await Promise.allSettled(clients.map((client) => client.close()));
  await probe.stop();
}
process.exit(process.exitCode ?? 0);
