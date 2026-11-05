import assert from 'node:assert/strict';
import sinon from 'sinon';
import { existsSync } from 'node:fs';
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

describe('account widget browser controls', () => {
  (chrome ? it : it.skip)(
    'updates independent snapshots in place, preserves filters and recovers failed updates under CSP',
    async function () {
      this.timeout(25000);
      const server = new FastMCP({ name: 'account-browser', version: '1.0.0' });
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
        const output = document.querySelector('pre');
        const assert = (condition, message) => { if (!condition) throw new Error(message); };
        function until(doc, condition) {
          if (condition()) return Promise.resolve();
          return new Promise(resolve => {
            const observer = new MutationObserver(() => { if (condition()) { observer.disconnect(); resolve(); } });
            observer.observe(doc.body, { attributes: true, childList: true, subtree: true });
          });
        }
        const usage = (timeframe = 'day', key = 'key-a', counters = true) => ({
          timeframe, apiKeyIds: [key], fetchedAt: new Date().toISOString(), currentPeriodEnd: 1800000000,
          units: { used: 240, available: 200, overageFee: 0 },
          counters: counters ? { successful: timeframe === 'week' ? 70 : 10, errored: 0,
            timedout: null, queued: 0, rejected: 0, maxConcurrent: 1, captcha: 0, proxy: 0 } : null,
        });
        const sessions = (empty = false) => ({
          fetchedAt: new Date().toISOString(), limit: 2, skip: 3, count: empty ? 0 : 9,
          sessions: empty ? [] : [{ browserId: 'browser-a', browserName: '<img src=x onerror=alert(1)>',
            startTime: new Date(Date.now() - 180000).toISOString(), type: null }],
        });
        const result = (kind, data, expires = Date.now() + 60000) => ({ content: [], structuredContent: {
          kind, data, viewRef: 'view-browser-' + Math.random(), summary: 'Account snapshot', expiresAt: new Date(expires).toISOString(),
        } });
        async function mount(kind, data, lifetime = 60000) {
          const frame = document.createElement('iframe');
          frame.sandbox = 'allow-scripts allow-same-origin';
          document.body.append(frame);
          const bridge = new AppBridge(null, { name: 'Browser test', version: '1.0.0' }, { serverTools: {} });
          const ready = new Promise(resolve => { bridge.oninitialized = resolve; });
          const calls = [];
          let reject = false, empty = false, defer, release;
          bridge.oncalltool = async call => {
            calls.push(call);
            if (defer) await new Promise(resolve => { release = resolve; defer(); });
            if (reject) return { isError: true, content: [{ type: 'text', text: 'Temporary failure' }] };
            return result(kind, kind === 'usage' ? usage(call.arguments.timeframe, data.apiKeyIds[0]) : sessions(empty));
          };
          await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
          frame.src = '/widget';
          await ready;
          await bridge.sendToolResult(result(kind, data, Date.now() + lifetime));
          const doc = frame.contentDocument;
          await until(doc, () => !doc.querySelector('#account-view').hidden);
          const root = doc.querySelector('#account-view');
          assert(doc.querySelector('.replay-card').hidden, 'Account view showed replay');
          return { frame, doc, root, bridge, calls, reject(value) { reject = value; }, empty(value) { empty = value; },
            defer(value) { defer = value; }, release() { release(); } };
        }
        const role = (view, name) => view.root.querySelector('[data-role="' + name + '"]');
        const select = view => view.root.querySelector('select');
        const switchTo = async (view, timeframe) => {
          select(view).value = timeframe;
          select(view).dispatchEvent(new Event('change'));
          await until(view.doc, () => view.root.getAttribute('aria-busy') === 'false');
        };
        try {
          const a = await mount('usage', usage());
          const b = await mount('usage', usage('day', 'key-b', false));
          const s = await mount('active-sessions', sessions());
          assert(a.root.querySelector('progress').value === 200, 'Overage meter must clamp to included units');
          assert(a.root.querySelector('.account-overage').textContent.includes('40'), 'Missing overage');
          assert(!b.root.querySelector('dl') && b.root.textContent.includes('despite billed units'), 'Empty counters fabricated a chart or hid billed usage');
          assert(s.root.querySelectorAll('tbody tr').length === 1 && !s.root.querySelector('img'), 'Unsafe session content or missing row');
          assert(s.root.textContent.includes('3m 0s'), 'Missing snapshot duration');
          assert(s.root.textContent.includes('URLs are not provided'), 'Missing URL availability note');
          await switchTo(a, 'week');
          assert(role(a, 'body').textContent.includes('70'), 'Timeframe did not update');
          assert(select(b).value === 'day' && b.calls.length === 0, 'Other widget was mutated');
          assert(a.calls[0].name === 'browserless_usage'
            && a.calls[0].arguments.timeframe === 'week'
            && a.calls[0].arguments.apiKeyIds.length === 1
            && a.calls[0].arguments.apiKeyIds[0] === 'key-a', 'Usage filters changed');
          a.reject(true);
          await switchTo(a, 'hour');
          assert(!role(a, 'error').hidden && select(a).value === 'week', 'Failed refresh lost timeframe');
          assert(role(a, 'body').textContent.includes('70'), 'Failed refresh lost snapshot');
          a.reject(false);
          role(a, 'retry').click();
          await until(a.doc, () => a.root.getAttribute('aria-busy') === 'false');
          assert(select(a).value === 'hour' && role(a, 'error').hidden, 'Retry did not recover requested window');
          s.empty(true);
          role(s, 'refresh').click();
          await until(s.doc, () => s.root.getAttribute('aria-busy') === 'false');
          assert(!s.root.querySelector('table') && s.root.textContent.includes('No browsers on this page'), 'Sessions refresh did not show empty page');
          assert(s.calls[0].name === 'browserless_sessions'
            && s.calls[0].arguments.action === 'active'
            && s.calls[0].arguments.limit === 2
            && s.calls[0].arguments.skip === 3, 'Session pagination changed');
          s.reject(true);
          role(s, 'refresh').click();
          await until(s.doc, () => s.root.getAttribute('aria-busy') === 'false');
          assert(!role(s, 'error').hidden && s.root.textContent.includes('No browsers on this page'), 'Sessions failure discarded last snapshot');
          s.reject(false); s.empty(false);
          role(s, 'retry').click();
          await until(s.doc, () => s.root.getAttribute('aria-busy') === 'false');
          assert(s.root.querySelectorAll('tbody tr').length === 1, 'Sessions retry did not restore table');
          assert(a.doc.querySelector('#account-view') === a.root && document.querySelectorAll('iframe').length === 3, 'Refresh remounted a widget');
          assert(a.calls.every(call => call.name === 'browserless_usage') && s.calls.every(call => call.name === 'browserless_sessions'), 'Refresh called show or controlled browser');
          for (const kind of ['usage', 'active-sessions']) {
            const renewed = await mount(kind, kind === 'usage' ? usage() : sessions(), 1000);
            if (kind === 'usage') await switchTo(renewed, 'week');
            else {
              role(renewed, 'refresh').click();
              await until(renewed.doc, () => renewed.root.getAttribute('aria-busy') === 'false');
            }
            await new Promise(resolve => setTimeout(resolve, 1200));
            assert(role(renewed, 'error').hidden && !select(renewed).disabled,
              'Refreshed ' + kind + ' widget expired at its original deadline');
            if (kind === 'usage') await switchTo(renewed, 'hour');
            else {
              role(renewed, 'refresh').click();
              await until(renewed.doc, () => renewed.root.getAttribute('aria-busy') === 'false');
            }
            assert(renewed.calls.length === 2 && role(renewed, 'error').hidden,
              'Refresh guard still used original ' + kind + ' expiry');
            await renewed.bridge.teardownResource({});
            renewed.frame.remove();
          }
          await b.bridge.sendToolResult(result('usage', usage('day', 'key-b', false), Date.now() - 1));
          await until(b.doc, () => !role(b, 'error').hidden);
          assert(b.doc.querySelector('.replay-card').hidden && !b.root.textContent.toLowerCase().includes('replay'), 'Expiry showed replay recovery');
          const started = new Promise(resolve => a.defer(resolve));
          select(a).value = 'week'; select(a).dispatchEvent(new Event('change'));
          await started;
          await a.bridge.sendToolResult(result('usage', usage('day', 'replacement-key')));
          await until(a.doc, () => select(a).value === 'day');
          a.release();
          await new Promise(resolve => setTimeout(resolve, 0));
          assert(select(a).value === 'day' && !role(a, 'body').textContent.includes('70'), 'Late refresh overwrote replacement snapshot');
          await a.bridge.teardownResource({});
          assert(a.root.childNodes.length === 0, 'Teardown left account UI');
          a.frame.remove();
          output.textContent = 'PASS: account widgets, filters, refresh, retry, isolation, expiry, teardown, CSP';
        } catch (error) { output.textContent = 'FAIL: ' + error.message; }
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
            '<!doctype html><style>body{background:#111;color:white}iframe{width:700px;height:620px;border:0;vertical-align:top}</style><pre>Waiting</pre><script type="module" src="/host.js"></script>',
          );
        }
      });
      const directory = await mkdtemp(
        join(tmpdir(), 'account-widgets-browser-'),
      );
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
            '--virtual-time-budget=10000',
            ...(process.env.WIDGET_SCREENSHOT_PATH
              ? [
                  `--screenshot=${process.env.WIDGET_SCREENSHOT_PATH}`,
                  '--window-size=1480,1500',
                ]
              : []),
            `http://127.0.0.1:${(http.address() as AddressInfo).port}/`,
          ],
          { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
        );
        assert.equal(
          /<pre>([\s\S]*?)<\/pre>/.exec(stdout)?.[1],
          'PASS: account widgets, filters, refresh, retry, isolation, expiry, teardown, CSP',
        );
      } finally {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
