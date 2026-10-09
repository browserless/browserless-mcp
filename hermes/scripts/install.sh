#!/usr/bin/env bash
# Install this plugin from a local checkout into a Hermes home and select it as the browser provider.
# (Users normally run: hermes plugins install browserless/browserless-mcp/hermes --enable)
#   HERMES_HOME  target Hermes home (default ~/.hermes)
#   HERMES_BIN   hermes executable (default: hermes on PATH)
set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERMES="${HERMES_BIN:-hermes}"
DEST="$HERMES_HOME/plugins/browserless"

mkdir -p "$DEST"
rsync -a --delete --exclude scripts --exclude __pycache__ "$PLUGIN_DIR/" "$DEST/"
echo "Copied plugin to $DEST"

"$HERMES" plugins enable browserless
"$HERMES" config set --force browser.cloud_provider browserless
# Use Hermes' built-in agent-browser tools (otherwise Browser Use mode wins when uvx/browser-use is on PATH).
"$HERMES" config set browser.backend off

if ! grep -qE '^BROWSERLESS_(API_)?TOKEN=' "$HERMES_HOME/.env" 2>/dev/null && [ -z "${BROWSERLESS_TOKEN:-}" ]; then
  echo "Next: add BROWSERLESS_TOKEN=<your token> to $HERMES_HOME/.env"
fi
