import { FastMCP } from 'fastmcp';
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerProbeTools } from './tools.mjs';

export async function startProbe({ port = 8790, now, ttlMs } = {}) {
  const files = {};
  for (const name of ['widget', 'host']) {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url))],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      outfile: `${name}.js`,
      write: false,
    });
    files[name] = result.outputFiles.find((file) =>
      file.path.endsWith('.js'),
    ).text;
    if (name === 'widget') {
      const css = result.outputFiles.find((file) =>
        file.path.endsWith('.css'),
      ).text;
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}body{margin:16px;font:14px system-ui}button,select{font:inherit;padding:8px}#status{overflow-wrap:anywhere}.rr-player{box-shadow:none}</style></head><body><p id="status" role="status">Waiting for result…</p><div id="view"></div><script type="module">${files[name].replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
      files.widgetHtml = html;
      await writeFile(new URL('./widget.html', import.meta.url), html);
    }
  }
  const server = new FastMCP({
    name: 'Browserless Widget API Probe',
    version: '0.1.2',
    instructions:
      'Synthetic widget API test. Prepare a result with a widget_probe_* tool, then pass its exact viewRef to browserless_show to display it. Producers never render UI. Use large:true on widget_probe_replay to test chunk loading. Usage and sessions widgets have controls that call data tools directly. No production account or browser services are available.',
    authenticate: async (request) => {
      const token =
        request.headers.authorization?.replace(/^Bearer /, '') ??
        new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get(
          'token',
        );
      return ['local-alice', 'local-bob'].includes(token)
        ? { token }
        : undefined;
    },
  });
  const state = registerProbeTools(server, { now, ttlMs });
  const app = server.getApp();
  app.get('/favicon.ico', (c) => c.body(null, 204));
  app.get('/probe', (c) =>
    c.html(
      `<!doctype html><html><head><title>Local MCP widget API probe</title><style>body{font:16px system-ui;margin:24px}button{padding:8px;margin:4px}iframe{width:min(100%,1024px);height:600px;border:1px solid #ccc}</style></head><body><h1>Local MCP widget API probe</h1><p>Synthetic data. Real MCP transport and official AppBridge. Widget CSP enforced.</p><div>${[
        ['Replay', 'widget_probe_replay'],
        ['Sessions', 'widget_probe_sessions'],
        ['Usage', 'widget_probe_usage'],
        ['Scorecard', 'widget_probe_performance'],
      ]
        .map(([label, name]) => `<button data-tool="${name}">${label}</button>`)
        .join(
          '',
        )}<button data-tool="widget_probe_replay" data-large="true">Chunked replay</button></div><p id="host-status">Choose a producer.</p><div id="mount"></div><script type="module" src="/probe/host.js"></script></body></html>`,
    ),
  );
  app.get('/probe/host.js', (c) =>
    c.body(files.host, 200, { 'Content-Type': 'text/javascript' }),
  );
  app.get('/probe/widget', (c) => {
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-src 'none'; connect-src 'none'",
    );
    return c.html(files.widgetHtml);
  });
  app.get('/probe/stats', (c) => c.json(state.stats));
  await server.start({
    transportType: 'httpStream',
    httpStream: { host: '127.0.0.1', port },
  });
  return { server, state, stop: () => server.stop() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8790);
  const probe = await startProbe({ port });
  console.log(`Local host: http://127.0.0.1:${port}/probe`);
  console.log(
    `MCP endpoint: http://127.0.0.1:${port}/mcp (synthetic Bearer local-alice or local-bob)`,
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await probe.stop();
      process.exit(0);
    });
}
