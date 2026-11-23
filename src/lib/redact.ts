const REDACTED = '[REDACTED]';

// pattern-based, not a full DLP scanner — known key shapes only.
// Upgrade to a real detector if leak review shows misses.
const SECRET_PATTERNS: RegExp[] = [
  // Authorization: Bearer <token> (before other patterns mask token substrings).
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
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
