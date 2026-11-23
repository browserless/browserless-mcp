import { createHash } from 'node:crypto';
import type { BrowserlessSession } from '../@types/types.js';
import {
  sanitizeUserAgent,
  classifyClientFamily,
  deriveUsageMode,
  type AuthMethod,
  type McpTransport,
  type ClientFamily,
  type UsageMode,
} from './attribution.js';

/**
 * 64-bit truncation of SHA-256 — wide enough to make accidental collisions
 * astronomically unlikely, unlike a 32-bit djb2. Used to fingerprint tokens,
 * proxy configs, and other identifiers we want stable but unguessable.
 */
export function hashToken(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * djb2 string hash. Matches the Browserless backend's session ID hashing —
 * kept compatible so analytics `user_id` values stay consistent across services.
 */
export function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

export interface McpSourceProps {
  source: string;
  client_name?: string;
  client_version?: string;
  auth_method: AuthMethod;
  transport: McpTransport;
  user_agent?: string;
  user_agent_family: string;
  client_family: ClientFamily;
  usage_mode: UsageMode;
}

/**
 * Origin tag for analytics: our callers' `x-browserless-mcp-source` header wins;
 * external clients fall back to (spoofable) MCP clientInfo.name → `mcp_client`.
 */
export function resolveMcpSource(
  session:
    | Pick<
        BrowserlessSession,
        'source' | 'authMethod' | 'transport' | 'userAgent'
      >
    | undefined,
  clientInfo: { name?: string; version?: string } | undefined,
  configTransport: 'stdio' | 'httpStream',
): McpSourceProps {
  const source =
    session?.source || (clientInfo?.name ? 'mcp_client' : 'unknown');
  const transport =
    session?.transport ??
    (configTransport === 'stdio' ? 'stdio' : 'streamable-http');
  const client_family = classifyClientFamily(source, clientInfo?.name);
  return {
    source,
    client_name: clientInfo?.name,
    client_version: clientInfo?.version,
    auth_method: session?.authMethod ?? 'env_token',
    transport,
    ...sanitizeUserAgent(session?.userAgent),
    client_family,
    usage_mode: deriveUsageMode({
      source,
      clientName: clientInfo?.name,
      clientFamily: client_family,
      authMethod: session?.authMethod,
      transport,
      userAgent: session?.userAgent,
    }),
  };
}

/** Content-Types that should be treated as text (not base64-encoded). */
export const TEXT_CONTENT_TYPES = [
  'text/',
  'application/json',
  'application/javascript',
  'application/xml',
  'application/xhtml+xml',
  'application/ld+json',
];

export function isTextContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return TEXT_CONTENT_TYPES.some((prefix) => lower.includes(prefix));
}

/** Strip undefined entries so JSON.stringify omits them from the wire body. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** Split a comma-separated env-var value into a trimmed, non-empty list. */
export function parseCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Reject server bodies that are obviously not a real message — empty, just
 * whitespace, or a literal `null`/`undefined` from a misbehaving JSON layer.
 * Callers usually fall back to a canned message when this returns false.
 */
export function isMeaningfulBody(s: string): boolean {
  const normalized = s.trim();
  return normalized.length > 0 && !/^(?:null|undefined)$/i.test(normalized);
}

export { redactSecrets } from './redact.js';
