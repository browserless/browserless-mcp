import assert from 'node:assert/strict';
import sinon from 'sinon';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { FastMCP } from 'fastmcp';
import { registerViewWidget } from '../../src/resources/view-widget.js';

const chrome =
  process.env.CHROME_PATH ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((path) => existsSync(path));
const fixture = JSON.parse(
  readFileSync('test/fixtures/request-logs.json', 'utf8'),
);

describe('request-log explorer browser', () => {
  (chrome ? it : it.skip)(
    'renders and filters safely, pages without duplicates, respects host context and handles terminal states',
    async function () {
      this.timeout(30000);
      const server = new FastMCP({ name: 'logs-browser', version: '1.0.0' });
      const resources = sinon.spy(server, 'addResource');
      registerViewWidget(server);
      const resource = await resources.firstCall.args[0].load();
      resources.restore();
      if (Array.isArray(resource) || !('text' in resource))
        throw new Error('Missing widget HTML');
      const host = await build({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
      import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
      const fixture = ${JSON.stringify(fixture)};
      const assert = (ok, message) => { if (!ok) throw new Error(message); };
      function until(doc, check) {
        if (check()) return Promise.resolve();
        return new Promise(resolve => {
          const observer = new MutationObserver(() => { if (check()) { observer.disconnect(); resolve(); } });
          observer.observe(doc.body, { childList: true, subtree: true, attributes: true });
        });
      }
      const result = (entries = fixture.entries, filters = {}, nextCursor = fixture.nextCursor, lifetime = 60000) => ({
        content: [{ type: 'text', text: 'Request log explorer' }], structuredContent: {
          kind: 'request-logs', viewRef: 'view-logs-' + Math.random(), summary: 'Request logs',
          expiresAt: new Date(Date.now() + lifetime).toISOString(),
          data: { fetchedAt: new Date().toISOString(), entryCount: entries.length, hasMore: Boolean(nextCursor) }
        }, _meta: { payload: { entries, filters, nextCursor } }
      });
      async function mount(initial = result(), clipboard = true) {
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-scripts allow-same-origin'; frame.allow = 'clipboard-write';
        document.body.append(frame);
        const bridge = new AppBridge(null, { name: 'Browser test', version: '1.0.0' }, { serverTools: {} }, {
          hostContext: { theme: 'dark', locale: 'en-GB', timeZone: 'UTC' }
        });
        let mode = 'default', release, deferred;
        const calls = [], copied = [];
        bridge.oncalltool = async call => {
          calls.push(call);
          if (mode === 'defer') await new Promise(resolve => { release = resolve; deferred(); });
          if (mode === 'retention') return { isError: true, content: [{ type: 'text', text: 'Request logs for this plan are limited to the last 8 hours.' }] };
          if (mode === 'unavailable') return { isError: true, content: [{ type: 'text', text: '403 Access revoked' }] };
          const { cursor, ...filters } = call.arguments;
          if (mode === 'empty') return result([], filters, null);
          if (cursor === 'opaque-log-page-2') return result([fixture.entries[0], { ...fixture.entries[0], requestId: 'request-next' }], filters, 'opaque-log-page-3');
          if (cursor === 'opaque-log-page-3') return result([fixture.entries[0]], filters, cursor);
          return result(fixture.entries, filters);
        };
        const ready = new Promise(resolve => { bridge.oninitialized = resolve; });
        await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
        frame.src = '/widget'; await ready;
        const doc = frame.contentDocument;
        Object.defineProperty(doc.defaultView.navigator, 'clipboard', { configurable: true, value: clipboard ? { writeText: async value => copied.push(value) } : undefined });
        await bridge.sendToolResult(initial);
        await until(doc, () => !doc.querySelector('#request-logs').hidden || !doc.querySelector('.replay-card').hidden);
        const root = doc.querySelector('#request-logs');
        assert(!root.hidden && doc.querySelector('.replay-card').hidden, 'Logs displayed replay UI');
        return { frame, doc, root, bridge, calls, copied, mode(value) { mode = value; },
          defer(callback) { mode = 'defer'; deferred = callback; }, release() { release(); } };
      }
      const role = (v, key) => v.root.querySelector('[data-role="' + key + '"]');
      const rows = v => v.root.querySelectorAll('.logs-row-toggle');
      async function click(v, key) {
        role(v, key).click();
        await until(v.doc, () => v.root.getAttribute('aria-busy') === 'false');
      }
      async function apply(v) {
        role(v, 'apply').click();
        await until(v.doc, () => v.root.getAttribute('aria-busy') === 'false');
      }
      try {
        const v = await mount();
        const root = v.root;
        assert(rows(v).length === 4, 'Missing representative rows');
        assert(v.root.querySelectorAll('img, script, a').length === 0, 'Backend strings were rendered as HTML or links');
        assert(!v.root.textContent.includes(fixture.nextCursor), 'Cursor was visible');
        const expectedTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(fixture.entries[0].timestamp));
        assert(rows(v)[0].textContent.includes(expectedTime), 'Initial host locale/timezone ignored');
        rows(v)[2].click();
        assert(v.root.querySelectorAll('.logs-detail')[2].hidden === false, 'Row did not expand');
        assert(v.root.querySelectorAll('.logs-detail')[2].textContent.includes(fixture.entries[2].message), 'Full message was lost');
        const copy = v.root.querySelectorAll('.logs-detail')[2].querySelector('[aria-label="Copy request id"]');
        assert(copy, 'Copy missing despite permission'); copy.click();
        await until(v.doc, () => copy.textContent === 'Copied');
        assert(v.copied[0] === 'request-failure', 'Copied wrong ID');
        await click(v, 'more');
        assert(rows(v).length === 5 && v.calls[0].arguments.cursor === fixture.nextCursor, 'Overlap was not deduplicated or cursor was not used');
        assert(v.root.querySelectorAll('.logs-detail')[2].hidden === false, 'Expanded row was lost on paging');
        await click(v, 'more');
        assert(role(v, 'more').hidden && rows(v).length === 5, 'Repeated cursor did not stop paging');
        const filters = {
          startTime: '2026-11-05T11:00:00Z', endTime: '2026-11-05T13:00:00Z', limit: 2,
          endpoint: '/chromium/agent', outcome: 'failed', category: 'browserless_refused', reason: 'concurrency_limit',
          requestId: 'request-failure', url: 'https://example.test/login', apiKeyId: 'key-a',
          eventNames: ['request.failed', 'bql.*.failed'], levels: ['ERROR'], order: 'asc'
        };
        const form = v.root.querySelector('form');
        v.root.querySelector('.logs-filters').open = true;
        for (const [key, value] of Object.entries(filters)) {
          if (key === 'levels') { for (const box of form.querySelectorAll('[name="levels"]')) box.checked = value.includes(box.value); }
          else form.elements.namedItem(key).value = Array.isArray(value) ? value.join(String.fromCharCode(10)) : String(value);
        }
        await apply(v);
        const call = v.calls.at(-1);
        assert(call.name === 'browserless_logs' && call.arguments.cursor === undefined, 'Filter action fetched wrong tool or reused cursor');
        for (const [key, value] of Object.entries(filters)) assert(JSON.stringify(call.arguments[key]) === JSON.stringify(value), 'Lost filter: ' + key);
        assert(rows(v).length === 4 && v.root.querySelectorAll('.logs-detail')[2].hidden === false, 'Refresh duplicated rows or lost expansion');
        v.mode('retention');
        await click(v, 'refresh');
        assert(!role(v, 'error').hidden && role(v, 'error').textContent.includes('last 8 hours'), 'Retention error was hidden');
        assert(rows(v).length === 4, 'Error discarded last result');
        v.mode('default'); await click(v, 'retry');
        assert(role(v, 'error').hidden && rows(v).length === 4, 'Retry did not recover');
        const lightTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/New_York' }).format(new Date(fixture.entries[0].timestamp));
        v.frame.style.width = '350px';
        v.bridge.setHostContext({ theme: 'light', locale: 'en-US', timeZone: 'America/New_York', containerDimensions: { width: 350 } });
        await until(v.doc, () => rows(v)[0].textContent.includes(lightTime));
        assert(v.root.getBoundingClientRect().width <= 350, 'Narrow layout overflowed');
        assert(getComputedStyle(v.doc.documentElement).colorScheme.includes('light'), 'Host theme ignored');
        assert(v.root === root && document.querySelectorAll('iframe').length === 1, 'Updates remounted widget');
        v.mode('empty'); await click(v, 'clear');
        assert(rows(v).length === 0 && !role(v, 'empty').hidden, 'Missing empty-state recovery');
        assert(Object.keys(v.calls.at(-1).arguments).length === 0, 'Clear left filters behind');
        v.mode('default'); await click(v, 'refresh');
        const pending = new Promise(resolve => v.defer(resolve));
        role(v, 'refresh').click(); await pending;
        assert(v.root.getAttribute('aria-busy') === 'true' && role(v, 'status').textContent.includes('Loading'), 'Missing loading state');
        await v.bridge.sendToolCancelled({ reason: 'User cancelled log read' });
        await until(v.doc, () => role(v, 'status').textContent === 'Cancelled');
        v.release(); await new Promise(resolve => setTimeout(resolve, 0));
        assert(rows(v).length === 0 && role(v, 'refresh').disabled, 'Cancelled response restored rows');
        await v.bridge.teardownResource({}); v.frame.remove();
        const renewed = await mount(result(fixture.entries, {}, null, 1000));
        await click(renewed, 'refresh');
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert(role(renewed, 'error').hidden && !role(renewed, 'refresh').disabled, 'New snapshot kept old expiry');
        await click(renewed, 'refresh');
        assert(renewed.calls.length === 2, 'Refresh guard kept old expiry');
        await renewed.bridge.teardownResource({}); renewed.frame.remove();
        const noClipboard = await mount(result(), false);
        rows(noClipboard)[0].click();
        assert(!noClipboard.root.querySelector('[aria-label="Copy request id"]'), 'Copy shown without clipboard support');
        assert(noClipboard.root.textContent.includes('request-success'), 'IDs unavailable without clipboard');
        await noClipboard.bridge.teardownResource({}); noClipboard.frame.remove();
        const expired = await mount(result(fixture.entries, {}, null, -1));
        assert(role(expired, 'status').textContent === 'Expired' && role(expired, 'refresh').disabled, 'Expired state missing');
        await expired.bridge.teardownResource({}); expired.frame.remove();
        const revoked = await mount(); revoked.mode('unavailable'); await click(revoked, 'refresh');
        assert(role(revoked, 'status').textContent === 'Unavailable' && rows(revoked).length === 0, 'Revocation left rows available');
        await revoked.bridge.teardownResource({}); revoked.frame.remove();
        const invalid = await mount({ ...result(), _meta: { payload: { entries: 'bad' } } });
        assert(invalid.root.textContent.includes('unavailable') && invalid.doc.querySelector('.replay-card').hidden, 'Invalid data displayed replay UI');
        await invalid.bridge.teardownResource({}); invalid.frame.remove();
        const preview = await mount(); rows(preview)[2].click();
        document.querySelector('pre').textContent = 'PASS: request logs, filters, pagination, safety, states, clipboard, locale, theme, CSP';
      } catch (error) { document.querySelector('pre').textContent = 'FAIL: ' + error.message; }
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
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'",
          );
          response.end(resource.text);
        } else if (request.url === '/host.js') {
          response.setHeader('content-type', 'text/javascript');
          response.end(host.outputFiles[0].text);
        } else {
          response.setHeader('content-type', 'text/html');
          response.end(
            '<!doctype html><style>body{background:#111;color:white}iframe{width:1100px;height:1100px;border:0}</style><pre>Waiting</pre><script type="module" src="/host.js"></script>',
          );
        }
      });
      const directory = await mkdtemp(join(tmpdir(), 'log-explorer-browser-'));
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
            '--virtual-time-budget=12000',
            ...(process.env.WIDGET_SCREENSHOT_PATH
              ? [
                  `--screenshot=${process.env.WIDGET_SCREENSHOT_PATH}`,
                  '--window-size=1180,1200',
                ]
              : []),
            `http://127.0.0.1:${(http.address() as AddressInfo).port}/`,
          ],
          { timeout: 25000, maxBuffer: 8 * 1024 * 1024 },
        );
        assert.equal(
          /<pre>([\s\S]*?)<\/pre>/.exec(stdout)?.[1],
          'PASS: request logs, filters, pagination, safety, states, clipboard, locale, theme, CSP',
        );
      } finally {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
