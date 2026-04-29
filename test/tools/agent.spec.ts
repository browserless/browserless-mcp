import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import type { Content } from 'fastmcp';
import { registerAgentTools } from '../../src/tools/agent.js';
import type { McpConfig } from '../../src/config.js';

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

const mockContext = {
  reportProgress: sinon.stub().resolves(),
  log: {
    debug: sinon.stub(),
    error: sinon.stub(),
    info: sinon.stub(),
    warn: sinon.stub(),
  },
  session: undefined,
  client: { version: undefined },
  streamContent: sinon.stub().resolves(),
};

describe('browserless_skill tool', () => {
  let server: FastMCP;
  let addToolSpy: sinon.SinonSpy;

  beforeEach(() => {
    server = new FastMCP({ name: 'test', version: '0.1.0' });
    addToolSpy = sinon.spy(server, 'addTool');
    registerAgentTools(server, mockConfig);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('registers both browserless_skill and browserless_agent', () => {
    const names = addToolSpy.getCalls().map((c) => c.args[0].name);
    expect(names).to.include('browserless_skill');
    expect(names).to.include('browserless_agent');
  });

  it('returns the rendered skill body for a known id', async () => {
    const skillCall = addToolSpy
      .getCalls()
      .find((c) => c.args[0].name === 'browserless_skill');
    expect(skillCall, 'browserless_skill not registered').to.exist;

    const result = await skillCall!.args[0].execute(
      { id: 'shadow-dom' },
      mockContext,
    );
    const text = (result.content[0] as Extract<Content, { type: 'text' }>).text;
    expect(text).to.match(/^--- SKILL: shadow-dom/);
    expect(text).to.match(/--- END SKILL ---$/);
    expect(text).to.include('deep selector');
  });

  it('rejects unknown skill ids at the schema level', async () => {
    const skillCall = addToolSpy
      .getCalls()
      .find((c) => c.args[0].name === 'browserless_skill');
    const schema = skillCall!.args[0].parameters as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ id: 'shadow-dom' }).success).to.equal(true);
    expect(schema.safeParse({ id: 'not-a-skill' }).success).to.equal(false);
  });
});
