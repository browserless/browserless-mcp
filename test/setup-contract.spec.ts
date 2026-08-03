import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import {
  createSetupContract,
  MCP_SURFACE_REGISTRY,
} from '../src/setup-contract.js';
import type { PackageTruth } from '../src/setup-contract.js';
import { registerSurface } from '../src/tools/register.js';
import type { McpConfig } from '../src/@types/types.js';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const generated = JSON.parse(
  readFileSync(join(root, 'setup/browserless-mcp-setup.json'), 'utf8'),
);
const expected = createSetupContract({
  name: pkg.name,
  engines: pkg.engines,
});

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

const captureSurface = (complianceMode: boolean) => {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const tools = sinon.spy(server, 'addTool');
  const resources = sinon.spy(server, 'addResource');
  const prompts = sinon.spy(server, 'addPrompt');
  registerSurface(server, { ...baseConfig, complianceMode });
  return {
    tools: tools
      .getCalls()
      .map((call) => (call.args[0] as { name: string }).name)
      .sort(),
    resources: resources
      .getCalls()
      .map((call) => (call.args[0] as { uri: string }).uri)
      .sort(),
    prompts: prompts
      .getCalls()
      .map((call) => (call.args[0] as { name: string }).name)
      .sort(),
  };
};

const captureToolDefinition = (complianceMode: boolean, name: string) => {
  const server = new FastMCP({ name: 'test', version: '0.1.0' });
  const tools = sinon.spy(server, 'addTool');
  registerSurface(server, { ...baseConfig, complianceMode });
  return tools
    .getCalls()
    .map((call) => call.args[0] as { name: string; parameters: unknown })
    .find((definition) => definition.name === name);
};

describe('Browserless MCP setup contract', () => {
  afterEach(() => sinon.restore());

  it('keeps the committed generated export byte-for-value current', () => {
    expect(generated).to.deep.equal(expected);
    expect(expected.endpoint.url).to.equal('https://mcp.browserless.io/mcp');
    expect(expected.package).not.to.have.property('version');
    expect(expected.package.name).to.equal('@browserless.io/mcp');
    expect(expected.package.engines).to.deep.equal({
      node: '>=24',
      npm: '>=11.10.0',
    });
    expect(expected.package.stdio).to.deep.equal({
      command: 'npx',
      args: ['-y', '@browserless.io/mcp'],
      env: { BROWSERLESS_TOKEN: '<BROWSERLESS_TOKEN>' },
    });
  });

  it('rejects incomplete package metadata at the untyped generator boundary', () => {
    expect(() =>
      createSetupContract({ name: '', engines: pkg.engines }),
    ).to.throw('package name, engines.node, and engines.npm are required');
  });

  it('publishes only normalized package fields from untrusted metadata', () => {
    const contract = createSetupContract({
      name: '  @browserless.io/mcp  ',
      engines: pkg.engines,
      description: 'must not leak',
    } as PackageTruth & { description: string });

    expect(contract.package.name).to.equal('@browserless.io/mcp');
    expect(contract.package.stdio.args).to.deep.equal([
      '-y',
      '@browserless.io/mcp',
    ]);
    expect(contract.package).to.not.have.property('description');
    expect(Object.keys(contract.package)).to.deep.equal([
      'name',
      'engines',
      'stdio',
    ]);
  });

  it('locks the public full and compliant inventories', () => {
    expect(expected.surfaces.full.tools).to.deep.equal([
      'browserless_agent',
      'browserless_crawl',
      'browserless_export',
      'browserless_function',
      'browserless_map',
      'browserless_performance',
      'browserless_profiles',
      'browserless_search',
      'browserless_skill',
      'browserless_smartscraper',
    ]);
    expect(expected.surfaces.compliant.tools).to.deep.equal([
      'browserless_agent',
      'browserless_export',
      'browserless_performance',
      'browserless_search',
      'browserless_skill',
    ]);
    expect(expected.surfaces.full.resources).to.deep.equal([
      'browserless://api-docs',
      'browserless://status',
    ]);
    expect(expected.surfaces.compliant.resources).to.deep.equal([
      'browserless://status',
    ]);
    expect(expected.surfaces.full.prompts).to.deep.equal([
      'extract-content',
      'scrape-url',
    ]);
    expect(expected.surfaces.compliant.prompts).to.deep.equal([]);
    expect(expected.surfaces.full.tools).to.include(expected.verification.tool);
    expect(expected.surfaces.compliant.tools).to.include(
      expected.verification.tool,
    );
  });

  it('derives the real runtime surface from the same typed registry', () => {
    expect(captureSurface(false)).to.deep.equal(expected.surfaces.full);
    expect(captureSurface(true)).to.deep.equal(expected.surfaces.compliant);
    expect(new Set(MCP_SURFACE_REGISTRY.map(({ id }) => id)).size).to.equal(
      MCP_SURFACE_REGISTRY.length,
    );
  });

  it('keeps the verification fixture valid on both real tool schemas', () => {
    for (const complianceMode of [false, true]) {
      const definition = captureToolDefinition(
        complianceMode,
        expected.verification.tool,
      ) as {
        parameters: {
          safeParse: (value: unknown) => { success: boolean };
        };
      };
      expect(
        definition.parameters.safeParse(expected.verification.arguments)
          .success,
      ).to.equal(true);
      expect(
        definition.parameters.safeParse({ uri: 'https://example.com' }).success,
      ).to.equal(false);
    }
  });

  it('generates OAuth first, bearer second, and never a query-token default', () => {
    expect(expected.auth.methods.map(({ id }) => id)).to.deep.equal([
      'oauth',
      'bearer-header',
    ]);
    expect(expected.auth.generatedDefault).to.equal('oauth');
    expect(
      JSON.stringify(expected.clients),
      'generated client defaults must never embed query-token auth',
    ).to.not.include('?token=');
    expect(expected.auth.forbiddenGeneratedMethods).to.include('query-token');
  });

  it('publishes both typed and committed JSON setup exports', () => {
    expect(pkg.exports['./setup']).to.deep.equal({
      types: './build/src/setup-contract.d.ts',
      import: './build/src/setup-contract.js',
    });
    expect(pkg.exports['./setup/browserless-mcp-setup.json'].default).to.equal(
      './setup/browserless-mcp-setup.json',
    );
    expect(pkg.files).to.include('setup/*.json');
  });

  it('keeps agent-facing docs as pointers to one canonical setup skill', () => {
    const canonicalSkill =
      'https://www.browserless.io/agent-setup/v1.0.0/SKILL.md';
    const install = readFileSync(join(root, 'install.md'), 'utf8');
    const llmsInstall = readFileSync(join(root, 'llms-install.md'), 'utf8');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');

    for (const source of [install, llmsInstall, readme]) {
      expect(source).to.include(canonicalSkill);
    }
    for (const duplicatedInstruction of [
      'codex mcp add browserless',
      'claude mcp add --transport http browserless',
      'Settings > Connectors',
      '~/.cursor/mcp.json',
      '.vscode/mcp.json',
      '~/.codeium/windsurf/mcp_config.json',
    ]) {
      expect(install).to.not.include(duplicatedInstruction);
      expect(llmsInstall).to.not.include(duplicatedInstruction);
    }
  });
});
