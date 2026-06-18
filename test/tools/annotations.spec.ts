import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import { registerSmartScraperTool } from '../../src/tools/smartscraper.js';
import { registerFunctionTool } from '../../src/tools/function.js';
import { registerExportTool } from '../../src/tools/export.js';
import { registerAgentTools } from '../../src/tools/agent.js';
import { registerSearchTool } from '../../src/tools/search.js';
import { registerMapTool } from '../../src/tools/map.js';
import { registerCrawlTool } from '../../src/tools/crawl.js';
import { registerPerformanceTool } from '../../src/tools/performance.js';
import type { McpConfig } from '../../src/@types/types.js';

const mockConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
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
  oauthAllowedRedirectUriPatterns: [],
};

// Every register function used by src/index.ts. registerAgentTools registers
// two tools (browserless_skill + browserless_agent); the rest register one.
const registrars = [
  registerSmartScraperTool,
  registerFunctionTool,
  registerExportTool,
  registerAgentTools,
  registerSearchTool,
  registerMapTool,
  registerCrawlTool,
  registerPerformanceTool,
];

// MCP clients (notably OpenAI) reject any tool that does not set all three
// behavioural hints to an explicit boolean. fastmcp forwards `annotations`
// verbatim into tools/list, so the hint must live on every tool's annotations.
const REQUIRED_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'openWorldHint',
] as const;

describe('tool annotations', () => {
  afterEach(() => sinon.restore());

  it('every registered tool sets all three behavioural hints as booleans', () => {
    const server = new FastMCP({ name: 'test', version: '0.1.0' });
    const addToolSpy = sinon.spy(server, 'addTool');

    registrars.forEach((register) => register(server, mockConfig));

    expect(addToolSpy.callCount).to.be.greaterThan(0);

    addToolSpy.getCalls().forEach((call) => {
      const tool = call.args[0];
      const annotations = tool.annotations ?? {};
      REQUIRED_HINTS.forEach((hint) => {
        expect(
          annotations[hint],
          `${tool.name} is missing ${hint} (must be an explicit boolean)`,
        ).to.be.a('boolean');
      });
    });
  });
});
