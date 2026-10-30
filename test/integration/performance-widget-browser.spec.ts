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
import { registerPerformanceWidget } from '../../src/resources/view-widget.js';

// Uses an installed Chromium without adding a browser automation dependency.
const chrome =
  process.env.CHROME_PATH ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((path) => existsSync(path));

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
