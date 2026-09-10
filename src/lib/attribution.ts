export type AuthMethod =
  'oauth' | 'api_key_header' | 'api_key_query' | 'env_token';
export type McpTransport = 'stdio' | 'streamable-http' | 'sse';
export type ClientFamily =
  | 'anthropic'
  | 'openai'
  | 'ide'
  | 'no_code_platform'
  | 'sdk_default'
  | 'browserless'
  | 'other';
export type UsageMode = 'interactive' | 'deployed' | 'unknown';

const INTERACTIVE_SOURCES = ['cli_agent', 'script_builder', 'autologin'];
const ANTHROPIC_CLIENTS = ['claude-code', 'claude-ai', 'connectors-manager'];
const IDE_CLIENTS = [
  'cursor-vscode',
  'visual studio code',
  'opencode',
  'cherry studio',
  'omp-coding-agent',
  'aider-desk-client',
  'windsurf',
  'zed',
  'cline',
  'roo-code',
  'goose',
];
const NO_CODE_CLIENTS = [
  'dify',
  'manus',
  'sim-platform',
  'nous-cloud',
  'flowise',
  'zapier',
  'make',
];
const SDK_CLIENTS = [
  'mcp',
  'mcp-client',
  'cli',
  'ai-sdk-mcp-client',
  '@langchain/mcp-adapters',
  'mcp-bridge',
  'executor-mcp',
  'toolserver',
];

export function sanitizeUserAgent(raw: string | string[] | undefined): {
  user_agent?: string;
  user_agent_family: string;
} {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const user_agent =
    typeof value === 'string' ? value.trim().slice(0, 200) : '';
  if (!user_agent) return { user_agent_family: 'unknown' };
  return {
    user_agent,
    user_agent_family:
      user_agent.split(/[/\s]/, 1)[0].toLowerCase().slice(0, 40) || 'unknown',
  };
}

export function classifyClientFamily(
  source: string,
  clientName: string | undefined,
): ClientFamily {
  const name = typeof clientName === 'string' ? clientName.toLowerCase() : '';
  if (INTERACTIVE_SOURCES.includes(source) || source === 'agent_run')
    return 'browserless';
  if (name.startsWith('anthropic/') || ANTHROPIC_CLIENTS.includes(name))
    return 'anthropic';
  if (name.startsWith('openai-mcp') || name === 'codex-mcp-client')
    return 'openai';
  if (IDE_CLIENTS.includes(name)) return 'ide';
  if (name.startsWith('@n8n/') || NO_CODE_CLIENTS.includes(name))
    return 'no_code_platform';
  if (SDK_CLIENTS.includes(name)) return 'sdk_default';
  return 'other';
}

export function deriveUsageMode(input: {
  source: string;
  clientName: string | undefined;
  clientFamily: ClientFamily;
  authMethod: AuthMethod | undefined;
  transport: McpTransport;
  userAgent: string | undefined;
}): UsageMode {
  const { source, clientName, clientFamily, authMethod, transport, userAgent } =
    input;
  if (clientFamily === 'browserless') {
    if (INTERACTIVE_SOURCES.includes(source)) return 'interactive';
    return source === 'agent_run' ? 'deployed' : 'unknown';
  }
  if (transport === 'stdio' || authMethod === 'oauth' || clientFamily === 'ide')
    return 'interactive';
  const name = typeof clientName === 'string' ? clientName.toLowerCase() : '';
  if (name === 'claude-code' || name === 'codex-mcp-client') {
    return typeof userAgent === 'string' &&
      userAgent.toLowerCase().includes('(sdk-')
      ? 'deployed'
      : 'interactive';
  }
  if (clientFamily === 'sdk_default' || clientFamily === 'no_code_platform')
    return 'deployed';
  if (
    (clientFamily === 'anthropic' || clientFamily === 'openai') &&
    (authMethod === 'api_key_header' || authMethod === 'api_key_query')
  )
    return 'deployed';
  return 'unknown';
}
