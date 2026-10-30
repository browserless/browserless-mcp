import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Development runner: MCP and Live URL traffic share one ngrok origin.
const root = fileURLToPath(new URL('..', import.meta.url));
const backend = new URL(
  process.env.BROWSERLESS_API_URL ?? 'http://localhost:5555',
);
if (
  backend.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(backend.hostname) ||
  backend.username ||
  backend.password ||
  backend.search ||
  backend.hash ||
  backend.pathname !== '/'
)
  throw Error(
    'BROWSERLESS_API_URL must be a loopback HTTP origin for the local Docker instance.',
  );
if (!process.env.BROWSERLESS_TOKEN)
  throw Error('Export BROWSERLESS_TOKEN for the Docker instance first.');
const publicOrigin = new URL(
  process.env.BROWSERLESS_PUBLIC_URL ??
    process.env.MCP_BASE_URL ??
    `http://localhost:${process.env.PORT ?? 8080}`,
);
if (
  publicOrigin.username ||
  publicOrigin.password ||
  publicOrigin.search ||
  publicOrigin.hash ||
  publicOrigin.pathname !== '/' ||
  (publicOrigin.protocol !== 'https:' &&
    !(
      publicOrigin.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(publicOrigin.hostname)
    ))
)
  throw Error(
    'BROWSERLESS_PUBLIC_URL must be an HTTPS origin, or a loopback HTTP origin for local testing.',
  );
const config = {
  gatewayPort: Number(process.env.PORT ?? 8080),
  mcpPort: Number(process.env.MCP_INTERNAL_PORT ?? 8088),
  backendPort: Number(backend.port || 80),
};
if (
  ![config.gatewayPort, config.mcpPort].every(
    (port) => Number.isInteger(port) && port > 0 && port < 65536,
  ) ||
  config.gatewayPort === config.mcpPort
)
  throw Error('PORT and MCP_INTERNAL_PORT must be different valid TCP ports.');
const backendRoute = (path) =>
  /^\/(?:live(?:\/|$)|(?:chromium|chrome)\/live(?:\/|$))/.test(path);
const server = http.createServer(async (request, response) => {
  response.shouldKeepAlive = false;
  const url = new URL(request.url, 'http://gateway');
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  const port = backendRoute(url.pathname) ? config.backendPort : config.mcpPort;
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, connection: 'close' },
      agent: false,
    },
    (reply) => {
      response.writeHead(reply.statusCode, {
        ...reply.headers,
        connection: 'close',
      });
      reply.on('error', () => response.destroy());
      reply.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    console.error(
      JSON.stringify({
        event: 'upstream-error',
        code: error.code ?? 'UNKNOWN',
        port,
      }),
    );
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(502, {
      'content-type': 'text/plain',
      connection: 'close',
    });
    response.end('Local test service unavailable');
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => {
    if (!response.writableFinished) upstream.destroy();
  });
  request.pipe(upstream);
});
server.on('upgrade', (request, socket, head) => {
  const path = new URL(request.url, 'http://gateway').pathname;
  const upstream = http.request({
    host: '127.0.0.1',
    port: backendRoute(path) ? config.backendPort : config.mcpPort,
    path: request.url,
    method: request.method,
    headers: request.headers,
  });
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('upgrade', (reply, remote, remoteHead) => {
    if (socket.destroyed) {
      remote.destroy();
      return;
    }
    socket.on('error', () => remote.destroy());
    socket.on('close', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.setTimeout(0);
    remote.setTimeout(0);
    socket.write(
      `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n` +
        Object.entries(reply.headers)
          .map(
            ([key, value]) =>
              `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`,
          )
          .join('') +
        '\r\n',
    );
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
  });
  upstream.on('response', (reply) => {
    reply.on('error', () => socket.destroy());
    socket.on('close', () => reply.destroy());
    if (socket.destroyed) {
      reply.destroy();
      return;
    }
    socket.write(
      `HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\nConnection: close\r\n\r\n`,
    );
    reply.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});
server.on('connection', (socket) =>
  socket.on('error', (error) =>
    console.error(
      JSON.stringify({
        event: 'client-socket-error',
        code: error.code ?? 'UNKNOWN',
      }),
    ),
  ),
);
server.on('clientError', (error, socket) => {
  console.error(
    JSON.stringify({ event: 'client-error', code: error.code ?? 'UNKNOWN' }),
  );
  socket.end(
    'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
  );
});
let child;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  child?.kill('SIGTERM');
  server.close();
  server.closeAllConnections();
  const timer = setTimeout(() => {
    child?.kill('SIGKILL');
    process.exit(code);
  }, 3000);
  timer.unref();
  if (!child || child.exitCode !== null) process.exit(code);
  else child.once('exit', () => process.exit(code));
}
server.on('error', (error) => {
  console.error(error.message);
  stop(1);
});
server.listen(config.gatewayPort, '127.0.0.1', () => {
  child = spawn(process.execPath, [root + 'build/src/index.js'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      TRANSPORT: 'httpStream',
      PORT: String(config.mcpPort),
      BROWSERLESS_API_URL: backend.origin,
      BROWSERLESS_PUBLIC_URL: publicOrigin.origin,
      MCP_BASE_URL: publicOrigin.origin,
      OAUTH_ENABLED: 'false',
      MCP_COMPLIANCE_MODE: 'false',
      ANALYTICS_ENABLED: 'false',
      AMPLITUDE_API_KEY: '',
      OTEL_ENABLED: 'false',
    },
  });
  child.once('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
  console.log(
    'Local gateway: http://127.0.0.1:' +
      config.gatewayPort +
      ' (Docker backend ' +
      backend.origin +
      ')',
  );
  console.log(
    'ChatGPT MCP: ' + publicOrigin.origin + '/mcp?token=<BROWSERLESS_TOKEN>',
  );
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop());
