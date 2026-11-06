import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { summarizePerformance } from '../../src/lib/performance-summary.js';

const chrome =
  process.env.CHROME_PATH ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((path) => existsSync(path));
const fixture = (name: string) =>
  JSON.parse(readFileSync(`test/fixtures/${name}.json`, 'utf8'));

const scenarios = {
  formatting: `
    const { applyHostContext, formatTimestamp, formatNumber, formatDuration } = helpers;
    const unit = (value, name, locale) => new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);
    equal(formatTimestamp(null, {}), null, 'null timestamp');
    equal(formatTimestamp('garbage', {}), null, 'invalid timestamp');
    const fallback = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(start));
    equal(formatTimestamp(start, {}), fallback, 'browser date');
    equal(formatTimestamp(start, { locale: 'not_a_locale', timeZone: 'Mars/Base' }), fallback, 'invalid format');
    equal(formatTimestamp(start, { locale: 'de-DE', timeZone: 'Asia/Tokyo' }), new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Tokyo' }).format(new Date(start)), 'German Tokyo date');
    equal(formatNumber(12345.5, { locale: 'de-DE' }, ' ms'), new Intl.NumberFormat('de-DE').format(12345.5) + ' ms', 'number suffix');
    equal(formatNumber(null, {}), 'Unavailable', 'null number');
    equal(formatDuration(42, { locale: 'en-US' }), unit(42, 'second', 'en-US'), 'seconds');
    equal(formatDuration(303, { locale: 'en-US' }), unit(5, 'minute', 'en-US') + ' ' + unit(3, 'second', 'en-US'), 'minutes');
    equal(formatDuration(303, { locale: 'de-DE' }), unit(5, 'minute', 'de-DE') + ' ' + unit(3, 'second', 'de-DE'), 'German duration');
    const original = window.matchMedia;
    try {
      for (const [caps, platform, matches, expected] of [
        [{ touch: true, hover: true }, 'desktop', false, 'touch'],
        [{ touch: false, hover: false }, 'desktop', false, 'touch'],
        [{ touch: false }, 'mobile', true, 'pointer'],
        [{ hover: true }, 'mobile', true, 'pointer'],
        [{}, 'mobile', false, 'touch'],
        [{}, 'web', true, 'touch'],
        [{}, 'web', false, 'pointer'],
      ]) {
        window.matchMedia = () => ({ matches });
        const root = document.createElement('div');
        applyHostContext({ deviceCapabilities: caps, platform }, root);
        equal(root.dataset.input, expected, 'input precedence ' + JSON.stringify(caps));
      }
    } finally { window.matchMedia = original; }
    const root = document.createElement('div');
    applyHostContext({ safeAreaInsets: { top: 12, right: -1, bottom: Infinity, left: NaN }, containerDimensions: { height: 123, maxHeight: 200 } }, root);
    equal(root.style.getPropertyValue('--safe-top'), '12px', 'valid inset');
    equal(root.style.getPropertyValue('--safe-right'), '', 'negative inset');
    equal(root.style.getPropertyValue('--safe-bottom'), '', 'infinite inset');
    equal(root.style.getPropertyValue('--safe-left'), '', 'NaN inset');
    equal(root.style.getPropertyValue('--host-height'), '123px', 'fixed height precedence');
    equal(root.style.getPropertyValue('--host-max-height'), '', 'duplicate height');
    applyHostContext({ containerDimensions: { maxHeight: 200 } }, root);
    equal(root.style.getPropertyValue('--host-height'), '', 'stale fixed height');
    equal(root.style.getPropertyValue('--host-max-height'), '200px', 'max height');
    equal(root.style.getPropertyValue('--safe-top'), '', 'stale inset');
    applyHostContext({ containerDimensions: { height: -1, maxHeight: Infinity } }, root);
    equal(root.style.getPropertyValue('--host-max-height'), '', 'invalid height');
  `,
  palette: `
    for (const kind of kinds) {
      const v = await mount(kind, { theme: 'light' });
      const first = v.root.firstElementChild;
      equal(css(v.root).backgroundColor, 'rgb(255, 255, 255)', kind + ' default');
      assert(!v.doc.documentElement.hasAttribute('data-host-palette'), 'default palette');
      assert(!v.doc.querySelector('#__mcp-host-fonts'), 'default fonts');
      await update(v, { theme: 'dark' });
      equal(css(v.root).backgroundColor, 'rgb(29, 29, 31)', kind + ' dark');
      equal(v.root.firstElementChild, first, kind + ' remounted');
      await update(v, { theme: 'light', styles: { variables: { '--color-background-primary': palette['--color-background-primary'] } } });
      equal(css(v.root).backgroundColor, 'rgb(255, 255, 255)', kind + ' partial');
      const fonts = '@font-face{font-family:"HostTest";src:local("Arial")}/*</style><img id="xss" src="x">*/';
      const before = v.doc.head.querySelectorAll('style,link').length;
      await update(v, { styles: { variables: { ...palette, '--font-sans': '"HostTest", sans-serif', '--font-mono': 'monospace' }, css: { fonts } } });
      equal(css(v.root).backgroundColor, 'rgb(16, 24, 32)', kind + ' full');
      equal(css(v.root).color, 'rgb(240, 240, 240)', kind + ' text');
      equal(css(v.doc.body).fontFamily.split(',')[0].trim().replaceAll('"', ''), 'HostTest', 'font family');
      equal(css(v.doc.documentElement).getPropertyValue('--accent').trim(), 'light-dark(#6558dd, #8986ff)', 'accent');
      equal(v.doc.querySelector('#__mcp-host-fonts').textContent, fonts, 'font CSS');
      equal(v.doc.head.querySelectorAll('style,link').length, before + 1, 'extra font elements');
      assert(!v.doc.querySelector('#xss'), 'font markup executed');
      if (kind === 'performance') equal(css(v.root).getPropertyValue('--perf-good').trim(), 'light-dark(#157345, #75d4a2)', 'status color');
      if (kind === 'replay') equal(css(v.root.querySelector('.brand')).backgroundColor, 'rgb(101, 88, 221)', 'brand');
      await update(v, { styles: { variables: { '--color-background-primary': 'red;}</style><img id="xss2" src="x">' }, css: { fonts: '/* second */' } } });
      equal(css(v.root).backgroundColor, 'rgb(255, 255, 255)', 'stale full palette survived partial replacement');
      assert(!v.doc.documentElement.hasAttribute('data-host-palette') && !v.doc.querySelector('#xss2'), 'partial/markup gate');
      equal(v.doc.querySelectorAll('#__mcp-host-fonts').length, 1, 'font duplication');
      equal(v.doc.querySelector('#__mcp-host-fonts').textContent, fonts, 'font replacement');
      await close(v);
      for (const complete of [false, true]) {
        const initial = await mount(kind, { theme: 'light', styles: { variables: complete ? palette : { '--color-background-primary': palette['--color-background-primary'] } } });
        equal(css(initial.root).backgroundColor, complete ? 'rgb(16, 24, 32)' : 'rgb(255, 255, 255)', kind + ' initial palette');
        await close(initial);
      }
    }
  `,
  locale: `
    const unit = (value, name, locale) => new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);
    for (const kind of ['usage', 'active-sessions', 'request-logs']) {
      for (const host of [{ locale: 'de-DE', timeZone: 'Asia/Tokyo' }, {}, { locale: 'not_a_locale', timeZone: 'Mars/Base' }]) {
        const v = await mount(kind, { theme: 'light', ...host });
        const german = host.locale === 'de-DE';
        const date = value => new Intl.DateTimeFormat(german ? 'de-DE' : undefined, { dateStyle: 'short', timeStyle: 'medium', ...(german ? { timeZone: 'Asia/Tokyo' } : {}) }).format(new Date(value));
        const expected = kind === 'request-logs' ? date(logs.entries[0].timestamp) : date(start);
        if (kind === 'usage') assert(v.root.textContent.includes(german ? '12.345' : new Intl.NumberFormat().format(12345)), 'usage number');
        else assert(v.root.textContent.includes(expected), kind + ' timestamp');
        if (kind === 'active-sessions') assert(v.root.textContent.includes(unit(5, 'minute', german ? 'de-DE' : undefined) + ' ' + unit(3, 'second', german ? 'de-DE' : undefined)), 'duration');
        const text = v.root.textContent;
        await update(v, { theme: 'dark' });
        equal(v.root.textContent, text, 'partial update lost locale');
        equal(v.doc.documentElement.style.colorScheme, 'dark', 'theme delta');
        if (!german) {
          await update(v, { locale: 'de-DE', timeZone: 'Asia/Tokyo' });
          assert(v.root.textContent.includes(kind === 'usage' ? '12.345' : new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Tokyo' }).format(new Date(kind === 'request-logs' ? logs.entries[0].timestamp : start))), 'locale update ignored');
        }
        await close(v);
      }
    }
  `,
  accountState: `
    const sessions = await mount('active-sessions', { locale: 'en-US' });
    const scroll = sessions.root.querySelector('.account-table-scroll');
    const style = sessions.doc.createElement('style');
    style.textContent = '.account-table-scroll { max-width:150px }';
    sessions.doc.head.append(style);
    scroll.focus();
    scroll.scrollLeft = 60;
    assert(scroll.scrollLeft === 60, 'scroll precondition');
    await update(sessions, { theme: 'dark' });
    equal(sessions.root.querySelector('.account-table-scroll'), scroll, 'unrelated update replaced sessions');
    equal(sessions.doc.activeElement, scroll, 'unrelated update lost focus');
    await update(sessions, { locale: 'de-DE' });
    const next = sessions.root.querySelector('.account-table-scroll');
    equal(sessions.doc.activeElement, next, 'formatting update lost focus');
    equal(next.scrollLeft, 60, 'formatting update lost scroll');
    await close(sessions);
    const usage = await mount('usage', { locale: 'en-US' });
    let finish;
    usage.bridge.oncalltool = () => new Promise(resolve => { finish = resolve; });
    const select = usage.root.querySelector('select');
    select.value = 'week';
    select.dispatchEvent(new usage.frame.contentWindow.Event('change'));
    await tick();
    assert(select.disabled && finish, 'pending refresh precondition');
    await update(usage, { theme: 'dark' });
    equal(select.value, 'week', 'unrelated update reset timeframe');
    await update(usage, { locale: 'de-DE' });
    equal(select.value, 'week', 'formatting update reset timeframe');
    finish({ content: [], isError: true });
    await tick();
    equal(select.value, 'day', 'failed refresh did not restore snapshot timeframe');
    await close(usage);
  `,
  layout: `
    const targets = 'button,select,summary,textarea,input:not([type=checkbox],[type=radio],[type=hidden]),label:has(>input[type=checkbox],>input[type=radio])';
    for (const kind of kinds) {
      const v = await mount(kind, { theme: 'light' });
      const padding = ['paddingTop','paddingRight','paddingBottom','paddingLeft'];
      const initial = padding.map(key => css(v.root)[key]).join();
      equal(padding.map(key => css(v.doc.body)[key]).join(), '8px,0px,8px,0px', 'default cushion');
      const playHeight = v.doc.querySelector('#play').getBoundingClientRect().height;
      await update(v, { safeAreaInsets: { top: 4, right: 0, bottom: 0, left: 0 } });
      equal(css(v.doc.body).paddingTop, '8px', 'inset added instead of max');
      await update(v, { safeAreaInsets: { top: 30, right: 12, bottom: 40, left: 12 } });
      equal(padding.map(key => css(v.doc.body)[key]).join(), '30px,12px,40px,12px', 'safe area');
      equal(padding.map(key => css(v.root)[key]).join(), initial, 'double safe padding');
      v.frame.style.width = '360px';
      await update(v, { containerDimensions: { width: 360 }, deviceCapabilities: { touch: true, hover: false }, platform: 'mobile' });
      equal(padding.map(key => css(v.doc.body)[key]).join(), '30px,12px,40px,12px', 'narrow safe area');
      if (kind === 'request-logs') v.root.querySelector('details').open = true;
      for (const element of v.root.querySelectorAll(targets)) {
        if (!element.getClientRects().length) continue;
        const rect = element.getBoundingClientRect();
        assert(rect.height >= 44, kind + ' short touch target: ' + element.outerHTML.slice(0,120) + ' ' + rect.height);
        if (element.matches('button,select,label')) assert(rect.width >= 44, kind + ' narrow touch target');
        let scroll = false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) if (['auto','scroll'].includes(css(parent).overflowX)) scroll = true;
        if (!scroll) assert(rect.left >= 0 && rect.right <= 360, kind + ' control overflow: ' + element.outerHTML.slice(0,100));
      }
      assert(v.doc.documentElement.scrollWidth <= 360, kind + ' horizontal overflow');
      await update(v, { safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 }, deviceCapabilities: { touch: false, hover: true }, platform: 'desktop' });
      equal(padding.map(key => css(v.doc.body)[key]).join(), '4px,0px,4px,0px', 'narrow cushion');
      equal(v.doc.documentElement.dataset.input, 'pointer', 'pointer mode');
      if (kind === 'replay') equal(v.doc.querySelector('#play').getBoundingClientRect().height, playHeight, 'pointer size changed');
      if (['replay','agent-media','handoff'].includes(kind)) {
        await update(v, { displayMode: 'fullscreen', availableDisplayModes: ['inline','fullscreen'] });
        assert(v.root.classList.contains('expanded'), kind + ' fullscreen');
        assert(v.doc.documentElement.scrollWidth <= 360, kind + ' fullscreen overflow');
      }
      await close(v);
    }
  `,
  cards: `
    for (const kind of ['request-logs','active-sessions']) {
      const v = await mount(kind, { theme: 'light' });
      assert(v.root.querySelector('thead').offsetHeight > 1, 'wide headers hidden');
      v.frame.style.width = '360px';
      await update(v, { containerDimensions: { width: 360 } });
      const head = v.root.querySelector('thead');
      assert(head.getBoundingClientRect().height <= 1 && head.getAttribute('role') === 'rowgroup', 'narrow headers');
      equal(v.root.querySelector('table').getAttribute('role'), 'table', 'table role');
      const headers = [...head.querySelectorAll('th')].map(cell => cell.textContent);
      for (const row of v.root.querySelectorAll('tbody tr:not(.logs-detail)')) {
        [...row.children].forEach((cell, i) => {
          equal(cell.dataset.label, headers[i], 'card label');
          equal(css(cell, '::before').content, '"' + headers[i] + '"', 'visible label');
        });
      }
      for (const cell of v.root.querySelectorAll('td')) equal(cell.getAttribute('role'), 'cell', 'cell role');
      if (kind === 'request-logs') {
        const outcome = v.root.querySelector('tbody tr').children[3];
        equal(outcome.querySelector('small').getBoundingClientRect().left, outcome.querySelector('.logs-chip').getBoundingClientRect().left, 'status belongs in value column');
        for (const row of v.root.querySelectorAll('.logs-detail')) equal(row.getClientRects().length, 0, 'collapsed detail visible');
        v.root.querySelector('.logs-row-toggle').click();
        assert(v.root.querySelector('.logs-detail').getClientRects().length, 'detail cannot expand');
        v.root.querySelector('.logs-row-toggle').click();
        v.frame.style.width = '1180px';
        v.frame.style.height = '200px';
        assert(v.doc.documentElement.getBoundingClientRect().height > 200, 'height precondition');
        await update(v, { containerDimensions: { maxHeight: 200 } });
        assert(v.doc.documentElement.getBoundingClientRect().height <= 200, 'height bound');
        v.doc.scrollingElement.scrollTop = v.doc.scrollingElement.scrollHeight;
        const last = [...v.root.querySelectorAll('.logs-row-toggle')].at(-1).getBoundingClientRect();
        assert(last.top >= 0 && last.bottom <= 200, 'last row unreachable: ' + JSON.stringify({ top: last.top, bottom: last.bottom, scroll: v.doc.scrollingElement.scrollTop, height: v.doc.scrollingElement.scrollHeight }));
      } else {
        const cells = v.root.querySelectorAll('tbody tr:first-child td');
        equal(cells[0].getBoundingClientRect().width, cells[1].getBoundingClientRect().width, 'session ID card width');
      }
      await close(v);
    }
  `,
};

describe('widget host context', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    (chrome ? it : it.skip)(
      `adopts host ${name} through the reference bridge`,
      async function () {
        this.timeout(60000);
        const host = await build({
          stdin: {
            resolveDir: process.cwd(),
            contents: `
          import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
          import * as helpers from './src/ui/host.mjs';
          const logs = ${JSON.stringify(fixture('request-logs'))};
          const replay = ${JSON.stringify(fixture('replay-widget'))};
          const performance = ${JSON.stringify(summarizePerformance(fixture('lighthouse-performance'), { url: 'https://example.test/' }))};
          const kinds = ['replay','agent-media','handoff','performance','request-logs','usage','active-sessions'];
          const palette = { '--color-background-primary': 'rgb(16, 24, 32)', '--color-background-secondary': 'rgb(40, 48, 56)', '--color-text-primary': 'rgb(240, 240, 240)', '--color-text-secondary': 'rgb(180, 180, 180)', '--color-border-primary': 'rgb(80, 80, 80)' };
          const start = '2026-11-06T14:04:05Z';
          const assert = (ok, message) => { if (!ok) throw new Error(message); };
          const equal = (actual, expected, message) => assert(actual === expected, message + ': ' + String(actual) + ' != ' + String(expected));
          const css = (element, pseudo) => element.ownerDocument.defaultView.getComputedStyle(element, pseudo);
          const tick = () => new Promise(resolve => setTimeout(resolve, 30));
          async function mount(kind, context) {
            const frame = document.createElement('iframe');
            frame.style.cssText = 'width:1180px;height:1100px;border:0';
            frame.sandbox = 'allow-scripts allow-same-origin';
            document.body.append(frame);
            const bridge = new AppBridge(null, { name: 'Reference host', version: '1.0.0' }, { serverTools: {} }, { hostContext: context });
            const ready = new Promise(resolve => bridge.oninitialized = resolve);
            await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
            frame.src = '/widget'; await ready;
            const expiresAt = Date.now() + 120000;
            let data, payload;
            if (kind === 'replay') { data = { duration: 1000, eventCount: replay.events.length, website: replay.website }; payload = { events: replay.events }; }
            if (kind === 'request-logs') { data = { fetchedAt: start, entryCount: logs.entries.length, hasMore: false }; payload = { entries: logs.entries, filters: {}, nextCursor: null }; }
            if (kind === 'usage') data = { timeframe: 'day', fetchedAt: start, currentPeriodEnd: 1800000000, units: { used: 12345, available: 20000, overageFee: 0 }, counters: null };
            if (kind === 'active-sessions') data = { fetchedAt: '2026-11-06T14:09:08Z', limit: 2, skip: 0, count: 1, sessions: [{ browserId: 'browser-a-long-session-identifier', browserName: 'Chromium', startTime: start, type: 'browser' }] };
            if (kind === 'handoff') { data = { sessionId: 's:reference', instructions: 'Complete the human step.' }; payload = { liveURL: location.origin + '/live/index.html', state: { status: 'open', reason: null, interactable: true, viewerCount: 0, expiresAt } }; }
            if (kind === 'agent-media') { data = { imageCount: 1, videoCount: 0 }; const url = location.origin + '/preview/' + 'a'.repeat(43); payload = { mediaOrigin: location.origin, artifacts: [{ id: 'capture', type: 'image', mimeType: 'image/png', bytes: 68, label: 'Capture', rationale: 'Example capture', commandIndex: 1, width: 1, height: 1, previewUrl: url, saveUrl: url }] }; }
            await bridge.sendToolResult({ content: [], structuredContent: kind === 'performance' ? performance : { kind, data, viewRef: 'reference-' + kind, summary: 'Widget', expiresAt: new Date(expiresAt).toISOString() }, _meta: { payload } });
            await tick();
            const doc = frame.contentDocument;
            const selector = kind === 'replay' ? '.replay-card' : ['usage','active-sessions'].includes(kind) ? '#account-view' : '#' + (kind === 'agent-media' ? 'agent-media' : kind);
            const root = doc.querySelector(selector);
            assert(root && !root.hidden && !root.querySelector('[role=alert]:not([hidden])'), kind + ' did not mount: ' + doc.body.textContent);
            if (kind === 'replay') assert(doc.querySelector('#empty').hidden, 'replay did not load');
            return { frame, bridge, doc, root, context };
          }
          async function update(v, delta) { v.context = { ...v.context, ...delta }; v.bridge.setHostContext(v.context); await tick(); }
          async function close(v) { await v.bridge.teardownResource({}); v.frame.remove(); }
          try { ${scenario} document.querySelector('pre').textContent = 'PASS: ${name}'; }
          catch (error) { document.querySelector('pre').textContent = 'FAIL: ' + error.message; }
        `,
          },
          bundle: true,
          format: 'esm',
          platform: 'browser',
          write: false,
        });
        const http = createServer((request, response) => {
          if (request.url === '/widget') {
            response.setHeader('content-type', 'text/html');
            response.setHeader(
              'content-security-policy',
              `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src http://127.0.0.1:${(http.address() as AddressInfo).port}; font-src 'none'; connect-src 'none'`,
            );
            response.end(readFileSync('build/src/ui/view.html'));
          } else if (request.url === '/host.js') {
            response.setHeader('content-type', 'text/javascript');
            response.end(host.outputFiles[0].text);
          } else if (request.url?.startsWith('/preview/')) {
            response.setHeader('content-type', 'image/png');
            response.end(
              Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
                'base64',
              ),
            );
          } else {
            response.setHeader('content-type', 'text/html');
            response.end(
              '<!doctype html><pre>Waiting</pre><script type="module" src="/host.js"></script>',
            );
          }
        });
        const directory = await mkdtemp(join(tmpdir(), 'host-context-'));
        try {
          await new Promise<void>((resolve) =>
            http.listen(0, '127.0.0.1', resolve),
          );
          const { stdout } = await promisify(execFile)(
            chrome!,
            [
              '--headless',
              '--no-sandbox',
              '--disable-gpu',
              '--no-first-run',
              '--no-default-browser-check',
              `--user-data-dir=${directory}`,
              '--dump-dom',
              '--virtual-time-budget=20000',
              `http://127.0.0.1:${(http.address() as AddressInfo).port}/`,
            ],
            { timeout: 45000, maxBuffer: 8 * 1024 * 1024 },
          );
          assert.equal(
            /<pre>([\s\S]*?)<\/pre>/.exec(stdout)?.[1],
            `PASS: ${name}`,
          );
        } finally {
          http.closeAllConnections();
          await new Promise<void>((resolve) => http.close(() => resolve()));
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
});
