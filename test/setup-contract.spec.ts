import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sinon from 'sinon';
import { FastMCP } from 'fastmcp';
import {
  createSetupContract,
  MCP_SURFACE_REGISTRY,
} from '../src/setup-contract.js';
import { getConfig } from '../src/config.js';
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
  const alternateRegistrationSpies = [
    sinon.spy(server, 'addTools'),
    sinon.spy(server, 'addResources'),
    sinon.spy(server, 'addPrompts'),
    sinon.spy(server, 'addResourceTemplate'),
    sinon.spy(server, 'addResourceTemplates'),
  ];
  registerSurface(server, { ...baseConfig, complianceMode });
  for (const registration of alternateRegistrationSpies) {
    expect(
      registration.callCount,
      'runtime registration must stay visible to the singular surface spies',
    ).to.equal(0);
  }
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

  it('keeps the committed generated export structurally current', () => {
    // `npm run check:setup` owns the separate byte-level generated-file gate.
    expect(generated).to.deep.equal(expected);
    expect(expected.schemaVersion).to.equal(1);
    expect(expected.endpoint.url).to.equal('https://mcp.browserless.io/mcp');
    expect(expected.endpoint.transport).to.equal('streamable-http');
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
    expect(Object.keys(pkg.bin)).to.deep.equal(['browserless-mcp']);
  });

  it('keeps the published stdio token variable tied to runtime config', () => {
    const originalToken = process.env.BROWSERLESS_TOKEN;
    try {
      process.env.BROWSERLESS_TOKEN = 'contract-runtime-token';
      const [tokenVariable] = Object.keys(expected.package.stdio.env);
      expect(tokenVariable).to.equal('BROWSERLESS_TOKEN');
      expect(getConfig().browserlessToken).to.equal(process.env[tokenVariable]);
    } finally {
      if (originalToken === undefined) {
        delete process.env.BROWSERLESS_TOKEN;
      } else {
        process.env.BROWSERLESS_TOKEN = originalToken;
      }
    }
  });

  it('rejects incomplete package metadata at the untyped generator boundary', () => {
    const invalidMetadata = [
      { name: '', engines: pkg.engines },
      { name: pkg.name, engines: { node: '   ', npm: pkg.engines.npm } },
      { name: pkg.name, engines: { node: pkg.engines.node, npm: 11 } },
    ];
    for (const metadata of invalidMetadata) {
      expect(() =>
        createSetupContract(metadata as unknown as PackageTruth),
      ).to.throw('package name, engines.node, and engines.npm are required');
    }
  });

  it('publishes only normalized package fields from untrusted metadata', () => {
    const contract = createSetupContract({
      name: '  @browserless.io/mcp  ',
      engines: { node: '  >=24  ', npm: '  >=11.10.0  ' },
      description: 'must not leak',
    } as PackageTruth & { description: string });

    expect(contract.package.name).to.equal('@browserless.io/mcp');
    expect(contract.package.engines).to.deep.equal({
      node: '>=24',
      npm: '>=11.10.0',
    });
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

  it('locks every supported client installation shape', () => {
    const clients = expected.clients as Array<{
      id: string;
      setupKind: string;
      oauth: boolean;
      instructions: string[];
      defaultConfig?: unknown;
    }>;
    expect(clients).to.deep.equal([
      {
        id: 'codex',
        label: 'Codex',
        setupKind: 'cli',
        oauth: true,
        instructions: [
          'Run: codex mcp add browserless --url https://mcp.browserless.io/mcp',
          'Run: codex mcp login browserless',
        ],
      },
      {
        id: 'claude-desktop',
        label: 'Claude Desktop',
        setupKind: 'ui',
        oauth: true,
        instructions: [
          'Open Settings > Connectors.',
          'Add a custom connector with https://mcp.browserless.io/mcp.',
          'Select Connect and finish OAuth in the browser.',
        ],
      },
      {
        id: 'claude-code',
        label: 'Claude Code',
        setupKind: 'cli',
        oauth: true,
        instructions: [
          'Run: claude mcp add --transport http browserless https://mcp.browserless.io/mcp',
          'Run: claude mcp login browserless',
        ],
      },
      {
        id: 'cursor',
        label: 'Cursor',
        setupKind: 'json',
        configPath: '~/.cursor/mcp.json or .cursor/mcp.json',
        oauth: true,
        defaultConfig: {
          mcpServers: {
            browserless: { url: 'https://mcp.browserless.io/mcp' },
          },
        },
        instructions: [
          'Reload MCP servers, then complete OAuth when prompted.',
        ],
      },
      {
        id: 'vscode',
        label: 'VS Code',
        setupKind: 'json',
        configPath:
          '.vscode/mcp.json (workspace) or the user profile MCP config',
        oauth: true,
        defaultConfig: {
          servers: {
            browserless: {
              type: 'http',
              url: 'https://mcp.browserless.io/mcp',
            },
          },
        },
        instructions: [
          'Run MCP: List Servers, start Browserless, and authenticate.',
        ],
      },
      {
        id: 'windsurf',
        label: 'Windsurf',
        setupKind: 'json',
        configPath: '~/.codeium/windsurf/mcp_config.json',
        oauth: true,
        defaultConfig: {
          mcpServers: {
            browserless: { serverUrl: 'https://mcp.browserless.io/mcp' },
          },
        },
        instructions: [
          'Refresh MCP servers, then complete OAuth when prompted.',
        ],
      },
    ]);
    for (const client of clients) {
      expect(client.oauth, `${client.id} must support OAuth`).to.equal(true);
      expect(
        client.instructions,
        `${client.id} needs setup instructions`,
      ).to.be.an('array').that.is.not.empty;
      expect(
        client.instructions.every((instruction) => instruction.trim()),
      ).to.equal(true);
    }

    const byId = Object.fromEntries(
      clients.map((client) => [client.id, client]),
    );
    expect(byId.cursor.defaultConfig).to.deep.equal({
      mcpServers: { browserless: { url: expected.endpoint.url } },
    });
    expect(byId.vscode.defaultConfig).to.deep.equal({
      servers: {
        browserless: { type: 'http', url: expected.endpoint.url },
      },
    });
    expect(byId.windsurf.defaultConfig).to.deep.equal({
      mcpServers: { browserless: { serverUrl: expected.endpoint.url } },
    });
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
      expect(definition.parameters.safeParse({}).success).to.equal(false);
    }
  });

  it('generates OAuth first, bearer second, and never a query-token default', () => {
    expect(expected.auth.methods.map(({ id }) => id)).to.deep.equal([
      'oauth',
      'bearer-header',
    ]);
    expect(expected.auth.generatedDefault).to.equal('oauth');
    expect(expected.auth.methods[1]).to.deep.equal({
      id: 'bearer-header',
      priority: 2,
      generatedByDefault: false,
      headerName: 'Authorization',
      valueTemplate: 'Bearer <BROWSERLESS_TOKEN>',
    });
    expect(
      JSON.stringify(expected),
      'the generated contract must never embed query-token auth',
    ).not.to.match(/[?&]token=/i);
    for (const client of expected.clients) {
      const urls =
        JSON.stringify(client).match(/https?:\/\/[^\s"'<>)}\]]+/g) || [];
      for (const rawUrl of urls) {
        const url = new URL(rawUrl.replace(/[.,]$/, ''));
        expect(
          url.search,
          `${client.id} generated URLs must not contain query authentication`,
        ).to.equal('');
      }
    }
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

  it('fails closed across every setup generator CLI path', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'browserless-mcp-setup-'));
    const scriptPath = join(fixture, 'scripts/generate-setup-contract.mjs');
    const outputPath = join(fixture, 'setup/browserless-mcp-setup.json');
    const runGenerator = (...args: string[]) =>
      spawnSync(process.execPath, [scriptPath, ...args], {
        cwd: fixture,
        encoding: 'utf8',
      });

    try {
      mkdirSync(join(fixture, 'scripts'), { recursive: true });
      mkdirSync(join(fixture, 'build/src'), { recursive: true });
      mkdirSync(join(fixture, 'setup'), { recursive: true });
      copyFileSync(
        join(root, 'scripts/generate-setup-contract.mjs'),
        scriptPath,
      );
      copyFileSync(
        join(root, 'build/src/setup-contract.js'),
        join(fixture, 'build/src/setup-contract.js'),
      );
      copyFileSync(join(root, 'package.json'), join(fixture, 'package.json'));
      copyFileSync(join(root, 'setup/browserless-mcp-setup.json'), outputPath);
      symlinkSync(
        join(root, 'node_modules'),
        join(fixture, 'node_modules'),
        'dir',
      );

      const baseline = readFileSync(outputPath, 'utf8');
      expect(runGenerator('--check').status).to.equal(0);

      writeFileSync(outputPath, 'stale\n');
      const stale = runGenerator('--check');
      expect(stale.status).to.equal(1);
      expect(stale.stderr).to.include('is stale');

      unlinkSync(outputPath);
      const missing = runGenerator('--check');
      expect(missing.status).to.equal(1);
      expect(missing.stderr).to.include('is stale');

      expect(runGenerator().status).to.equal(0);
      expect(readFileSync(outputPath, 'utf8')).to.equal(baseline);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps agent-facing docs as pointers to one canonical setup skill', () => {
    const canonicalSkill =
      'https://www.browserless.io/agent-setup/v1.0.1/SKILL.md';
    const machineExport =
      'https://raw.githubusercontent.com/browserless/browserless-mcp/main/setup/browserless-mcp-setup.json';
    const install = readFileSync(join(root, 'install.md'), 'utf8');
    const llmsInstall = readFileSync(join(root, 'llms-install.md'), 'utf8');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');

    for (const source of [install, llmsInstall, readme]) {
      expect(source).to.include(canonicalSkill);
    }
    for (const source of [install, llmsInstall]) {
      expect(source).to.include(machineExport);
    }
    for (const duplicatedInstruction of [
      'codex mcp add browserless',
      'claude mcp add --transport http browserless',
      'Settings > Connectors',
      '~/.cursor/mcp.json',
      '.vscode/mcp.json',
      '~/.codeium/windsurf/mcp_config.json',
    ]) {
      for (const source of [install, llmsInstall, readme]) {
        expect(source).to.not.include(duplicatedInstruction);
      }
    }
  });
});
