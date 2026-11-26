import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const chrome =
  process.env.CHROME_PATH ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((path) => existsSync(path));

/**
 * Script prepended to a host bundle. `report(text)` shows the outcome on the page
 * and posts it back to the test, so the test waits for the script to finish
 * instead of guessing when Chrome's --dump-dom snapshot is taken.
 */
export const REPORT_SCRIPT = `
  const report = text => {
    document.querySelector('pre').textContent = text;
    return fetch('/result', { method: 'POST', body: text });
  };
`;

interface HostPage {
  /** Serves every path other than /result; `/` must load a page that calls report(). */
  route(url: string, response: ServerResponse): void;
  /** Milliseconds to wait for report() before failing. */
  timeout: number;
  /** Extra Chrome flags, for example a screenshot capture. */
  args?: string[];
}

/** Opens the host page in headless Chrome and resolves with the text it reports. */
export async function runHostPage({ route, timeout, args = [] }: HostPage) {
  let settle!: (text: string) => void;
  const reported = new Promise<string>((resolve) => (settle = resolve));
  const http = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/result') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        response.end();
        settle(body);
      });
    } else route(request.url ?? '/', response);
  });
  const directory = await mkdtemp(join(tmpdir(), 'widget-browser-'));
  let stderr = '';
  let browser: ReturnType<typeof spawn> | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    browser = spawn(
      chrome!,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${directory}`,
        ...args,
        `http://127.0.0.1:${(http.address() as AddressInfo).port}/`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    browser.stderr!.on('data', (chunk) => (stderr += chunk));
    // Chrome exits by itself after --screenshot; give an in-flight report a moment to land.
    const exited = new Promise<never>((_, reject) =>
      browser!.once('exit', (code, signal) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Chrome exited (${signal ?? code}) before the page reported a result\n${stderr}`,
              ),
            ),
          500,
        ),
      ),
    );
    exited.catch(() => {}); // Also fires when we kill Chrome after a result.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Page did not report a result within ${timeout}ms\n${stderr}`,
            ),
          ),
        timeout,
      );
    });
    const text = await Promise.race([reported, exited, timedOut]);
    // A --screenshot run captures after its virtual time budget; let it finish.
    if (args.some((arg) => arg.startsWith('--screenshot='))) {
      await Promise.race([
        new Promise((resolve) => {
          if (browser!.exitCode !== null || browser!.signalCode !== null)
            resolve(undefined);
          else browser!.once('exit', resolve);
        }),
        timedOut,
      ]);
    }
    return text;
  } finally {
    clearTimeout(timer);
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const closed = new Promise((resolve) => browser!.once('exit', resolve));
      browser.kill('SIGKILL');
      await closed;
    }
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
