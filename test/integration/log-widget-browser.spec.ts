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
  async function run(this: Mocha.Context, scenario: 'explorer' | 'chat') {
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
      import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
      const fixture = ${JSON.stringify(fixture)};
      const scenario = ${JSON.stringify(scenario)};
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
      async function mount(initial = result(), clipboard = true, caps = { serverTools: {} }) {
        const frame = document.createElement('iframe');
        frame.sandbox = 'allow-scripts allow-same-origin'; frame.allow = 'clipboard-write';
        document.body.append(frame);
        const bridge = new AppBridge(null, { name: 'Browser test', version: '1.0.0' }, caps, {
          hostContext: { theme: 'dark', locale: 'en-GB', timeZone: 'UTC' }
        });
        let mode = 'default', release, deferred;
        const calls = [], copied = [];
        const contexts = [], messages = [], delivery = [];
        let contextReply, messageReply;
        if (scenario === 'chat') {
          bridge.onupdatemodelcontext = async params => {
            contexts.push(params); delivery.push('context');
            await contextReply?.();
            return {};
          };
          bridge.onmessage = async params => {
            messages.push(params); delivery.push('message');
            return messageReply?.() ?? {};
          };
        }
        bridge.oncalltool = async call => {
          calls.push(call);
          if (mode === 'defer') await new Promise(resolve => { release = resolve; deferred(); });
          if (mode === 'retention') return { isError: true, content: [{ type: 'text', text: 'Request logs for this plan are limited to the last 8 hours.' }] };
          if (mode === 'unavailable') return { isError: true, content: [{ type: 'text', text: '403 Access revoked' }] };
          if (mode === 'text') return { content: [{ type: 'text', text: '## Request logs (1)' }] };
          const { cursor, ...filters } = call.arguments;
          if (mode === 'empty') return result([], filters, null);
          if (cursor === 'opaque-log-page-2') return result([fixture.entries[0], { ...fixture.entries[0], requestId: 'request-next' }], filters, 'opaque-log-page-3');
          if (cursor === 'opaque-log-page-3') return result([fixture.entries[0]], filters, cursor);
          return result(scenario === 'chat' ? initial._meta.payload.entries : fixture.entries, filters);
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
        return { frame, doc, root, bridge, calls, copied, contexts, messages, delivery,
          contextReply(reply) { contextReply = reply; }, messageReply(reply) { messageReply = reply; },
          mode(value) { mode = value; },
          defer(callback) { mode = 'defer'; deferred = callback; }, release() { release(); } };
      }
      const role = (v, key) => v.root.querySelector('[data-role="' + key + '"]');
      const rows = v => v.root.querySelectorAll('.logs-row-toggle');
      const ticks = v => [...v.root.querySelectorAll('tbody input[type="checkbox"]')];
      function assertUnsupported(v) {
        const headers = [...v.root.querySelectorAll('th')];
        assert(headers.length === 8 && !headers.some(h => h.textContent === 'Select') && !ticks(v).length &&
          !role(v, 'chat') && !role(v, 'chat-bar') && !role(v, 'chat-host'), 'Unsupported host has selection controls');
      }
      async function click(v, key) {
        role(v, key).click();
        await until(v.doc, () => v.root.getAttribute('aria-busy') === 'false');
      }
      async function apply(v) {
        role(v, 'apply').click();
        await until(v.doc, () => v.root.getAttribute('aria-busy') === 'false');
      }
      async function checkChat() {
        const entries = [...fixture.entries, {
          ...fixture.entries[2], requestId: 'request-secret-fixture', sessionId: 'session-secret-1',
          url: 'https://example.test/login?token=SECRET123',
          message: 'Bearer abcdefgh12345678', endpoint: '<img src=x>'
        }];
        const filters = {
          apiKeyId: 'key-not-shared', requestId: 'filter-request-not-shared', limit: 30,
          url: 'https://example.test/login?filter=FILTERSECRET#test',
          endpoint: '/chromium/agent', levels: ['ERROR', 'WARN'], eventNames: ['request.failed', 'request.warning']
        };
        const caps = { serverTools: {}, message: { text: {} }, updateModelContext: { text: {} } };
        const initial = result(entries, filters);
        const v = await mount(initial, true, caps);
        const other = await mount(initial, true, caps);
        const button = role(v, 'chat');
        const firstHeader = v.root.querySelector('th');
        assert(firstHeader.textContent === 'Select' && firstHeader.getAttribute('role') === 'columnheader', 'Select column is missing');
        assert(button.disabled && button.textContent === 'Diagnose selected (0)', 'Chat action is enabled without selection');
        rows(v)[0].click();
        assert(button.disabled && v.root.querySelector('.logs-detail td').colSpan === 9, 'Expansion selected a row or spans the wrong number of columns');
        const noCalls = () => assert(!v.contexts.length && !v.messages.length, 'Sent to host before confirmation');
        ticks(v)[0].click(); ticks(v)[4].click();
        assert(!button.disabled && button.textContent === 'Diagnose selected (2)', 'Selection count is wrong');
        noCalls();
        button.click();
        const preview = role(v, 'chat-preview');
        assert(preview.querySelectorAll('li').length === 2 && !preview.querySelector('img, script, a'), 'Preview did not render two records as text');
        noCalls();
        role(v, 'chat-cancel').click();
        assert(!role(v, 'chat-preview'), 'Cancel left the preview visible');
        noCalls();
        const open = () => button.click();
        const send = () => role(v, 'chat-send').click();
        const status = (text) => until(v.doc, () => role(v, 'chat-status')?.textContent.includes(text));
        const contextText = index => v.contexts[index].content[0].text;
        const ids = index => JSON.parse(contextText(index).split(String.fromCharCode(10))[1]).records.map(r => r.requestId);
        open(); send(); await status('Sent to chat.');
        assert(v.delivery.join(',') === 'context,message', 'Host bridge did not receive exactly one context before the message');
        assert(ids(0).join(',') === 'request-success,request-secret-fixture', 'Sent records did not match the selection');
        for (const value of ['request-warning', 'SECRET123', 'abcdefgh12345678', 'session-secret-1', 'FILTERSECRET', 'key-not-shared', 'filter-request-not-shared', fixture.nextCursor])
          assert(!contextText(0).includes(value), 'Shared data outside the selection allowlist: ' + value);
        const payload = JSON.parse(contextText(0).split(String.fromCharCode(10))[1]);
        assert(payload.details.url === 'https://example.test/login' && payload.details.endpoint === '/chromium/agent' &&
          payload.details.levels === 'ERROR, WARN' && payload.details.eventNames === 'request.failed, request.warning' &&
          !('limit' in payload.details) && payload.records[1].url === 'https://example.test/login', 'Filter/URL allowlist is wrong');
        assert(v.messages[0].role === 'user' && v.messages[0].content.length === 1 &&
          v.messages[0].content[0].type === 'text' && v.messages[0].content[0].text === 'Diagnose the 2 request-log entries I selected in the Browserless log explorer.', 'Visible message is wrong');
        assert(!other.contexts.length && !other.messages.length && !ticks(other).some(box => box.checked), 'Selection escaped to a second widget instance');
        open(); ticks(v)[0].click(); ticks(v)[1].click();
        assert(!role(v, 'chat-preview'), 'Selection change left an old preview open');
        open(); send(); await status('Sent to chat.');
        assert(ids(1).join(',') === 'request-warning,request-secret-fixture', 'Second send used a stale selection');
        let entered, finish;
        const deferred = new Promise(resolve => { entered = resolve; });
        v.contextReply(() => new Promise(resolve => { finish = resolve; entered(); }));
        open(); send(); send(); await deferred;
        assert(v.contexts.length === 3 && v.messages.length === 2, 'Duplicate send or message before context completed');
        finish(); await status('Sent to chat.');
        assert(v.contexts.length === 3 && v.messages.length === 3, 'Double-click sent more than once');
        v.contextReply(() => { throw new Error('Context declined'); });
        open(); send(); await status('declined');
        assert(v.messages.length === 3, 'Sent a message after context rejection');
        for (const code of [ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed]) {
          v.contextReply(() => { throw new McpError(code, 'No response'); });
          open(); send(); await status('may already have been shared');
          assert(v.messages.length === 3, 'Sent a message after an uncertain context update');
        }
        await click(v, 'refresh');
        assert(ticks(v)[1].checked && ticks(v)[4].checked, 'Refresh lost selected rows');
        v.contextReply(undefined); v.messageReply(() => ({ isError: true }));
        open(); send(); await status('did not send the message');
        await click(v, 'refresh');
        assert(!button.disabled && role(v, 'error').hidden && v.calls.length === 2, 'Message rejection broke Refresh');
        open(); await click(v, 'more');
        assert(ticks(v).length === 6 && ticks(v)[1].checked && ticks(v)[4].checked && !role(v, 'chat-preview'), 'Paging lost selection or left a stale preview');
        const stale = new Promise(resolve => { entered = resolve; });
        v.contextReply(() => new Promise(resolve => { finish = resolve; entered(); }));
        const sent = v.messages.length;
        open(); send(); await stale;
        ticks(v)[5].click();
        finish();
        while (!role(v, 'chat-preview')) {
          open();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        assert(v.messages.length === sent, 'Sent a message for an invalidated preview');
        await click(v, 'refresh');
        assert(ticks(v).length === 5 && button.textContent === 'Diagnose selected (2)', 'Refresh did not prune a missing row');
        open(); v.mode('unavailable'); await click(v, 'refresh');
        assert(!role(v, 'chat-preview') && ticks(v).length === 0 && button.disabled, 'Revocation left sharing enabled');
        for (const view of [v, other]) { await view.bridge.teardownResource({}); view.frame.remove(); }

        const many = await mount(result(Array.from({ length: 26 }, (_, i) => ({ ...entries[0], requestId: 'request-' + i })), {}, null), true, caps);
        const boxes = ticks(many);
        for (const box of boxes.slice(0, 25)) box.click();
        assert(boxes[25].disabled && role(many, 'chat-limit').textContent === 'Selection limit reached (25).', 'Selection limit was not enforced');
        boxes[0].click();
        assert(!boxes[25].disabled && !role(many, 'chat-limit').textContent, 'Removing selection did not release the limit');
        await many.bridge.teardownResource({}); many.frame.remove();
        for (const partial of [{ serverTools: {} }, { serverTools: {}, message: { text: {} } }, { serverTools: {}, updateModelContext: { text: {} } }, { ...caps, message: { image: {} } }, { ...caps, updateModelContext: { image: {} } }]) {
          const unsupported = await mount(initial, true, partial);
          assertUnsupported(unsupported);
          await unsupported.bridge.teardownResource({}); unsupported.frame.remove();
        }
      }
      async function checkExplorer() {
        const v = await mount();
        const root = v.root;
        assertUnsupported(v);
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
        const inputEnter = new v.doc.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        form.elements.namedItem('endpoint').dispatchEvent(inputEnter);
        assert(inputEnter.defaultPrevented, 'Input Enter did not apply filters');
        await until(v.doc, () => v.root.getAttribute('aria-busy') === 'false');
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
        v.mode('text'); await click(v, 'refresh');
        assert(!role(v, 'error').hidden && role(v, 'error').textContent.includes('show these logs as text'), 'Text fallback omitted chat recovery guidance');
        assert(role(v, 'error').textContent.includes('narrow filters') && role(v, 'error').textContent.includes('entries per page'), 'Text fallback omitted large-page guidance');
        assert(rows(v).length === 4 && !role(v, 'retry').hidden && !role(v, 'refresh').disabled, 'Text fallback discarded the snapshot or disabled recovery');
        v.mode('default'); await click(v, 'retry');
        assert(role(v, 'error').hidden && rows(v).length === 4, 'Text fallback did not recover');
        const lightTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/New_York' }).format(new Date(fixture.entries[0].timestamp));
        v.frame.style.width = '350px';
        v.bridge.setHostContext({ theme: 'light', locale: 'en-US', timeZone: 'America/New_York', containerDimensions: { width: 350 } });
        await until(v.doc, () => rows(v)[0].textContent.includes(lightTime));
        assert(v.root.getBoundingClientRect().width <= 350, 'Narrow layout overflowed');
        assert(getComputedStyle(v.doc.documentElement).colorScheme.includes('light'), 'Host theme ignored');
        assert(v.root === root && document.querySelectorAll('iframe').length === 1, 'Updates remounted widget');
        const textareaEnter = new v.doc.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        form.elements.namedItem('eventNames').dispatchEvent(textareaEnter);
        assert(!textareaEnter.defaultPrevented, 'Textarea Enter was swallowed');
        const clearEnter = new v.doc.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        role(v, 'clear').dispatchEvent(clearEnter);
        assert(!clearEnter.defaultPrevented, 'Clear filters Enter activation was swallowed');
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
      }
      try {
        if (scenario === 'chat') await checkChat();
        else await checkExplorer();
        document.querySelector('pre').textContent = 'PASS: ' + scenario;
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
        `PASS: ${scenario}`,
      );
    } finally {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  }

  (chrome ? it : it.skip)(
    'renders and filters safely, pages without duplicates, respects host context and handles terminal states',
    function () {
      return run.call(this, 'explorer');
    },
  );
  (chrome ? it : it.skip)(
    'shares only confirmed selected rows on hosts with both chat capabilities',
    function () {
      return run.call(this, 'chat');
    },
  );
});
