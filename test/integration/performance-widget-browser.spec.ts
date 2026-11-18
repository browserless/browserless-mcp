import { expect } from 'chai';
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
import {
  registerPerformanceWidget,
  registerViewWidget,
} from '../../src/resources/view-widget.js';
import { summarizePerformance } from '../../src/lib/performance-summary.js';

// Uses an installed Chromium without adding a browser automation dependency.
const chrome =
  process.env.CHROME_PATH ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((path) => existsSync(path));

const previewCases = {
  'pending audit cancel button aborts the request': `
    await pending();
    await wait(() => auditCalls === 1);
    $('[data-role="cancel-audit"]').click();
    await wait(() => text('[role="alert"]').includes('Performance audit was cancelled.'));
    await wait(() => auditAborted);
    check(!$('.perf-preview') && !$('.perf-progress'), 'cancel button retained progress');
  `,
  'pending audit completes once and updates model context': `
    await pending();
    await wait(() => auditCalls === 1);
    check($('.perf-preview') && $('.perf-progress'), 'missing loading shell while request pending');
    check(text('[data-role="target"]') === 'example.com' && text('[data-role="device"]') === 'Mobile', 'missing pending input');
    await pending();
    await theme('dark');
    check(auditCalls === 1, 'duplicate notification repeated audit');
    resolveAudit({ content: [], structuredContent: report });
    await wait(() => $('.perf-scores') && contexts.length === 1);
    check(!$('.perf-preview') && !$('.perf-progress'), 'loader survived result');
    check(JSON.stringify(contexts).includes('auditRef'), 'model context missing audit reference');
  `,
  'pending audit execution error removes loading state': `
    await pending();
    await wait(() => auditCalls === 1);
    resolveAudit({ isError: true, content: [{ type: 'text', text: 'Audit backend unavailable' }] });
    await wait(() => text('[role="alert"]').includes('Audit backend unavailable'));
    check(!$('.perf-preview') && !$('.perf-progress') && contexts.length === 0, 'failed audit retained progress');
  `,
  'pending audit cancellation ignores late results': `
    await pending();
    await wait(() => auditCalls === 1);
    await bridge.sendToolCancelled({ reason: 'Audit cancelled by user' });
    await wait(() => text('[role="alert"]').includes('Audit cancelled by user'));
    await wait(() => auditAborted);
    resolveAudit({ content: [], structuredContent: report });
    await theme('dark');
    check(!$('.perf-preview') && !$('.perf-scores') && contexts.length === 0, 'late result revived cancelled audit');
  `,
  'pending audit teardown aborts the request': `
    await pending();
    await wait(() => auditCalls === 1);
    await bridge.teardownResource({});
    await wait(() => auditAborted);
    resolveAudit({ content: [], structuredContent: report });
    await theme('dark');
    check(!$('#performance').childElementCount && contexts.length === 0, 'late result revived disposed audit');
  `,
  'shell before input': `
    await wait(() => $('.perf-preview'));
    check(!$('#performance').hidden && $('.replay-card').hidden, 'shell visibility');
    check($('.perf-progress[role="progressbar"]') && text('.perf-status') === 'Preparing audit…', 'initial status');
    check(!$('.perf-progress').hasAttribute('aria-valuenow'), 'indeterminate progress');
  `,
  'partial changing input and authoritative complete input': `
    await partial({ url: 'https://exa' });
    await wait(() => text('[data-role="target"]') === 'exa');
    await partial({ url: 'https://example.com/pri', device: 'desktop' });
    await wait(() => text('[data-role="target"]') === 'example.com/pri' && text('[data-role="device"]') === 'Desktop');
    await partial({ url: 'https:/', device: 'desktop', categories: ['seo', 'acc'] });
    await wait(() => text('[data-role="categories"]') === 'SEO');
    check(text('[data-role="target"]') === 'example.com/pri', 'invalid partial erased target');
    await partial({ url: 'https://example.com/pricing', device: 'desktop', categories: ['seo', 'accessibility'] });
    await wait(() => text('[data-role="target"]') === 'example.com/pricing' && text('[data-role="categories"]') === 'SEO, Accessibility');
    await complete({ url: 'https://example.com/pricing', categories: ['seo'] });
    await wait(() => text('.perf-status').startsWith('Running Lighthouse audit'));
    check($('[data-role="device"]').hidden && text('[data-role="categories"]') === 'SEO', 'complete input retained stale fields');
  `,
  'sensitive input stays out of the DOM': `
    await complete({ url: 'https://user:pass@example.com/a?token=SECRET123#frag', profile: 'my-login-profile', config: { extraHeaders: { Authorization: 'Bearer SECRET456' } } });
    await wait(() => text('[data-role="target"]') === 'example.com/a');
    for (const secret of ['user', 'pass', 'SECRET123', 'frag', 'my-login-profile', 'Authorization', 'SECRET456']) {
      check(!$('#performance').innerHTML.includes(secret) && !text('#performance').includes(secret), 'leaked ' + secret);
    }
  `,
  'complete input then result': `
    await complete({ url: 'https://example.com/' });
    await wait(() => text('.perf-status').startsWith('Running Lighthouse audit'));
    await result();
    await wait(() => $('.perf-scores'));
    check(!$('.perf-preview') && !$('.perf-progress') && text('#performance h1') === 'Performance report', 'preview survived result');
  `,
  'result without input': `
    await result();
    await wait(() => $('.perf-scores'));
    check(!$('.perf-preview') && !$('.perf-progress') && text('#performance h1') === 'Performance report', 'result-only rendering');
  `,
  'cancellation after partial': `
    await partial({ url: 'https://example.com/' });
    await wait(() => text('[data-role="target"]') === 'example.com');
    await bridge.sendToolCancelled({ reason: 'User cancelled the Lighthouse audit' });
    await wait(() => text('#performance [role="alert"]').includes('User cancelled the Lighthouse audit'));
    check(!$('.perf-preview') && !$('.perf-progress') && text('#performance').includes('Run a new audit'), 'cancellation left progress');
  `,
  'out-of-order input and teardown': `
    await complete({ url: 'https://example.com/a' });
    await wait(() => text('[data-role="target"]') === 'example.com/a');
    await partial({ url: 'https://evil.example/b' });
    await complete({ url: 'https://evil.example/duplicate' });
    await theme('dark');
    check(text('[data-role="target"]') === 'example.com/a', 'input replaced complete');
    await result();
    await wait(() => $('.perf-scores'));
    await partial({ url: 'https://evil.example/' });
    await complete({ url: 'https://evil.example/' });
    await theme('light');
    check($('.perf-scores') && !$('.perf-preview'), 'input replaced result');
    await bridge.teardownResource({});
    frame.remove();
    await open();
    await partial({ url: 'https://example.com/' });
    await wait(() => text('[data-role="target"]') === 'example.com');
    await bridge.teardownResource({});
    check(!$('#performance').childElementCount, 'teardown retained children');
    try { await partial({ url: 'https://example.com/x' }); } catch { /* Bridge may reject after teardown. */ }
    await theme('dark');
    check(!$('.perf-preview') && !$('#performance').childElementCount, 'input revived torn-down preview');
  `,
  'show widget ignores input': `
    await partial({ viewRef: 'abc' });
    await complete({ viewRef: 'abc' });
    await theme('dark');
    check([...frame.contentDocument.querySelectorAll('main')].every(main => main.hidden), 'show widget displayed a panel');
  `,
};

describe('performance widget input preview', () => {
  for (const [name, scenario] of Object.entries(previewCases)) {
    (chrome ? it : it.skip)(name, async function () {
      this.timeout(25000);
      const server = new FastMCP({ name: 'preview-test', version: '1.0.0' });
      const resources = sinon.spy(server, 'addResource');
      if (name === 'show widget ignores input') registerViewWidget(server);
      else registerPerformanceWidget(server);
      const resource = await resources.firstCall.args[0].load();
      resources.restore();
      if (Array.isArray(resource) || !('text' in resource))
        throw new Error('Missing widget HTML');
      const report = summarizePerformance(
        JSON.parse(
          readFileSync('test/fixtures/lighthouse-performance.json', 'utf8'),
        ),
        { url: 'https://example.test/' },
      );
      const host = await build({
        stdin: {
          resolveDir: process.cwd(),
          contents: `
          import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
          const output = document.querySelector('pre');
          const calls = [], errors = [], contexts = [];
          const report = ${JSON.stringify(report)};
          let auditCalls = 0, resolveAudit, auditAborted = false;
          let frame, bridge;
          const check = (condition, message) => { if (!condition) throw new Error(message + '; widget alert: ' + (frame?.contentDocument.querySelector('[role="alert"]')?.textContent ?? 'none')); };
          const $ = selector => frame.contentDocument.querySelector(selector);
          const text = selector => $(selector)?.textContent ?? '';
          const wait = predicate => new Promise((resolve, reject) => {
            const start = performance.now();
            const poll = () => {
              if (predicate()) return resolve();
              if (performance.now() - start >= 3000) return reject(new Error('Timed out: ' + predicate));
              setTimeout(poll, 10);
            }; poll();
          });
          async function open() {
            frame = document.createElement('iframe');
            frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
            document.body.append(frame);
            bridge = new AppBridge(null, { name: 'Browser check', version: '1.0.0' }, { serverTools: {} });
            for (const handler of ['oncalltool', 'onopenlink', 'ondownloadfile', 'onmessage'])
              bridge[handler] = async () => { calls.push(handler); return {}; };
            bridge.oncalltool = async (params, extra) => {
              calls.push(params.name);
              if (params.name !== 'browserless_performance_run') throw new Error('Unexpected tool');
              auditCalls++;
              return new Promise((resolve, reject) => {
                resolveAudit = resolve;
                extra.mcpReq.signal.addEventListener('abort', () => { auditAborted = true; reject(new Error('Aborted')); }, { once: true });
              });
            };
            bridge.onupdatemodelcontext = async params => { contexts.push(params); return {}; };
            const ready = new Promise(resolve => { bridge.oninitialized = resolve; });
            await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
            frame.src = '/widget';
            await ready;
            frame.contentWindow.addEventListener('error', event => errors.push(event.message));
            frame.contentWindow.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
          }
          const partial = args => bridge.sendToolInputPartial({ arguments: args });
          const complete = args => bridge.sendToolInput({ arguments: args });
          const result = () => bridge.sendToolResult({ content: [], structuredContent: ${JSON.stringify(report)} });
          const pending = () => bridge.sendToolResult({ content: [], structuredContent: {
            kind: 'performance-pending', auditRef: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requestTimeoutMs: 20000,
            input: { url: 'https://example.com', device: 'mobile', categories: ['performance'] },
          } });
          const theme = async value => {
            bridge.setHostContext({ theme: value });
            await wait(() => frame.contentDocument.documentElement.dataset.theme === value);
          };
          try {
            await open();
            ${scenario}
            await theme(frame.contentDocument.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
            check(${name.startsWith('pending audit') ? "calls.length === 1 && calls[0] === 'browserless_performance_run'" : 'calls.length === 0'}, 'Unexpected host action: ' + calls.join(','));
            check(errors.length === 0, 'Browser error: ' + errors.join(','));
            output.textContent = 'PASS';
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
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'",
          );
          response.end(resource.text);
        } else if (request.url === '/host.js') {
          response.setHeader('content-type', 'text/javascript');
          response.end(host.outputFiles[0].text);
        } else {
          response.setHeader('content-type', 'text/html');
          response.end(
            '<!doctype html><pre>Waiting</pre><script type="module" src="/host.js"></script>',
          );
        }
      });
      const directory = await mkdtemp(join(tmpdir(), 'performance-preview-'));
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
            '--user-data-dir=' + directory,
            '--dump-dom',
            '--virtual-time-budget=10000',
            'http://127.0.0.1:' + (http.address() as AddressInfo).port + '/',
          ],
          { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
        );
        expect(/<pre>([\s\S]*?)<\/pre>/.exec(stdout)?.[1]).to.equal('PASS');
      } finally {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

describe('performance widget browser recovery', () => {
  (chrome ? it : it.skip)(
    'shows performance errors and cancellations without a successful payload',
    async function () {
      this.timeout(25000);
      const server = new FastMCP({
        name: 'browser-recovery-test',
        version: '1.0.0',
      });
      const resources = sinon.spy(server, 'addResource');
      registerPerformanceWidget(server);
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
        try {
          for (const cancelled of [false, true]) {
            const frame = document.createElement('iframe');
            frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
            document.body.append(frame);
            const bridge = new AppBridge(null, { name: 'Browser check', version: '1.0.0' }, {});
            const ready = new Promise(resolve => { bridge.oninitialized = resolve; });
            await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
            frame.src = '/widget';
            await ready;
            await bridge.sendToolInput({ arguments: { url: 'https://example.test/' } });
            const settled = new Promise(resolve => {
              const observer = new MutationObserver(() => {
                if (frame.contentDocument.querySelector('#performance [role="alert"], .empty[data-error]')) {
                  observer.disconnect(); resolve();
                }
              });
              observer.observe(frame.contentDocument.body, { subtree: true, childList: true, attributes: true });
            });
            const message = cancelled ? 'User cancelled the Lighthouse audit' : 'Lighthouse audit timed out';
            if (cancelled) await bridge.sendToolCancelled({ reason: message });
            else await bridge.sendToolResult({ isError: true, content: [{ type: 'text', text: message }] });
            await settled;
            const doc = frame.contentDocument;
            if (doc.querySelector('#performance').hidden || !doc.querySelector('.replay-card').hidden)
              throw new Error('Performance failure displayed replay UI');
            if (!doc.querySelector('#performance').textContent.includes(message))
              throw new Error('Original performance error was lost');
            if (doc.querySelector('#retry').getBoundingClientRect().height)
              throw new Error('Replay retry control is visible');
            if (!doc.querySelector('#performance').textContent.includes('Run a new audit'))
              throw new Error('Missing audit recovery guidance');
            await bridge.teardownResource({});
            frame.remove();
          }
          output.textContent = 'PASS: performance error and cancellation recovery';
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
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'",
          );
          response.end(resource.text);
        } else if (request.url === '/host.js') {
          response.setHeader('content-type', 'text/javascript');
          response.end(host.outputFiles[0].text);
        } else {
          response.setHeader('content-type', 'text/html');
          response.end(
            '<!doctype html><pre>Waiting</pre><script type="module" src="/host.js"></script>',
          );
        }
      });
      const directory = await mkdtemp(join(tmpdir(), 'performance-browser-'));
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
            `http://127.0.0.1:${(http.address() as AddressInfo).port}/`,
          ],
          { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
        );
        const status = /<pre>([\s\S]*?)<\/pre>/.exec(stdout)?.[1];
        expect(status).to.equal(
          'PASS: performance error and cancellation recovery',
        );
      } finally {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
