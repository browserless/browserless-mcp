import process from 'node:process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

// Edits built dists that expose no option for the behaviour we need:
//
// 1. fastmcp advertises `tools: {}` and exposes no option to enable
//    `listChanged`, so clients never re-fetch when our tool surface changes.
//    The capability lives in a private field (`#capabilities.tools`) set inside
//    FastMCPSession.
// 2. mcp-proxy, fastmcp's HTTP layer, bundles @hono/node-server, whose stream
//    writer ends each chunk with `return reader.read().then(flow, ...)`. The
//    returned promise makes every chunk's promise adopt the next one, so a
//    response stream that stays open — the SSE stream each MCP session holds,
//    written on every keepalive ping — retains one promise per event until it
//    closes. Dropping the `return` pumps the stream the same way, unchained.
//
// This runs as postinstall and must find fastmcp wherever the consumer's
// package manager hoists it — under `npm ci` in a large tree it is NOT under
// our own node_modules. `require.resolve` follows Node resolution from here
// and returns the real install path; `patch-package` cannot (it looks under a
// cwd-relative node_modules and fails when fastmcp is hoisted).

const require = createRequire(import.meta.url);

let fastmcpEntry;
try {
  // fastmcp's "." export resolves to dist/FastMCP.cjs; its sibling chunks hold
  // the FastMCPSession definition we edit.
  fastmcpEntry = require.resolve('fastmcp');
} catch (err) {
  // fastmcp genuinely absent (e.g. an install that excludes it): nothing to
  // do. Any other resolution failure is a broken install — surface it rather
  // than silently shipping unpatched.
  if (err.code === 'MODULE_NOT_FOUND') process.exit(0);
  throw err;
}

const patch = ({ name, dist, files, from, to, required = true }) => {
  let changed = 0;
  let alreadyApplied = false;
  for (const file of readdirSync(dist).filter((f) => files.test(f))) {
    const path = join(dist, file);
    const src = readFileSync(path, 'utf8');
    const updated = src.replaceAll(to, from).replaceAll(from, to);
    if (updated !== src) {
      writeFileSync(path, updated);
      changed++;
    } else if (src.includes(to)) {
      alreadyApplied = true;
    }
  }

  if (changed) {
    process.stdout.write(
      `[patch-fastmcp] ${name}: patched ${changed} file(s)\n`,
    );
  } else if (alreadyApplied) {
    // Idempotent: a previous run already replaced `from` with `to`.
    process.stdout.write(`[patch-fastmcp] ${name}: already patched\n`);
  } else if (required) {
    // Neither the unpatched nor the patched snippet exists anywhere in dist:
    // the dependency's build changed and this patch no longer matches. Fail
    // loudly instead of silently shipping without it.
    throw new Error(
      `[patch-fastmcp] ${name}: target not found in ${dist}; the build may ` +
        'have changed — update scripts/patch-fastmcp.mjs',
    );
  } else {
    process.stderr.write(
      `[patch-fastmcp] ${name}: target not found in ${dist}; skipped\n`,
    );
  }
};

patch({
  name: 'tools.listChanged',
  dist: dirname(fastmcpEntry),
  files: /\.(cjs|js)$/,
  from: 'this.#capabilities.tools = {};',
  to: 'this.#capabilities.tools = { listChanged: true };',
});

// mcp-proxy is pinned only for our own installs (package.json overrides); npm
// consumers resolve fastmcp's semver range, whose future builds may move or
// change this writer. Skip there rather than fail their install —
// package-integrity tests guard the pinned tree.
let mcpProxyEntry;
try {
  // Resolve from fastmcp's own location, whether nested or hoisted.
  mcpProxyEntry = createRequire(fastmcpEntry).resolve('mcp-proxy');
} catch (err) {
  process.stderr.write(
    `[patch-fastmcp] SSE stream writer: mcp-proxy not resolvable (${err.code}); skipped\n`,
  );
}
if (mcpProxyEntry) {
  patch({
    name: 'SSE stream writer',
    dist: dirname(mcpProxyEntry),
    files: /\.(mjs|js)$/,
    from: 'else return reader.read().then(flow, handleStreamError);',
    to: 'else reader.read().then(flow, handleStreamError);',
    required: false,
  });
}

// Supply transport context alongside retained request history. Best-effort:
// npm `overrides` pin mcp-proxy for THIS package but do not reach dependents,
// so a consumer can resolve a different mcp-proxy/SDK build whose call sites
// these snippets do not match. That build is left unpatched (it runs without
// the extension) rather than failing `postinstall` — the behaviour before this
// extension was added. This repo and the hosted deployment pin mcp-proxy via
// `overrides`, and the package-integrity test asserts the patch applied there.
const transportDists = [];
if (mcpProxyEntry) transportDists.push(dirname(mcpProxyEntry));
for (const resolveFrom of [require, createRequire(fastmcpEntry)]) {
  try {
    const sdkServerRoot = dirname(
      dirname(
        dirname(
          resolveFrom.resolve(
            '@modelcontextprotocol/sdk/server/streamableHttp.js',
          ),
        ),
      ),
    );
    for (const format of ['esm', 'cjs'])
      transportDists.push(join(sdkServerRoot, format, 'server'));
  } catch (err) {
    // A consumer that resolves no SDK server build simply goes unpatched.
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
  }
}
for (const dist of [...new Set(transportDists)]) {
  for (const args of [
    'streamId, {}',
    'streamId, message',
    'this._standaloneSseStreamId, message',
  ]) {
    patch({
      name: 'event-store write context',
      dist,
      files: /\.(mjs|js)$/,
      from: `.storeEvent(${args})`,
      to: `.storeEvent(${args}, this.sessionId)`,
      required: false,
    });
  }
  patch({
    name: 'event-store replay context',
    dist,
    files: /\.(mjs|js)$/,
    from: '.replayEventsAfter(lastEventId, {',
    to: '.replayEventsAfter(lastEventId, { sessionId: this.sessionId,',
    required: false,
  });
}
const edgeDist = join(dirname(fastmcpEntry), 'edge');
patch({
  name: 'edge event-store write context',
  dist: edgeDist,
  files: /\.(cjs|js)$/,
  from: '.storeEvent(streamId, message)',
  to: '.storeEvent(streamId, message, this.activeSessionId)',
  required: false,
});
patch({
  name: 'edge event-store replay context',
  dist: edgeDist,
  files: /\.(cjs|js)$/,
  from: '.replayEventsAfter(lastEventId, {',
  to: '.replayEventsAfter(lastEventId, { sessionId: this.activeSessionId,',
  required: false,
});
