import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import { registerPowerScraperTool } from '../../src/tools/smartscraper.js';
import { registerApiDocsResource } from '../../src/resources/api-docs.js';
import { registerStatusResource } from '../../src/resources/status.js';
import { registerScrapeUrlPrompt } from '../../src/prompts/scrape-url.js';
import { registerExtractContentPrompt } from '../../src/prompts/extract-content.js';
import type { McpConfig } from '../../src/config.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'httpStream',
  port: 0, // let OS pick a port
  requestTimeout: 30000,
  maxRetries: 0,
  cacheTtlMs: 0,
  analyticsEnabled: false,
  sqsRegion: 'us-east-1',
  oauthEnabled: false,
  supabaseUrl: '',
  supabaseOAuthClientId: '',
  supabaseOAuthClientSecret: '',
  supabaseServiceRoleKey: '',
  mcpBaseUrl: '',
};

describe('MCP Server Integration', () => {
  let server: FastMCP;

  afterEach(async () => {
    sinon.restore();
  });

  it('creates a fully configured server with all components', () => {
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });

    registerPowerScraperTool(server, mockConfig);
    registerApiDocsResource(server, mockConfig);
    registerStatusResource(server, mockConfig);
    registerScrapeUrlPrompt(server);
    registerExtractContentPrompt(server);

    // If we get here without errors, the server is properly configured
    expect(server).to.exist;
  });

  it('starts and stops cleanly in httpStream mode', async () => {
    server = new FastMCP({ name: 'browserless-mcp', version: '0.1.0' });
    registerPowerScraperTool(server, mockConfig);

    await server.start({
      transportType: 'httpStream',
      httpStream: { port: 0 },
    });

    // Server should be running
    expect(server.serverState).to.equal('running');

    await server.stop();
    expect(server.serverState).to.equal('stopped');
  });
});
