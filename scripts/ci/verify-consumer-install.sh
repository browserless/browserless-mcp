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

pack_name=$(npm pack --pack-destination=/tmp | tail -n1)
tarball="/tmp/${pack_name}"

workdir=$(mktemp -d)
install_log=$(mktemp)
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  rm -rf "$workdir" "$install_log" "$tarball"
}
trap cleanup EXIT

cd "$workdir"
# A bare project: no `overrides`, no `.npmrc`. npm resolves fastmcp's own
# mcp-proxy/SDK range, exactly as an `npx @browserless.io/mcp` user would.
echo '{"name":"consumer-smoke","version":"1.0.0","private":true}' > package.json

echo "→ installing the packed tarball as a consumer (foreground postinstall)…"
# --foreground-scripts surfaces postinstall output so we can assert the patch
# script actually ran and took its tolerant path; `set -e`/pipefail already fail
# the script if `npm install` (and thus `postinstall`) exits non-zero.
npm install "$tarball" --foreground-scripts --no-audit --no-fund 2>&1 | tee "$install_log"

if ! grep -q '\[patch-fastmcp\]' "$install_log"; then
  echo "::error::postinstall patch script did not run during the consumer install"
  exit 1
fi
if grep -q 'target not found.*build may' "$install_log"; then
  echo "::error::a required patch threw on the consumer's resolved transport build"
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

tools=$(curl -fsS -X POST "http://127.0.0.1:${port}/mcp" \
  -H 'Authorization: Bearer ci-smoke' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "mcp-session-id: ${sid}" \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | grep '^data:' | tail -1 | sed 's/^data: //' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.tools.length)}catch{console.log(0)}})')
if [ "${tools:-0}" -lt 1 ]; then
  echo "::error::consumer server served no tools (tools/list returned '${tools}')"; cat "$workdir/server.log"; exit 1
fi

echo "✓ Consumer install runs: mcp-proxy@${proxy_ver}, server healthy, tools/list → ${tools} tools"
