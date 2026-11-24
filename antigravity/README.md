# Browserless for Antigravity

Connect Antigravity to Browserless cloud browsers to extract rendered web content,
map and crawl sites, capture screenshots, run Lighthouse audits, and perform
persistent browser workflows. This bundle includes the hosted MCP connection and
one on-demand Browserless workflow skill. It has no local server, install hooks,
or runtime dependencies.

## Requirements

- Antigravity App or CLI with plugin support.
- A Browserless account with available usage. Browser operations consume your
  account's quota and may incur charges under your plan.
- Internet access to `https://mcp.browserless.io/mcp`.

## Install from this repository

Until this plugin is accepted into Google's curated marketplace, install the
`antigravity` subfolder from a local checkout. Installing the repository root or
running `agy plugin install browserless` is not a verified marketplace route.

```bash
git clone https://github.com/browserless/browserless-mcp.git
cd browserless-mcp
agy plugin validate --strict ./antigravity
agy plugin install ./antigravity
agy plugin list --json
```

In Antigravity, open Customizations > Installed (or `/plugin` in the CLI), find
Browserless, and enable it to open the credential setup dialog. Enter your
Browserless API token from [your account dashboard](https://account.browserless.io/)
there. Antigravity keeps the plugin disabled until this variable is configured.
The bundle contains only a variable reference, not a real credential. Never paste
credentials into chat or commit them to this repository.

This initial bundle uses Antigravity's native credential prompt rather than OAuth.
Browserless supports OAuth, but Antigravity's callback must be allowed by the
hosted server before switching this plugin to that flow. No MCP server changes
or deployment are required for this token-based bundle.

The configured server uses `serverUrl`, as required by current Antigravity MCP
configuration. Antigravity namespaces the bundled server as
`browserless_browserless`; inspect the discovered tool names rather than assuming
a fixed prefix.

## Try it

- “Extract the main content from https://example.com as markdown.”
- “Take a screenshot of https://browserless.io.”
- “Map up to 10 pages on https://docs.browserless.io.”

You can invoke `/browserless` to load the bundled workflow guidance. Tool
availability depends on the connected server and account. For a multi-step browser
workflow, reuse the returned `sessionId` on every call and close the session after
finishing.

## Privacy and permissions

Page content, screenshots, uploaded files, and browser actions are processed by
the remote Browserless service. Only send data required for the user's authorized
task. Follow Antigravity's approval controls for logins, form submissions,
purchases, uploads, and other consequential actions. A successful installation
alone does not verify sign-in or a live browser operation.

If authentication fails, update the token through the client's plugin setup controls. If the
server or requested tool is unavailable, report the connection error without
substituting a different provider. Treat live-session and download URLs as private.

## Development and release

This folder is self-contained and versioned independently in `plugin.json`.
`release-please-config.json` excludes `antigravity/` from the MCP npm release;
the root npm `files` allowlist does not ship this bundle. Plugin-only edits must
not change the MCP package version or `server.json`. Use a `chore(antigravity):`
commit and PR title for this initial change and future plugin-only CI/config
changes: those supporting files are outside the excluded plugin directory.

Before distributing an update, run:

```bash
node --test scripts/ci/verify-antigravity-plugin.test.mjs
node scripts/ci/verify-antigravity-plugin.mjs
agy plugin validate --strict ./antigravity
```

Use Google's [build and submission guide](https://antigravity.google/docs/build-plugins)
for the current marketplace requirements. Acceptance into the curated marketplace
is a separate review, not a consequence of adding files to this repository.

## License

[SSPL-1.0](LICENSE), matching the Browserless MCP repository.
