import { expect } from 'chai';
import {
  sanitizeUserAgent,
  classifyClientFamily,
  deriveUsageMode,
  type ClientFamily,
} from '../../src/lib/attribution.js';

describe('attribution', () => {
  describe('sanitizeUserAgent', () => {
    for (const raw of [undefined, '', '   ', []]) {
      it(`omits empty user agent ${JSON.stringify(raw)}`, () => {
        expect(sanitizeUserAgent(raw)).to.deep.equal({
          user_agent_family: 'unknown',
        });
      });
    }
    for (const [raw, user_agent, user_agent_family] of [
      [['python-httpx/0.28.1', 'x'], 'python-httpx/0.28.1', 'python-httpx'],
      ['node', 'node', 'node'],
      [
        'Claude-User (claude.ai) fetch/1.0',
        'Claude-User (claude.ai) fetch/1.0',
        'claude-user',
      ],
      ['  Agent/1.2  ', 'Agent/1.2', 'agent'],
      ['Agent\tExtra/2', 'Agent\tExtra/2', 'agent'],
      ['a'.repeat(500), 'a'.repeat(200), 'a'.repeat(40)],
      ['/leading-slash', '/leading-slash', 'unknown'],
    ] as const) {
      it(`normalizes ${JSON.stringify(raw).slice(0, 60)}`, () => {
        expect(
          sanitizeUserAgent(Array.isArray(raw) ? [...raw] : (raw as string)),
        ).to.deep.equal({ user_agent, user_agent_family });
      });
    }
  });

  describe('classifyClientFamily', () => {
    const families: [ClientFamily, string[]][] = [
      [
        'anthropic',
        [
          'Anthropic/ClaudeAI',
          'CLAUDE-CODE',
          'claude-ai',
          'connectors-manager',
        ],
      ],
      ['openai', ['openai-mcp (Agent Builder)', 'codex-mcp-client']],
      [
        'ide',
        [
          'cursor-vscode',
          'Visual Studio Code',
          'opencode',
          'cherry studio',
          'omp-coding-agent',
          'aider-desk-client',
          'windsurf',
          'zed',
          'cline',
          'roo-code',
          'goose',
        ],
      ],
      [
        'no_code_platform',
        [
          '@n8n/n8n-nodes-langchain.mcpClientTool',
          'Dify',
          'manus',
          'sim-platform',
          'nous-cloud',
          'flowise',
          'zapier',
          'make',
        ],
      ],
      [
        'sdk_default',
        [
          'mcp',
          'mcp-client',
          'cli',
          'ai-sdk-mcp-client',
          '@langchain/mcp-adapters',
          'mcp-bridge',
          'executor-mcp',
          'ToolServer',
        ],
      ],
      ['other', ['custom-test-client', 'not-claude-code', 'mcp-custom']],
    ];
    for (const [family, names] of families) {
      for (const name of names) {
        it(`classifies ${name}`, () => {
          expect(classifyClientFamily('mcp_client', name)).to.equal(family);
        });
      }
    }
    for (const source of [
      'cli_agent',
      'script_builder',
      'autologin',
      'agent_run',
    ]) {
      it(`prioritizes first-party source ${source}`, () => {
        expect(classifyClientFamily(source, 'Anthropic/ClaudeAI')).to.equal(
          'browserless',
        );
        expect(classifyClientFamily(source, undefined)).to.equal('browserless');
      });
    }
    it('keeps absent clients in other', () => {
      expect(classifyClientFamily('mcp_client', undefined)).to.equal('other');
    });
  });

  describe('deriveUsageMode', () => {
    const base: Parameters<typeof deriveUsageMode>[0] = {
      source: 'mcp_client',
      clientName: undefined,
      clientFamily: 'other',
      authMethod: 'api_key_header',
      transport: 'streamable-http',
      userAgent: undefined,
    };
    const cases: [string, Partial<typeof base>, string][] = [
      [
        'first-party CLI',
        { source: 'cli_agent', clientFamily: 'browserless' },
        'interactive',
      ],
      [
        'script builder',
        { source: 'script_builder', clientFamily: 'browserless' },
        'interactive',
      ],
      [
        'autologin',
        { source: 'autologin', clientFamily: 'browserless' },
        'interactive',
      ],
      [
        'agent run before stdio/oauth',
        {
          source: 'agent_run',
          clientFamily: 'browserless',
          transport: 'stdio',
          authMethod: 'oauth',
        },
        'deployed',
      ],
      [
        'unknown first-party tag',
        {
          source: 'future_tag',
          clientFamily: 'browserless',
          transport: 'stdio',
        },
        'unknown',
      ],
      [
        'stdio SDK',
        {
          clientName: 'mcp',
          clientFamily: 'sdk_default',
          authMethod: 'env_token',
          transport: 'stdio',
        },
        'interactive',
      ],
      [
        'OAuth vendor',
        {
          clientName: 'Anthropic/ClaudeAI',
          clientFamily: 'anthropic',
          authMethod: 'oauth',
          userAgent: 'Claude-User/1.0',
        },
        'interactive',
      ],
      [
        'IDE',
        { clientName: 'cursor-vscode', clientFamily: 'ide' },
        'interactive',
      ],
      [
        'Claude CLI',
        {
          clientName: 'claude-code',
          clientFamily: 'anthropic',
          authMethod: 'api_key_query',
          userAgent: 'claude-code/2.1.0 (cli)',
        },
        'interactive',
      ],
      [
        'Claude SDK',
        {
          clientName: 'claude-code',
          clientFamily: 'anthropic',
          userAgent: 'claude-code/2.1.0 (sdk-ts)',
        },
        'deployed',
      ],
      [
        'Codex SDK mixed case',
        {
          clientName: 'CODEX-MCP-CLIENT',
          clientFamily: 'openai',
          userAgent: 'codex/1 (SDK-PY)',
        },
        'deployed',
      ],
      [
        'Claude missing UA',
        {
          clientName: 'claude-code',
          clientFamily: 'anthropic',
          authMethod: 'api_key_query',
        },
        'interactive',
      ],
      [
        'OAuth before SDK marker',
        {
          clientName: 'claude-code',
          clientFamily: 'anthropic',
          authMethod: 'oauth',
          userAgent: 'claude-code/1 (sdk-ts)',
        },
        'interactive',
      ],
      [
        'SDK default',
        {
          clientName: 'mcp',
          clientFamily: 'sdk_default',
          userAgent: 'python-httpx/0.28',
        },
        'deployed',
      ],
      [
        'no-code',
        {
          clientName: 'Dify',
          clientFamily: 'no_code_platform',
          authMethod: 'api_key_query',
        },
        'deployed',
      ],
      [
        'Anthropic SSE',
        {
          clientName: 'Anthropic/ClaudeAI',
          clientFamily: 'anthropic',
          authMethod: 'api_key_query',
          transport: 'sse',
        },
        'deployed',
      ],
      [
        'OpenAI API',
        { clientName: 'openai-mcp (Responses API)', clientFamily: 'openai' },
        'deployed',
      ],
      [
        'unknown custom client',
        { clientName: 'custom-test-client' },
        'unknown',
      ],
      ['absent client', { source: 'unknown' }, 'unknown'],
      [
        'vendor without auth provenance',
        { clientFamily: 'anthropic', authMethod: undefined },
        'unknown',
      ],
    ];
    for (const [name, input, expected] of cases) {
      it(name, () =>
        expect(deriveUsageMode({ ...base, ...input })).to.equal(expected),
      );
    }
  });
});
