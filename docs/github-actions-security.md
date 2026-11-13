# GitHub Actions security maintenance

## Tool update procedure

Analyzer pins live in `.github/workflows/test.yml`; the MCP publisher pin lives
in `.github/workflows/npm-publish.yml`. Dependabot updates action references and
existing lockfile entries, but not these shell-installed tools.

- **gh-actions-lock v0.4.1:** review the release and update `--pin`. The extension
  installation has no separate archive checksum. Use the same version locally.
- **zizmor 1.32.0, actionlint 1.7.12, ShellCheck 0.11.0:** review the release,
  download the Linux x86-64 archive, and verify its digest against the publisher's
  checksum/signature where available. Update the step name, URL, extraction path
  if needed, and literal SHA-256 together. Verification must precede extraction
  and execution. Keep zizmor at least 1.32.0 for lockfile support.
- **mcp-publisher v1.8.1:** review the registry release and verify the Linux
  amd64 archive digest. Update `MCP_PUBLISHER_VERSION` and
  `MCP_PUBLISHER_SHA256` together in `npm-publish.yml`.

After adding/removing workflows or changing action references, regenerate the
lockfile after all workflow edits. From the repository root, with the pinned
tools and ShellCheck on PATH:

```sh
gh actions-lock
gh actions-lock --verify
zizmor .
actionlint
```

Review resolved versions, repository identities and commit hashes. Commit the
workflow edits and generated `.github/workflows/actions.lock` together; never
hand-edit the lockfile. Dependabot maintains existing coverage, but does not
onboard new workflows. Run PR checks and revisit exceptions after tool upgrades.

## Exceptions

- **`.github/zizmor.yml`:** `dependabot-cooldown.config.days: 3` preserves the
  three-day minimum for npm and GitHub Actions instead of the analyzer's default
  seven. The explicit guard in `test.yml` checks all updaters because zizmor
  1.32.0 returns after its first compliant entry. Test lowering npm and Actions
  independently (including SemVer overrides), include/exclude filters, removing
  either updater/cooldown, and adding an unprotected updater. Remove the guard
  only after a tool upgrade detects those regressions.
- **Docker cooldown:** only the single default-branch Docker `/docker` updater
  is exempt from the guard. Duplicate entries and a non-default target branch
  fail. There is no analyzer suppression: zizmor 1.32.0 treats an omitted
  cooldown as three days. Revisit the guard when a Docker cooldown is approved.
- **Analyzer limitations:** actionlint 1.7.12 skips remote-action input schemas
  at full-semver refs, so review inputs against each locked action's `action.yml`.
  No input or runner-label diagnostics are globally suppressed. Revisit this
  limitation when upgrading actionlint. Explicit credential persistence on
  checkout v7 was not reported by zizmor 1.32.0 in a negative fixture; retain
  `persist-credentials: false` on every checkout and check it during review.

Do not broaden these exceptions to hide new findings. Root-level `zizmor .`
is required for lockfile discovery; scanning workflow files alone is insufficient.
