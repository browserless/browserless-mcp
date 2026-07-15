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
