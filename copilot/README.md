# Browserless for GitHub Copilot CLI

A code-free Agent Plugins 1.0 package connecting Copilot CLI to the hosted Browserless MCP server. It includes one focused skill for Browserless tool selection, bounded extraction, and persistent browser sessions. It does not bundle a browser, proxy process, lifecycle hook, or credentials.

## Local review and testing

From this repository's root, with Copilot CLI installed:

```sh
export COPILOT_HOME="$(mktemp -d)"
copilot plugin marketplace add .
copilot plugin install browserless@browserless
```

Keep the selected `COPILOT_HOME` when inspecting or testing the installation. This only installs the package; it does not establish a working Browserless connection. Review any trust prompts before proceeding.

After these files are published in the repository, installation uses:

```sh
copilot plugin marketplace add browserless/browserless-mcp
copilot plugin install browserless@browserless
```

The remote commands require this package to exist on the selected repository ref. Before merge, add the review branch with `copilot plugin marketplace add browserless/browserless-mcp#feat/agent-plugin-copilot-kiro`. This package includes a same-repository marketplace; direct installs are supported by some client versions but may show deprecation warnings. A public repository installation is also distinct from approval in the Awesome Copilot catalog.

## Authentication

The package declares a Streamable HTTP endpoint without an Authorization header. Use Copilot's native remote-MCP OAuth flow when it requests authentication. In an authenticated Copilot session, inspect `/mcp`; use `/mcp auth <actual-server-name>` if the server needs authentication. Review the Browserless consent screen before granting access.

Do not put `${BROWSERLESS_TOKEN}` into a portable remote-server header: Copilot passes remote configuration values literally. Do not commit tokens or add credentials to this package. GitHub/Copilot sign-in and Browserless sign-in are separate.

OAuth compatibility still requires an end-to-end test with the intended client version; schema validation alone does not establish it.

## Acceptance checks

1. Install in a clean profile without a Browserless token; verify CLI startup and plugin/skill detection.
2. Complete Browserless OAuth and confirm tools appear under the plugin's server, without a duplicate manually configured override.
3. Ask Copilot to use Browserless tools to read `https://example.com` and report its title. Verify the tool trace shows a real Browserless call. This uses model and Browserless quota.
4. Restart the client and verify authentication reuse. Test cancelled/expired authentication without exposing secrets.
5. Record exact client/package versions and results before proposing publication.

## Distribution

Awesome Copilot accepts external plugins through its public external-plugin issue form, not a direct PR editing `plugins/external.json`. Submission requires a public source, immutable review locator, metadata and maintainer approval. Use a plugin-specific tag such as `copilot-0.1.0`, not a root `v*` tag which triggers the MCP server's release workflows. A full immutable commit SHA can be submitted without creating a release tag. Publishing a catalog listing remains subject to the catalog maintainers' review.

## Maintenance and license

The portable manifest, MCP configuration, skill, references and license are mirrored in `kiro/`. Update both together; `node scripts/ci/verify-agent-plugins.mjs` checks parity and package boundaries. Client-specific installation guidance stays in each README. Root release calculation excludes the client folders; ordinary core changes retain their existing checks and release behavior.

This package follows the repository's SSPL-1.0 license. It does not copy Hermes's MIT license.

- [Privacy policy](https://www.browserless.io/privacy-policy)
- Support: [support@browserless.io](mailto:support@browserless.io)
- [Copilot plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [Copilot authentication reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
- [Awesome Copilot contribution policy](https://github.com/github/awesome-copilot/blob/main/CONTRIBUTING.md)
