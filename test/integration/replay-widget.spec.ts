import { expect } from 'chai';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getConfig } from '../../src/config.js';
import { registerSurface } from '../../src/tools/register.js';
import { replayViews, VIEW_UNAVAILABLE } from '../../src/lib/view-store.js';
import { VIEW_URI, ShowOutputSchema } from '../../src/lib/view-schemas.js';
import { PERFORMANCE_URI } from '../../src/lib/performance-summary.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/replay-widget.json', 'utf8'),
);
const uiCapabilities = {
  extensions: {
    'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
  },
};

describe('production replay tools over real MCP HTTP', () => {
  it('prepares without UI, renders without refetch, scopes by verified caller, and rechecks source access', async () => {
    let downloads = 0,
      accessChecks = 0,
      revoked = false,
      deleted = false;
    const backend = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/recording') {
        downloads++;
        response.end(JSON.stringify(fixture));
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk;
      const { query, variables } = JSON.parse(body);
      if (query.includes('ReplayViewAccess')) accessChecks++;
      response.end(
        JSON.stringify({
          data: {
            sessionReplayBySessionId:
              variables.apiToken === 'account-key' &&
              !revoked &&
              !deleted &&
              variables.sessionId === fixture.sessionId
                ? {
                    sessionId: fixture.sessionId,
                    website: fixture.website,
                    url: `http://127.0.0.1:${(backend.address() as AddressInfo).port}/recording`,
                  }
                : null,
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, '127.0.0.1', resolve),
    );
    const base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
    const reserve = createServer();
    await new Promise<void>((resolve) =>
      reserve.listen(0, '127.0.0.1', resolve),
    );
    const port = (reserve.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const server = new FastMCP({
      name: 'production-replay-test',
      version: '1.0.0',
      authenticate: async (request) => ({
        token: 'account-key',
        apiUrl: base,
        authMethod: 'oauth',
        accountId: 'shared-account',
        userId: request.headers.authorization?.slice(7) ?? 'alice',
      }),
    });
    const config = {
      ...getConfig(),
      browserlessToken: undefined,
      browserlessApiUrl: base,
      apiServerUrl: base,
      transport: 'httpStream' as const,
      complianceMode: false,
      analyticsEnabled: false,
      maxRetries: 0,
    };
    registerSurface(server, config);
    const clients: Client[] = [];
    const connect = async (owner = 'alice', ui = true) => {
      const client = new Client(
        { name: 'replay-host', version: '1.0.0' },
        { capabilities: ui ? uiCapabilities : {} },
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
          { requestInit: { headers: { Authorization: `Bearer ${owner}` } } },
        ),
      );
      return client;
    };
    try {
      await server.start({
        transportType: 'httpStream',
        httpStream: { host: '127.0.0.1', port },
      });
      const alice = await connect();
      const tools = (await alice.listTools()).tools;
      expect(
        tools
          .filter(
            (tool) =>
              tool._meta?.ui &&
              (tool._meta.ui as { resourceUri?: string }).resourceUri,
          )
          .map((tool) => tool.name),
      ).to.deep.equal(['browserless_show', 'browserless_performance']);
      expect(
        tools.find((tool) => tool.name === 'browserless_sessions')!._meta,
      ).to.equal(undefined);
      expect(
        tools.find((tool) => tool.name === 'browserless_sessions'),
      ).not.to.have.property('outputSchema');
      expect(
        tools.find((tool) => tool.name === 'browserless_view_data')!._meta,
      ).to.deep.include({ ui: { visibility: ['app'] } });
      expect(VIEW_URI).to.equal('ui://browserless/view/v9.html');
      expect(
        tools.find((tool) => tool.name === 'browserless_show')!._meta,
      ).to.deep.include({
        ui: { resourceUri: VIEW_URI },
        'openai/outputTemplate': VIEW_URI,
      });
      const resource = (await alice.readResource({ uri: VIEW_URI }))
        .contents[0];
      expect(resource.mimeType).to.equal('text/html;profile=mcp-app');
      for (let version = 1; version <= 8; version++) {
        const legacy = (
          await alice.readResource({
            uri: `ui://browserless/view/v${version}.html`,
          })
        ).contents[0];
        expect(legacy.mimeType).to.equal(resource.mimeType);
        expect('text' in legacy && legacy.text).to.equal(
          'text' in resource && resource.text,
        );
      }
      expect(resource._meta).to.have.property('ui');
      expect('text' in resource && resource.text).to.include('Replay timeline');
      const prepared = await alice.callTool({
        name: 'browserless_sessions',
        arguments: { action: 'replay', sessionId: fixture.sessionId },
      });
      expect(prepared.isError).not.to.equal(true);
      const viewRef = ShowOutputSchema.parse(
        prepared.structuredContent,
      ).viewRef;
      expect(prepared._meta).to.equal(undefined);
      expect(prepared.structuredContent).to.include({ kind: 'replay' });
      // Hosts that expose only text to the model still need the exact reference.
      const modelText = (
        prepared.content as Array<{ type: string; text?: string }>
      )
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      const textViewRef = modelText.match(/view_[0-9a-f-]+/)?.[0];
      expect(textViewRef).to.equal(viewRef);
      expect(JSON.stringify(prepared)).not.to.include('Step 1: Opened page');
      expect(JSON.stringify(prepared)).not.to.include('account-key');
      expect(
        (prepared.content as Array<{ type: string }>).every(
          (item) => item.type === 'text',
        ),
      ).to.equal(true);
      expect(downloads).to.equal(1);
      const shown = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef: textViewRef },
      });
      expect(
        (shown._meta!.payload as { events: unknown[] }).events,
      ).to.deep.equal(fixture.events);
      expect(downloads).to.equal(1);
      expect(accessChecks).to.equal(1);
      const compressed = await alice.callTool({
        name: 'browserless_view_data',
        arguments: { viewRef, encoding: 'gzip' },
      });
      expect(compressed.isError).not.to.equal(true);
      expect(compressed.structuredContent).to.deep.equal({ complete: true });
      expect(compressed._meta!.encoding).to.equal('base64-gzip-json');
      expect(
        JSON.parse(
          gunzipSync(
            Buffer.from(compressed._meta!.data as string, 'base64'),
          ).toString('utf8'),
        ).events,
      ).to.deep.equal(fixture.events);
      expect(downloads).to.equal(1);
      const bob = await connect('bob');
      const denied = await bob.callTool({
        name: 'browserless_show',
        arguments: { viewRef },
      });
      expect(denied.isError).to.equal(true);
      expect(JSON.stringify(denied)).to.include(VIEW_UNAVAILABLE);
      const readerDenied = await bob.callTool({
        name: 'browserless_view_data',
        arguments: { viewRef },
      });
      expect(readerDenied.isError).to.equal(true);
      const reconnected = await connect();
      expect(
        (
          await reconnected.callTool({
            name: 'browserless_show',
            arguments: { viewRef },
          })
        ).isError,
      ).not.to.equal(true);
      const noUi = await connect('alice', false);
      const textResult = await noUi.callTool({
        name: 'browserless_show',
        arguments: { viewRef },
      });
      expect(
        (textResult.content as Array<{ text: string }>)[0].text,
      ).to.include('Session replay');
      revoked = true;
      const revokedResult = await alice.callTool({
        name: 'browserless_view_data',
        arguments: { viewRef },
      });
      expect(revokedResult.isError).to.equal(true);
      expect(JSON.stringify(revokedResult)).to.include(VIEW_UNAVAILABLE);
      revoked = false;
      deleted = true;
      const deletedResult = await alice.callTool({
        name: 'browserless_show',
        arguments: { viewRef },
      });
      expect(deletedResult.isError).to.equal(true);
      expect(deletedResult.content).to.deep.equal(denied.content);
      expect(downloads).to.equal(1);
      deleted = false;
      const dir = await mkdtemp(join(tmpdir(), 'replay-fallback-test-'));
      const previousDir = process.env.BROWSERLESS_DOWNLOAD_DIR;
      try {
        const blocked = join(dir, 'file');
        await writeFile(blocked, 'Not a directory');
        process.env.BROWSERLESS_DOWNLOAD_DIR = blocked;
        const fallbackFailure = await alice.callTool({
          name: 'browserless_sessions',
          arguments: { action: 'replay', sessionId: fixture.sessionId },
        });
        expect(fallbackFailure.isError).not.to.equal(true);
        expect(
          ShowOutputSchema.parse(fallbackFailure.structuredContent).viewRef,
        ).to.be.a('string');
        expect(JSON.stringify(fallbackFailure.content)).to.include(
          'offline downloads are unavailable',
        );
      } finally {
        if (previousDir === undefined)
          delete process.env.BROWSERLESS_DOWNLOAD_DIR;
        else process.env.BROWSERLESS_DOWNLOAD_DIR = previousDir;
        await rm(dir, { recursive: true, force: true });
      }
      // Both unsupported clients and failed view preparation retain legacy output.
      replayViews.clear();
      for (let index = 0; index < 16; index++)
        replayViews.prepare('another-owner', fixture);
      for (const client of [noUi, alice]) {
        const legacy = await client.callTool({
          name: 'browserless_sessions',
          arguments: { action: 'replay', sessionId: fixture.sessionId },
        });
        expect(legacy.isError).not.to.equal(true);
        expect(legacy).not.to.have.property('structuredContent');
        expect(legacy.content).to.satisfy((blocks: Array<{ type: string }>) =>
          blocks.some((block) => block.type === 'resource'),
        );
        expect(JSON.stringify(legacy.content)).to.include(
          'never rebuild the player',
        );
      }
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await server.stop();
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      replayViews.clear();
    }
  });

  it('keeps replay presentation off the compliant surface', () => {
    const server = new FastMCP({
      name: 'compliant-replay-test',
      version: '1.0.0',
    });
    const tools: string[] = [],
      resources: string[] = [];
    const addTool = server.addTool.bind(server),
      addResource = server.addResource.bind(server);
    server.addTool = (tool) => {
      tools.push(tool.name);
      return addTool(tool);
    };
    server.addResource = (resource) => {
      resources.push(resource.uri);
      return addResource(resource);
    };
    registerSurface(server, { ...getConfig(), complianceMode: true });
    expect(tools).not.to.include('browserless_show');
    expect(tools).not.to.include('browserless_view_data');
    expect(resources).not.to.include(VIEW_URI);
    expect(resources).to.deep.equal([PERFORMANCE_URI]);
  });
});
