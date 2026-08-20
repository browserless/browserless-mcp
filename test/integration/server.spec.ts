import { expect } from 'chai';
import sinon from 'sinon';
import { createServer } from 'node:net';
import { FastMCP } from 'fastmcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerSmartScraperTool } from '../../src/tools/smartscraper.js';
import { registerApiDocsResource } from '../../src/resources/api-docs.js';
import { registerStatusResource } from '../../src/resources/status.js';
import { registerScrapeUrlPrompt } from '../../src/prompts/scrape-url.js';
import { registerExtractContentPrompt } from '../../src/prompts/extract-content.js';
import type { McpConfig } from '../../src/@types/types.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'httpStream',
  port: 0, // let OS pick a port
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
  analyticsEnabled: false,
  complianceMode: false,
  sqsRegion: 'us-east-1',
  oauthEnabled: false,
  supabaseUrl: '',
  supabaseOAuthClientId: '',
  supabaseOAuthClientSecret: '',
  supabaseServiceRoleKey: '',
  mcpBaseUrl: '',
  oauthAllowedRedirectUriPatterns: [],
};

describe('MCP Server Integration', () => {
  let server: FastMCP;

  afterEach(async () => {
    sinon.restore();
  });

  it('creates a fully configured server with all components', () => {
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });

    registerSmartScraperTool(server, mockConfig);
    registerApiDocsResource(server, mockConfig);
    registerStatusResource(server, mockConfig);
    registerScrapeUrlPrompt(server);
    registerExtractContentPrompt(server);

    // If we get here without errors, the server is properly configured
    expect(server).to.exist;
  });

  it('starts and stops cleanly in httpStream mode', async () => {
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });
    registerSmartScraperTool(server, mockConfig);

    await server.start({
      transportType: 'httpStream',
      httpStream: { port: 0 },
    });

    // Server should be running
    expect(server.serverState).to.equal('running');

    await server.stop();
    expect(server.serverState).to.equal('stopped');
  });

  // patches/fastmcp+4.4.0.patch makes it `{ listChanged: true }`. Fails if a bump drops it.
  it('advertises tools.listChanged so clients auto-refresh the tool list', async () => {
    const port = await freePort();
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });
    registerSmartScraperTool(server, mockConfig);
    await server.start({ transportType: 'httpStream', httpStream: { port } });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${port}/mcp`),
    );
    try {
      await client.connect(transport);
      const caps = client.getServerCapabilities();
      expect(caps?.tools).to.deep.include({ listChanged: true });
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
