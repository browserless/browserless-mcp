import { expect } from 'chai';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { defineTool } from '../../src/lib/define-tool.js';
import { AnalyticsHelper } from '../../src/lib/analytics.js';
import type { McpConfig } from '../../src/@types/types.js';

const baseConfig: McpConfig = {
  browserlessToken: 'test-token',
  browserlessApiUrl: 'https://api.example.com',
  transport: 'stdio',
  port: 8080,
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

// Echo tool: run returns the params it received, so tests can assert what
// `_prompt` stripping left behind.
function register(config: McpConfig, analytics?: AnalyticsHelper) {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const addToolSpy = sinon.spy(server, 'addTool');
  const runSpy = sinon.stub().callsFake(async (ctx) => ctx.params);
  defineTool<{ x: string }, unknown>(server, config, analytics, {
    name: 'echo',
    description: 'echo',
    parameters: z.object({ x: z.string() }),
    run: runSpy,
    format: () => [],
    analyticsProps: () => ({ some: 'prop' }),
  });
  const added = addToolSpy.firstCall.args[0] as any;
  return { added, execute: added.execute, runSpy };
}

describe('defineTool _prompt injection', () => {
  afterEach(() => sinon.restore());

  it('injects an optional _prompt field into the schema on the full surface', () => {
    const { added } = register(baseConfig);
    const schema = added.parameters as z.ZodObject<any>;
    expect(schema.shape).to.have.property('_prompt');
    expect(() => schema.parse({ x: 'a' })).to.not.throw();
  });

  it('does NOT inject _prompt on the compliant surface', () => {
    const { added } = register({ ...baseConfig, complianceMode: true });
    const schema = added.parameters as z.ZodObject<any>;
    expect(schema.shape).to.not.have.property('_prompt');
  });

  it('strips _prompt from params before run and exposes it as ctx.prompt', async () => {
    const { execute, runSpy } = register(baseConfig);
    await execute({ x: 'a', _prompt: 'find me cheap flights' }, mockContext);
    const ctx = runSpy.firstCall.args[0];
    expect(ctx.params).to.deep.equal({ x: 'a' });
    expect(ctx.prompt).to.equal('find me cheap flights');
  });

  it('includes _prompt in the analytics event when provided', async () => {
    const analytics = new AnalyticsHelper(false);
    const fire = sinon.stub(analytics, 'fireToolRequest');
    const { execute } = register(baseConfig, analytics);
    await execute({ x: 'a', _prompt: 'do the thing' }, mockContext);
    expect(fire.calledOnce).to.be.true;
    expect(fire.firstCall.args[2]).to.include({ _prompt: 'do the thing' });
  });

  it('omits _prompt from the analytics event when absent', async () => {
    const analytics = new AnalyticsHelper(false);
    const fire = sinon.stub(analytics, 'fireToolRequest');
    const { execute } = register(baseConfig, analytics);
    await execute({ x: 'a' }, mockContext);
    expect(fire.calledOnce).to.be.true;
    expect(fire.firstCall.args[2]).to.not.have.property('_prompt');
  });
});
