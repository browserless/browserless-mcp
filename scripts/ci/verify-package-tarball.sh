#!/usr/bin/env bash
#
# Verify the npm tarball that would ship from a `npm publish` against an
# allowlist. Catches accidental edits to `package.json:files`, a broken
# `prepack`, or stray internal docs / sourcemaps / raw sources creeping
# back in.
#
# Runs `npm pack` (which triggers `prepack` → `npm run build`) and then
# greps the resulting tar listing for known-bad patterns. Tarball entries
# are prefixed with `package/`, so patterns are anchored accordingly:
#   - `.spec.`            — compiled test specs
#   - `^package/src/`     — unbuilt TypeScript sources (we ship build/src)
#   - `^package/build/test/` — compiled tests (files ships only build/src)
#   - `*.ts` (non-`.d.ts`)   — raw TypeScript that isn't a declaration
#   - `CLAUDE.md` / `REFACTOR.md` — internal-only docs
#   - `.map`              — sourcemaps (tsconfig disables them; guards
#                           against the config drifting back)
#
# Exits non-zero on any match so CI fails loudly.
set -euo pipefail

# `npm pack` writes the filename it produced to its last stdout line.
# Capture that directly rather than scanning /tmp — `ls -t /tmp/*.tgz`
# would pick up unrelated tarballs left there by other processes.
pack_name=$(npm pack --pack-destination=/tmp | tail -n1)
tarball="/tmp/${pack_name}"

listing=$(tar -tzf "$tarball")
echo "$listing"

forbidden=$(echo "$listing" | grep -E '(\.spec\.|^package/src/|^package/build/test/|^package/CLAUDE\.md$|^package/REFACTOR\.md$|\.map$)' || true)

# Raw TypeScript sources should never ship — only compiled `.js` and
# `.d.ts` declarations. Match any `.ts` that isn't a `.d.ts`.
raw_ts=$(echo "$listing" | grep -E '\.ts$' | grep -vE '\.d\.ts$' || true)

if [ -n "$forbidden" ] || [ -n "$raw_ts" ]; then
  echo "::error::Forbidden files in npm tarball:"
  [ -n "$forbidden" ] && echo "$forbidden"
  [ -n "$raw_ts" ] && echo "$raw_ts"
  exit 1
fi

echo "✓ Tarball contents pass the allowlist"
