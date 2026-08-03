export type SurfaceAvailability = 'both' | 'full-only';
export type SurfaceKind = 'tool' | 'resource' | 'prompt';

// Keep the complete surface in one inventory so compliance review covers every
// registered capability and the public export cannot drift from runtime.
export const MCP_SURFACE_REGISTRY = [
  { kind: 'tool', id: 'browserless_export', surface: 'both' },
  { kind: 'tool', id: 'browserless_agent', surface: 'both' },
  { kind: 'tool', id: 'browserless_skill', surface: 'both' },
  { kind: 'tool', id: 'browserless_search', surface: 'both' },
  { kind: 'tool', id: 'browserless_performance', surface: 'both' },
  // Status is safe on both surfaces because it reports which surface is active.
  { kind: 'resource', id: 'browserless://status', surface: 'both' },
  { kind: 'tool', id: 'browserless_smartscraper', surface: 'full-only' },
  { kind: 'tool', id: 'browserless_function', surface: 'full-only' },
  { kind: 'tool', id: 'browserless_map', surface: 'full-only' },
  { kind: 'tool', id: 'browserless_crawl', surface: 'full-only' },
  // Compliant mode rejects profiles, so profile management stays full-only.
  { kind: 'tool', id: 'browserless_profiles', surface: 'full-only' },
  // API docs and prompts describe proxy/CAPTCHA behavior and steer callers to
  // smartscraper, which is intentionally unavailable on the compliant surface.
  { kind: 'resource', id: 'browserless://api-docs', surface: 'full-only' },
  { kind: 'prompt', id: 'scrape-url', surface: 'full-only' },
  { kind: 'prompt', id: 'extract-content', surface: 'full-only' },
] as const satisfies ReadonlyArray<{
  kind: SurfaceKind;
  id: string;
  surface: SurfaceAvailability;
}>;

export type McpSurfaceId = (typeof MCP_SURFACE_REGISTRY)[number]['id'];

const idsFor = (kind: SurfaceKind, compliant: boolean): string[] =>
  MCP_SURFACE_REGISTRY.filter(
    (entry) => entry.kind === kind && (entry.surface === 'both' || !compliant),
  )
    .map((entry) => entry.id)
    .sort();

export interface PackageTruth {
  name: string;
  engines: {
    node: string;
    npm: string;
  };
}

const HOSTED_URL = 'https://mcp.browserless.io/mcp';

export const createSetupContract = (packageTruth: PackageTruth) => {
  if (
    typeof packageTruth.name !== 'string' ||
    !packageTruth.name.trim() ||
    typeof packageTruth.engines?.node !== 'string' ||
    !packageTruth.engines.node.trim() ||
    typeof packageTruth.engines?.npm !== 'string' ||
    !packageTruth.engines.npm.trim()
  ) {
    throw new Error('package name, engines.node, and engines.npm are required');
  }
  const packageName = packageTruth.name.trim();
  const nodeEngine = packageTruth.engines.node.trim();
  const npmEngine = packageTruth.engines.npm.trim();

  return {
    schemaVersion: 1 as const,
    package: {
      name: packageName,
      engines: {
        node: nodeEngine,
        npm: npmEngine,
      },
      stdio: {
        command: 'npx',
        args: ['-y', packageName],
        env: {
          BROWSERLESS_TOKEN: '<BROWSERLESS_TOKEN>',
        },
      },
    },
    endpoint: {
      url: HOSTED_URL,
      transport: 'streamable-http',
    },
    auth: {
      generatedDefault: 'oauth',
      methods: [
        {
          id: 'oauth',
          priority: 1,
          generatedByDefault: true,
        },
        {
          id: 'bearer-header',
          priority: 2,
          generatedByDefault: false,
          headerName: 'Authorization',
          valueTemplate: 'Bearer <BROWSERLESS_TOKEN>',
        },
      ],
      forbiddenGeneratedMethods: ['query-token'],
    },
    surfaces: {
      full: {
        tools: idsFor('tool', false),
        resources: idsFor('resource', false),
        prompts: idsFor('prompt', false),
      },
      compliant: {
        tools: idsFor('tool', true),
        resources: idsFor('resource', true),
        prompts: idsFor('prompt', true),
      },
    },
    clients: [
      {
        id: 'codex',
        label: 'Codex',
        setupKind: 'cli',
        oauth: true,
        instructions: [
          `Run: codex mcp add browserless --url ${HOSTED_URL}`,
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
          `Add a custom connector with ${HOSTED_URL}.`,
          'Select Connect and finish OAuth in the browser.',
        ],
      },
      {
        id: 'claude-code',
        label: 'Claude Code',
        setupKind: 'cli',
        oauth: true,
        instructions: [
          `Run: claude mcp add --transport http browserless ${HOSTED_URL}`,
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
          mcpServers: { browserless: { url: HOSTED_URL } },
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
          servers: { browserless: { type: 'http', url: HOSTED_URL } },
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
          mcpServers: { browserless: { serverUrl: HOSTED_URL } },
        },
        instructions: [
          'Refresh MCP servers, then complete OAuth when prompted.',
        ],
      },
    ],
    verification: {
      // Export is present on both surfaces, so this smoke test is valid even
      // for compliance-mode installs that intentionally omit smart scraping.
      tool: 'browserless_export',
      arguments: {
        url: 'https://example.com',
      },
    },
  };
};

export type BrowserlessMcpSetupContract = ReturnType<
  typeof createSetupContract
>;
