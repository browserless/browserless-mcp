#!/usr/bin/env bash
#
# Verify the npm tarball installs AND runs for a real downstream consumer.
#
# `scripts/patch-fastmcp.mjs` runs on `postinstall` and edits the transport
# built into mcp-proxy / the MCP SDK. We pin mcp-proxy with `overrides`, but npm
# `overrides` do NOT reach dependents: a consumer resolves fastmcp's own range
# and gets a newer mcp-proxy/SDK, whose call sites a version-specific patch may
# not match. When such a patch is `required` it throws and aborts `postinstall`
# — which is how 1.40.0 shipped a broken install for every `npm`/`npx` consumer.
#
# `npm ci` and package-integrity.spec.ts run against our PINNED tree, so they
# stay green while consumers break. This check closes that gap: it installs the
# packed tarball into a clean project with no `overrides` and no `.npmrc` — the
# real consumer resolution — and fails loudly if `postinstall` throws or the
# built server cannot serve its tools on the consumer's resolved transport.
set -euo pipefail

workdir=$(mktemp -d)
install_log=$(mktemp)
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  rm -rf "$workdir" "$install_log"
}
trap cleanup EXIT

# Pack into the per-run workdir so concurrent runs never share a tarball path.
pack_name=$(npm pack --pack-destination="$workdir" | tail -n1)
tarball="$workdir/${pack_name}"

cd "$workdir"
# A bare project: no `overrides`, no `.npmrc`. npm resolves fastmcp's own
# mcp-proxy/SDK range, exactly as an `npx @browserless.io/mcp` user would.
echo '{"name":"consumer-smoke","version":"1.0.0","private":true}' > package.json

echo "→ installing the packed tarball as a consumer (foreground postinstall)…"
# --foreground-scripts surfaces postinstall output so we can assert the patch
# script actually ran and took its tolerant path.
set +o pipefail
npm install "$tarball" --foreground-scripts --no-audit --no-fund 2>&1 | tee "$install_log"
install_rc=${PIPESTATUS[0]}
set -o pipefail

if [ "$install_rc" -ne 0 ]; then
  # Our postinstall patch throwing is the regression this check guards — fail.
  if grep -qE '\[patch-fastmcp\].*target not found|target not found.*build may' "$install_log"; then
    echo "::error::a required patch threw on the consumer's resolved transport build"
    exit 1
  fi
  # A registry-side fetch failure (an unrelated transitive dep's tarball 404s or
  # the network drops) is an external npm incident this check can't see past —
  # skip rather than flake CI red on something that is not this package's bug.
  if grep -qE 'code E404|npm error 404|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNREFUSED|network error' "$install_log"; then
    echo "::warning::consumer install could not fetch dependencies from the npm registry (external incident, not this package); skipping the consumer smoke"
    exit 0
  fi
  echo "::error::consumer install failed for an unexpected reason (see log above)"
  exit 1
fi

if ! grep -q '\[patch-fastmcp\]' "$install_log"; then
  echo "::error::postinstall patch script did not run during the consumer install"
  exit 1
fi

pkg_dir="$workdir/node_modules/@browserless.io/mcp"
proxy_ver=$(node -p "require('mcp-proxy/package.json').version" 2>/dev/null || echo "unknown")
echo "→ consumer resolved mcp-proxy@${proxy_ver}; starting the built server…"

port=8799
TRANSPORT=httpStream PORT="$port" BROWSERLESS_TOKEN=ci-smoke \
  BROWSERLESS_API_URL=http://127.0.0.1:9 OAUTH_ENABLED=false ANALYTICS_ENABLED=false \
  node "$pkg_dir/build/src/index.js" > "$workdir/server.log" 2>&1 &
server_pid=$!

for _ in $(seq 1 60); do
  curl -fs -o /dev/null "http://127.0.0.1:${port}/health" 2>/dev/null && break
  sleep 0.25
done
if ! curl -fsS -o /dev/null "http://127.0.0.1:${port}/health"; then
  echo "::error::consumer server did not become healthy"; cat "$workdir/server.log"; exit 1
fi

# Initialize + tools/list over the real transport (exercises mcp-proxy/SDK).
sid=$(curl -fsS -D - -o /dev/null -X POST "http://127.0.0.1:${port}/mcp" \
  -H 'Authorization: Bearer ci-smoke' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"1"}}}' \
  | grep -i '^mcp-session-id' | tr -d '\r' | awk '{print $2}')
[ -n "$sid" ] || { echo "::error::initialize returned no mcp-session-id"; cat "$workdir/server.log"; exit 1; }

# MCP lifecycle: send notifications/initialized before any normal request, or a
# spec-strict server may reject tools/list even though the install succeeded.
curl -fsS -o /dev/null -X POST "http://127.0.0.1:${port}/mcp" \
  -H 'Authorization: Bearer ci-smoke' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: ${sid}" \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

tools=$(curl -fsS -X POST "http://127.0.0.1:${port}/mcp" \
  -H 'Authorization: Bearer ci-smoke' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: ${sid}" \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const values=[s.trim(),...s.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).reverse()];for(const v of values){try{const m=JSON.parse(v);if(Array.isArray(m.result?.tools)){console.log(m.result.tools.length);return}}catch{}}console.log(0)})')
if [ "${tools:-0}" -lt 1 ]; then
  echo "::error::consumer server served no tools (tools/list returned '${tools}')"; cat "$workdir/server.log"; exit 1
fi

echo "✓ Consumer install runs: mcp-proxy@${proxy_ver}, server healthy, tools/list → ${tools} tools"
