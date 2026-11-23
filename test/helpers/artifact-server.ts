import { createServer } from 'node:http';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrowserlessSession, McpConfig } from '../../src/@types/types.js';
import { resolveBrowserlessRequestAuth } from '../../src/lib/http-auth.js';
import {
  admitSessionRequest,
  requestSessionId,
} from '../../src/lib/session-binding.js';
import { clearSession } from '../../src/lib/download-store.js';
import { BoundedEventStore } from '../../src/lib/bounded-event-store.js';
import { registerSurface } from '../../src/tools/register.js';
import { registerDownloadRoute } from '../../src/resources/download-route.js';

/** Real MCP surface and admission stack; only the upstream vendor is local. */
export async function artifactServer(complianceMode = false) {
  let reply: { mimeType: string; data: Buffer } = {
    mimeType: 'application/pdf',
    data: Buffer.from('%PDF-fixture-private'),
  };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.url === '/active') {
      res.writeHead(
        req.headers.authorization?.startsWith('Bearer fixture-') ? 200 : 401,
      );
      res.end('Invalid API key');
    } else {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url ?? '', body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': reply.mimeType });
      res.end(reply.data);
    }
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, '127.0.0.1', resolve),
  );
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: McpConfig = {
    browserlessToken: 'fixture-server-token-must-not-authorize-resources',
    browserlessApiUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    transport: 'httpStream',
    port,
    requestTimeout: 3000,
    maxRetries: 0,
    cacheTtlMs: 60000,
    analyticsEnabled: false,
    complianceMode,
    sqsRegion: 'us-east-1',
    oauthEnabled: false,
    oauthRegisterRateLimitPerHour: 300,
    supabaseUrl: '',
    supabaseOAuthClientId: '',
    supabaseOAuthClientSecret: '',
    supabaseServiceRoleKey: '',
    mcpBaseUrl: baseUrl,
    oauthAllowedRedirectUriPatterns: [],
  };
  const server = new FastMCP<BrowserlessSession>({
    name: 'artifact-integration',
    version: '1.0.0',
    authenticate: async (request) => {
      const auth = await resolveBrowserlessRequestAuth(request, config);
      admitSessionRequest(requestSessionId(request), auth, server.sessions);
      return auth;
    },
  });
  registerSurface(server, config);
  registerDownloadRoute(server, config);
  const eventStore = new BoundedEventStore();
  await server.start({
    transportType: 'httpStream',
    httpStream: { host: '127.0.0.1', port, eventStore },
  });
  const clients: Client[] = [];
  return {
    server,
    config,
    baseUrl,
    eventStore,
    requests,
    reply: (mimeType: string, data: Buffer) => {
      reply = { mimeType, data };
    },
    connect: async (token = 'fixture-owner', native = true) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
      if (native) headers['x-browserless-artifact-delivery'] = 'mcp-resource';
      const client = new Client({ name: 'artifact-test', version: '1' });
      const transport = new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/mcp`),
        { requestInit: { headers } },
      );
      clients.push(client);
      await client.connect(transport);
      return { client, transport, headers };
    },
    close: async () => {
      for (const client of clients) await client.close();
      for (const session of [...server.sessions]) {
        clearSession(session.sessionId);
        await session.close();
      }
      await server.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}
