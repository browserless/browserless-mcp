import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

// fastmcp advertises `tools: {}` and exposes no option to enable
// `listChanged`, so clients never re-fetch when our tool surface changes.
// The capability lives in a private field (`#capabilities.tools`) set inside
// FastMCPSession, so the only lever is editing fastmcp's built dist.
//
// This runs as postinstall and must find fastmcp wherever the consumer's
// package manager hoists it — under `npm ci` in a large tree it is NOT under
// our own node_modules. `require.resolve` follows Node resolution from here
// and returns the real install path; `patch-package` cannot (it looks under a
// cwd-relative node_modules and fails when fastmcp is hoisted).

const FROM = 'this.#capabilities.tools = {};';
const TO = 'this.#capabilities.tools = { listChanged: true };';

const require = createRequire(import.meta.url);

let dist;
try {
  // fastmcp's "." export resolves to dist/FastMCP.cjs; its sibling chunks hold
  // the FastMCPSession definition we edit.
  dist = dirname(require.resolve('fastmcp'));
} catch {
  // fastmcp is not installed (e.g. an install that excludes it). Nothing to do.
  process.exit(0);
}

const files = readdirSync(dist).filter((f) => /\.(cjs|js)$/.test(f));
const applied = files.filter((f) => {
  const path = join(dist, f);
  const src = readFileSync(path, 'utf8');
  if (!src.includes(FROM)) return false;
  writeFileSync(path, src.replaceAll(FROM, TO));
  return true;
});

if (applied.length) {
  console.log(
    `[patch-fastmcp] enabled tools.listChanged in ${applied.length} file(s)`,
  );
} else {
  // Idempotent: a second run finds FROM already replaced — not an error.
  console.log('[patch-fastmcp] tools.listChanged already enabled');
}
