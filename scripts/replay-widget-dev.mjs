// Synthetic backend only. No account credentials or production browser service.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { FastMCP } from 'fastmcp';
import { getConfig } from '../build/src/config.js';
import { registerSessionsTool } from '../build/src/tools/sessions.js';
import { registerReplayWidget } from '../build/src/resources/replay-widget.js';

const artifact = JSON.parse(
  await readFile(
    new URL('../test/fixtures/replay-widget.json', import.meta.url),
    'utf8',
  ),
);
const port = Number(process.env.PORT ?? 8787);
const backend = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/recording.json') {
    response.end(JSON.stringify(artifact));
    return;
  }
  if (request.url !== '/graphql' || request.method !== 'POST') {
    response.writeHead(404).end('{}');
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const { query, variables } = JSON.parse(body);
  const entry = {
    sessionId: artifact.sessionId,
    website: artifact.website,
    timestamp: artifact.timestamp,
    duration: 12000,
    eventCount: artifact.events.length,
  };
  let data;
  if (query.includes('sessionReplayBySessionId')) {
    data = {
      sessionReplayBySessionId:
        variables.sessionId === artifact.sessionId
          ? {
              ...entry,
              url: `http://127.0.0.1:${backend.address().port}/recording.json`,
            }
          : null,
    };
  } else if (query.includes('sessionReplayList')) {
    data = {
      sessionReplayList: {
        data: [entry],
        totalCount: 1,
        page: 1,
        totalPages: 1,
      },
    };
  } else if (query.includes('getActiveSession')) {
    data = { getActiveSession: { sessions: [], count: 0 } };
  } else if (query.includes('getPersistentSessions')) {
    data = { getPersistentSessions: { sessions: [], count: 0 } };
  } else {
    data = { listOnePasswordIntegrations: [] };
  }
  response.end(JSON.stringify({ data }));
});
await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
const server = new FastMCP({
  name: 'Browserless Replay Widget Demo',
  version: '0.1.0',
  instructions:
    'This is a synthetic session replay demo. Call browserless_sessions action replay with sessionId replay-widget-demo to show the inline replay. No real account data is available.',
});
const config = {
  ...getConfig(),
  browserlessToken: 'synthetic-replay-widget',
  browserlessApiUrl: `http://127.0.0.1:${backend.address().port}`,
  apiServerUrl: `http://127.0.0.1:${backend.address().port}`,
  transport: 'httpStream',
  port,
  complianceMode: true,
  analyticsEnabled: false,
  maxRetries: 0,
};
registerSessionsTool(server, config);
registerReplayWidget(server);
server.on('connect', ({ session }) => {
  console.log(
    'MCP client connected',
    session.clientCapabilities
      ? JSON.stringify(session.clientCapabilities)
      : 'initializing',
  );
});
await server.start({
  transportType: 'httpStream',
  httpStream: { port, host: '127.0.0.1' },
});
console.log(`Replay demo ready: http://127.0.0.1:${port}/mcp`);
console.log('Synthetic sessionId: replay-widget-demo; authentication: none');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await server.stop();
    backend.close();
    process.exit(0);
  });
