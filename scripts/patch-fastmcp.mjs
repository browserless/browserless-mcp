import process from 'node:process';
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
} catch (err) {
  // fastmcp genuinely absent (e.g. an install that excludes it): nothing to
  // do. Any other resolution failure is a broken install — surface it rather
  // than silently shipping with tools.listChanged disabled.
  if (err.code === 'MODULE_NOT_FOUND') process.exit(0);
  throw err;
}

let changed = 0;
let alreadyEnabled = false;
for (const file of readdirSync(dist).filter((f) => /\.(cjs|js)$/.test(f))) {
  const path = join(dist, file);
  const src = readFileSync(path, 'utf8');
  if (src.includes(FROM)) {
    writeFileSync(path, src.replaceAll(FROM, TO));
    changed++;
  } else if (src.includes(TO)) {
    alreadyEnabled = true;
  }
}

if (changed) {
  process.stdout.write(
    `[patch-fastmcp] enabled tools.listChanged in ${changed} file(s)\n`,
  );
} else if (alreadyEnabled) {
  // Idempotent: a previous run already replaced FROM with TO.
  process.stdout.write('[patch-fastmcp] tools.listChanged already enabled\n');
} else {
  // Neither the unpatched nor the patched snippet exists anywhere in dist:
  // fastmcp's build layout changed and this patch no longer matches. Fail
  // loudly instead of leaving tools.listChanged silently disabled.
  throw new Error(
    '[patch-fastmcp] tools.listChanged target not found in fastmcp; the ' +
      'fastmcp build may have changed — update scripts/patch-fastmcp.mjs',
  );
}
