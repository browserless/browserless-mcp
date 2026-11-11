import process from 'node:process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

// Edits built dists that expose no option for the behaviour we need:
//
// 1. fastmcp advertises `listChanged` itself; make it conditional on our
//    start-up flag so the connector advertises a static tool list.
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
  // A dist whose directory is absent (e.g. a future fastmcp without `edge`) is
  // treated as "no matching files": a `required: false` patch skips it, while a
  // required patch still throws the clear not-found error below.
  let entries;
  try {
    entries = readdirSync(dist);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    entries = [];
  }
  for (const file of entries.filter((f) => files.test(f))) {
    const path = join(dist, file);
    const src = readFileSync(path, 'utf8');
    const unpatched = typeof from === 'string' ? src.replaceAll(to, from) : src;
    const updated = unpatched.replaceAll(from, to);
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
  from: /this\.#capabilities\.tools = (?:\{\}|\{ listChanged: true \});/g,
  to: 'this.#capabilities.tools = globalThis.__browserlessMcpStaticTools ? {} : { listChanged: true };',
});

patch({
  name: 'session auth accessor',
  dist: dirname(fastmcpEntry),
  files: /\.(cjs|js)$/,
  from: '  updateAuth(auth) {',
  to: '  get auth() {\n    return this.#auth;\n  }\n  updateAuth(auth) {',
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
  // Keep the SDK-compatible transport pin. Session identifiers are untrusted:
  // neither SSE nor Streamable HTTP may resolve an Object.prototype member.
  // As with the other transport patches, consumer versions are best-effort;
  // child-process integration tests guard the pinned hosted tree.
  for (const registry of ['activeSSETransports', 'activeStreamTransports']) {
    patch({
      name: `${registry} membership`,
      dist: dirname(mcpProxyEntry),
      files: /\.(mjs|js)$/,
      from: `const ${registry} = {};`,
      to: `const ${registry} = Object.create(null);`,
      required: false,
    });
  }
  // Node ignores a request listener's returned promise. Contain rejections at
  // that boundary for both HTTP and HTTPS, without a global rejection handler.
  for (const createServer of [
    'http.createServer(',
    'https.createServer(options, ',
  ]) {
    patch({
      name: `${createServer}request rejection containment`,
      dist: dirname(mcpProxyEntry),
      files: /\.(mjs|js)$/,
      from: `${createServer}requestListener)`,
      to: `${createServer}(req, res) => {
        requestListener(req, res).catch((error) => {
          console.error("[mcp-proxy] error handling request", error);
          if (res.writableEnded || res.destroyed) return;
          try {
            if (res.headersSent) res.end();
            else {
              // The failed handler may have prepared headers for a different body.
              for (const header of ["Content-Length", "Content-Encoding", "Transfer-Encoding", "Trailer"]) res.removeHeader(header);
              const body = "Internal Server Error";
              res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body) }).end(body);
            }
          } catch {
            res.destroy();
          }
        });
      })`,
      required: false,
    });
  }
  // Backport mcp-proxy's RFC 9728 URL construction without its SDK v2 upgrade.
  // Insert the well-known segment before the resource path, preserving query
  // components. Cover both HTTP and middleware (401/403) challenge builders.
  // Best-effort for consumers resolving another version; the HTTP integration
  // test follows the advertised URL against the pinned hosted tree.
  const metadataUrl = (resource) => {
    const url = new URL(resource);
    const path = url.pathname === '/' ? '' : url.pathname;
    url.pathname = `/.well-known/oauth-protected-resource${path}`;
    return url.toString();
  };
  for (const resource of [
    'oauth.protectedResource.resource',
    'this.config.oauth.protectedResource.resource',
  ]) {
    patch({
      name: 'OAuth protected-resource metadata URL',
      dist: dirname(mcpProxyEntry),
      files: /\.(mjs|js)$/,
      from: '${' + resource + '}/.well-known/oauth-protected-resource',
      to: '${(' + metadataUrl.toString() + ')(' + resource + ')}',
      required: false,
    });
  }
  patch({
    name: 'SSE stream writer',
    dist: dirname(mcpProxyEntry),
    files: /\.(mjs|js)$/,
    from: 'else return reader.read().then(flow, handleStreamError);',
    to: 'else reader.read().then(flow, handleStreamError);',
    required: false,
  });
  // Authentication may finish after the socket has already emitted close.
  // Installing a listener then is not enough: cancel the unread response too.
  patch({
    name: 'SSE already-closed socket',
    dist: dirname(mcpProxyEntry),
    files: /\.(mjs|js)$/,
    from: 'writable.on("error", cancel);',
    to: 'writable.on("error", cancel);\n\tif (writable.destroyed || writable.closed) cancel();',
    required: false,
  });
  // mcp-proxy 6.5.1 leaves cancelled replay controllers registered, so the
  // next cursorless GET gets a permanent 409. A resumed stream may replace a
  // half-open one: only the controller that still owns the entry may delete it.
  // Like the writer patch, skip unknown consumer builds; HTTP integration
  // tests exercise the pinned hosted transport and its replacement races.
  patch({
    name: 'SSE replay cancellation',
    dist: dirname(mcpProxyEntry),
    files: /\.(mjs|js)$/,
    from: 'cancel: () => {}\n\t\t\t});',
    to: `cancel: () => {
                    const stream = this._streamMapping.get(replayedStreamId);
                    if (stream?.controller === streamController) stream.cleanup();
                }\n\t\t\t});`,
    required: false,
  });
  // BoundedEventStore can catch up synchronously after the awaited snapshot.
  // Keep that catch-up and live registration in one turn; async-only stores
  // retain their upstream behavior rather than invoking a second async replay.
  for (const [from, to] of [
    [
      'const replayedStreamId = await this._eventStore.replayEventsAfter',
      `let lastReplayedEventId = lastEventId;
            const replayEvent = (eventId, message) => {
                const written = this.writeSSEEvent(streamController, encoder, message, eventId);
                if (written) lastReplayedEventId = eventId;
                return written;
            };
            const replayedStreamId = await this._eventStore.replayEventsAfter`,
    ],
    [
      'if (!this.writeSSEEvent(streamController, encoder, message, eventId)) {',
      'if (!replayEvent(eventId, message)) {',
    ],
  ]) {
    patch({
      name: 'SSE replay cursor tracking',
      dist: dirname(mcpProxyEntry),
      files: /\.(mjs|js)$/,
      from,
      to,
      required: false,
    });
  }
  // Close displaced connections, and finish replay responses once all their
  // requests have completed. Standalone notification streams stay open.
  patch({
    name: 'SSE displaced stream closure',
    dist: dirname(mcpProxyEntry),
    files: /\.(mjs|js)$/,
    from: 'this._streamMapping.set(replayedStreamId, {',
    to: `// Do not await between catch-up and live registration or terminal close.
            if (replayedStreamId && replayedStreamId !== this._standaloneSseStreamId) this._eventStore.replayEventsAfterSync?.(lastReplayedEventId, {
                sessionId: this.sessionId,
                send: replayEvent
            });
            try { this._streamMapping.get(replayedStreamId)?.controller?.close(); } catch {}
            if (replayedStreamId && replayedStreamId !== this._standaloneSseStreamId && !Array.from(this._requestToStreamMapping.values()).includes(replayedStreamId)) {
                this._streamMapping.get(replayedStreamId)?.cleanup();
                try { streamController.close(); } catch {}
                return new Response(readable, { headers });
            }
            this._streamMapping.set(replayedStreamId, {`,
    required: false,
  });
  for (const id of ['this._standaloneSseStreamId', 'replayedStreamId']) {
    patch({
      name: `SSE cleanup ownership (${id})`,
      dist: dirname(mcpProxyEntry),
      files: /\.(mjs|js)$/,
      from: `this._streamMapping.delete(${id});`,
      to: `if (this._streamMapping.get(${id})?.controller === streamController) this._streamMapping.delete(${id});`,
      required: false,
    });
  }
  // POST request streams can also be replaced by replay. Match only their
  // SSE cancel/cleanup callbacks, not the separate JSON-response cleanup.
  for (const from of [
    'cancel: () => {\n\t\t\t\t\tthis._streamMapping.delete(streamId);',
    'this._streamMapping.delete(streamId);\n\t\t\t\t\t\ttry {',
  ]) {
    patch({
      name: 'SSE request cleanup ownership',
      dist: dirname(mcpProxyEntry),
      files: /\.(mjs|js)$/,
      from,
      to: from.replace(
        'this._streamMapping.delete(streamId);',
        'if (this._streamMapping.get(streamId)?.controller === streamController) this._streamMapping.delete(streamId);',
      ),
      required: false,
    });
  }
  // Retain request results even between connections. The existing bounded,
  // session-scoped store owns replay; completed request bookkeeping can still
  // be released without a live response. JSON responses and no-store servers
  // retain their existing missing-connection error.
  for (const [from, to] of [
    [
      'if (!this._enableJsonResponse && stream?.controller && stream?.encoder) {',
      'if (!this._enableJsonResponse && (this._eventStore || (stream?.controller && stream?.encoder))) {',
    ],
    [
      'this.writeSSEEvent(stream.controller, stream.encoder, message, eventId);',
      'if (stream?.controller && stream?.encoder) this.writeSSEEvent(stream.controller, stream.encoder, message, eventId);',
    ],
    [
      'if (!stream) throw new Error(`No connection established for request ID: ${String(requestId)}`);',
      'if (!stream && (this._enableJsonResponse || !this._eventStore)) throw new Error(`No connection established for request ID: ${String(requestId)}`);',
    ],
    // A result stored before catch-up is replayed, not live-written again.
    // Its completion must still close the newly registered replacement.
    [
      '} else stream.cleanup();',
      '} else this._streamMapping.get(streamId)?.cleanup();',
    ],
  ]) {
    patch({
      name: 'SSE disconnected result retention',
      dist: dirname(mcpProxyEntry),
      files: /\.(mjs|js)$/,
      from,
      to,
      required: false,
    });
  }
  patch({
    name: 'session request authentication',
    dist: dirname(mcpProxyEntry),
    files: /\.(mjs|js)$/,
    from: 'const handleStreamRequest = async ({',
    to: `const authenticateSessionRequest = async ({ authenticate, oauth, req, res }) => {
  if (!authenticate) return false;
  let message = "Unauthorized: Authentication failed";
  try {
    const result = await authenticate(req);
    if (result && result.authenticated !== false) return false;
    if (typeof result?.error === "string") message = result.error;
  } catch (error) {
    if (await handleResponseError(error, res)) return true;
    if (error instanceof Error) message = error.message;
  }
  const headers = { "Content-Type": "application/json" };
  const challenge = getWWWAuthenticateHeader(oauth, { error: "invalid_token", error_description: message });
  if (challenge) headers["WWW-Authenticate"] = challenge;
  res.writeHead(401, headers);
  res.end(createJsonRpcErrorResponse(-32000, message));
  return true;
};
const handleStreamRequest = async ({`,
    required: false,
  });
  patch({
    name: 'session request authentication GET',
    dist: dirname(mcpProxyEntry),
    files: /\.(mjs|js)$/,
    from: 'const activeTransport = sessionId ? activeTransports[sessionId] : void 0;',
    to: 'if (await authenticateSessionRequest({ authenticate, oauth, req, res })) return true;\n\t\tconst activeTransport = sessionId ? activeTransports[sessionId] : void 0;',
    required: false,
  });
  patch({
    name: 'session request authentication DELETE',
    dist: dirname(mcpProxyEntry),
    files: /\.(mjs|js)$/,
    from: 'console.log("[mcp-proxy] received delete request");',
    to: 'console.log("[mcp-proxy] received delete request");\n\t\tif (await authenticateSessionRequest({ authenticate, oauth, req, res })) return true;',
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
