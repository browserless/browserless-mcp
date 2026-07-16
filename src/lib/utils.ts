import { createHash } from 'node:crypto';

/**
 * 64-bit truncation of SHA-256 — wide enough to make accidental collisions
 * astronomically unlikely, unlike a 32-bit djb2. Used to fingerprint tokens,
 * proxy configs, and other identifiers we want stable but unguessable.
 */
export function hashToken(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
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
}

/**
 * Origin tag for analytics: our callers' `x-browserless-mcp-source` header wins;
 * external clients fall back to (spoofable) MCP clientInfo.name → `mcp_client`.
 */
export function resolveMcpSource(
  headerSource: string | undefined,
  clientInfo: { name?: string; version?: string } | undefined,
): McpSourceProps {
  return {
    source: headerSource || (clientInfo?.name ? 'mcp_client' : 'unknown'),
    client_name: clientInfo?.name,
    client_version: clientInfo?.version,
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

const REDACTED = '[REDACTED]';

// pattern-based, not a full DLP scanner — known key shapes only.
// Upgrade to a real detector if leak review shows misses.
const SECRET_PATTERNS: RegExp[] = [
  // JWTs (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  // Vendor key prefixes: Stripe/OpenAI (sk-/pk-/rk-), GitHub, Slack, AWS,
  // Google, GitLab.
  /\b(?:sk|pk|rk)[-_](?:live|test)?[-_]?[A-Za-z0-9]{10,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{10,}\b/g,
  // Authorization: Bearer <token>
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  // Credential phrasing, unquoted or JSON-style (`password=x`, `"api_key":"x"`):
  // optional matching key-quotes; value quoted (stops at close quote) or bare.
  /(["']?)\b(?:pass(?:word|wd)?|pwd|secret|api[\s_-]?key|access[\s_-]?token|auth(?:orization)?[\s_-]?token|token|otp|mfa|2fa)\b\1\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
  // Long hex blobs (md5/sha/hex keys) — low false-positive vs. words/URLs.
  /\b[0-9a-f]{32,}\b/gi,
];

/** Best-effort secret scrub for free-form analytics text: masks known
 *  credential shapes, caps length. Not a guarantee (see SECRET_PATTERNS). */
export function redactSecrets(text: string, maxLen = 2000): string {
  const scrubbed = SECRET_PATTERNS.reduce(
    (acc, re) => acc.replace(re, REDACTED),
    text,
  );
  return scrubbed.length > maxLen
    ? `${scrubbed.slice(0, maxLen)}…[truncated]`
    : scrubbed;
}
