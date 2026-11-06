import { expect } from 'chai';
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

describe('handoff widget browser rendering', () => {
  (chrome ? it : it.skip)(
    'renders worker-routed viewers and keeps invalid handoffs out of replay UI',
    async function () {
      this.timeout(25000);
      const server = new FastMCP({ name: 'handoff-browser', version: '1.0.0' });
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
            try {
              for (const path of ['/live/index.html', '/e/53616c7465645f5fabcd/live/index.html', '/e/not-hex/live/index.html']) {
                const valid = !path.includes('not-hex');
                const frame = document.createElement('iframe');
                frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
                document.body.append(frame);
                const bridge = new AppBridge(null, { name: 'Browser check', version: '1.0.0' }, {});
                const ready = new Promise(resolve => { bridge.oninitialized = resolve; });
                await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
                frame.src = '/widget';
                await ready;
                const settled = new Promise(resolve => {
                  const observer = new MutationObserver(() => {
                    const doc = frame.contentDocument;
                    if (!doc.querySelector('#handoff').hidden || doc.querySelector('.empty[data-error]')) {
                      observer.disconnect(); resolve();
                    }
                  });
                  observer.observe(frame.contentDocument.body, { subtree: true, childList: true, attributes: true });
                });
                const expiresAt = Date.now() + 60000;
                await bridge.sendToolResult({
                  content: [{ type: 'text', text: 'Complete the human step.' }],
                  structuredContent: {
                    viewRef: 'view-browser-test', kind: 'handoff', summary: 'Human input needed',
                    expiresAt: new Date(expiresAt).toISOString(),
                    data: { sessionId: 's:browser-test', instructions: 'Complete the human step.' }
                  },
                  _meta: { payload: {
                    liveURL: location.origin + path + '?i=synthetic-live',
                    state: { status: 'open', reason: null, interactable: true, viewerCount: 0, expiresAt }
                  } }
                });
                await settled;
                const doc = frame.contentDocument;
                const root = doc.querySelector('#handoff');
                if (root.hidden || !doc.querySelector('.replay-card').hidden)
                  throw new Error('Handoff displayed replay UI for ' + path);
                if (valid) {
                  const viewer = root.querySelector('iframe');
                  if (new URL(viewer.src).pathname !== path)
                    throw new Error('Viewer routing prefix was lost');
                  if (!viewer.contentDocument?.querySelector('#viewer-ready'))
                    await new Promise(resolve => viewer.addEventListener('load', resolve, { once: true }));
                  if (!viewer.contentDocument?.querySelector('#viewer-ready'))
                    throw new Error('Embedded viewer did not load');
                  if (root.querySelector('[data-role="status"]').textContent !== 'Waiting for you')
                    throw new Error('Missing handoff status');
                } else {
                  if (!root.textContent.includes('Invalid handoff viewer.'))
                    throw new Error('Original validation error was lost');
                  if (root.querySelector('iframe[src]'))
                    throw new Error('Invalid viewer was embedded');
                }
                await bridge.teardownResource({});
                frame.remove();
              }
              output.textContent = 'PASS: direct and routed handoffs, invalid viewer recovery';
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
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'",
          );
          response.end(resource.text);
        } else if (request.url === '/host.js') {
          response.setHeader('content-type', 'text/javascript');
          response.end(host.outputFiles[0].text);
        } else if (request.url?.includes('/live/index.html')) {
          response.setHeader('content-type', 'text/html');
          response.end(
            '<!doctype html><p id="viewer-ready">Synthetic live viewer</p>',
          );
        } else {
          response.setHeader('content-type', 'text/html');
          response.end(
            '<!doctype html><pre>Waiting</pre><script type="module" src="/host.js"></script>',
          );
        }
      });
      const directory = await mkdtemp(join(tmpdir(), 'handoff-browser-'));
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
        expect(/<pre>([\s\S]*?)<\/pre>/.exec(stdout)?.[1]).to.equal(
          'PASS: direct and routed handoffs, invalid viewer recovery',
        );
      } finally {
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
