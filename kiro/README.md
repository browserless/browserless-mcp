# Browserless for Kiro

A code-free Agent Plugins 1.0 power connecting Kiro to Browserless cloud browsers. It packages the hosted MCP endpoint and a focused skill for extraction, screenshots and browser workflows. No local browser process, native hook, or credential is included.

## Import and authenticate

Prerequisites: Kiro IDE with Powers and MCP support, internet access to the
hosted Browserless service, and a Browserless account with available quota.
Browserless operations and Kiro model requests may consume account quota.

Before this local test, disable any manually added `browserless` server in the
user MCP configuration (`"disabled": true`) and save. This prevents the earlier
direct-install connection from being mistaken for the Power's connection.
Do not delete credentials or change other server entries.

For local review, open Kiro's Powers panel, choose **Add Custom Power**, then **Import power from a folder**, and select this `kiro/` directory. Review the requested capabilities.

For draft testing, use a checkout of branch
`feat/kiro-power` in `browserless/browserless-mcp` and select its
`kiro/` folder. The package is not yet available from the default branch or
Kiro's curated catalog. Select the `kiro/` folder for this test.

Once this directory has been published, users can import it from the public `browserless/browserless-mcp` repository, selecting the `kiro` power. Repository import is separate from a curated Kiro catalog listing.

The MCP configuration uses Streamable HTTP without a token header. Kiro supports browser-based OAuth for remote MCP servers. Complete Browserless sign-in when prompted and review the consent request. Do not add a client secret or API token to these files. Actual Browserless OAuth compatibility still needs a client test; it is not proven by manifest validation.

Kiro namespaces power server names. Inspect the client to identify the actual server name instead of assuming it is literally `browserless`. Avoid creating a same-purpose manual MCP entry during the acceptance test: that would not establish that the power configuration works.

## Acceptance checks

1. Import into a clean Kiro profile; verify metadata and skill detection.
2. Use a browser/extraction prompt and confirm power activation.
3. Complete Browserless OAuth and verify the namespaced server discovers tools.
4. Ask Kiro to use Browserless tools to read `https://example.com` and return the title. Inspect the tool trace to verify execution. This uses model and Browserless quota.
5. Test restart/auth reuse and cancelled authentication without committing or logging credentials.

Kiro Power import, activation and live OAuth/tool execution have not been tested
in this draft. On November 17, 2026, a separate direct MCP install-link test
successfully added the endpoint to Kiro's user configuration. After enabling
that entry, Kiro started a localhost callback listener and reported
`Failed to connect: Unauthorized`; no OAuth prompt was observed. That result
does not identify the failing OAuth stage and does not validate this Power.

If sign-in fails, record the Kiro version, the Power's actual server name, and
the redacted connection error. Do not paste API keys, OAuth codes, tokens,
authorization URLs with query parameters, or passwords into chat or issues.
Do not substitute an API key and report the OAuth test as passed.

## Curated catalog submission

Submit through the [Kiro registry form](https://kiro.dev/registry/submit/),
selecting **Power**. Confirm current requirements and service eligibility before
submission. Obtain company approval for Kiro's publisher terms and explicit
approval of the final listing before submitting. Local import is a test, not
a public catalog listing.

The intended published experience is Powers > Available Powers > search
"Browser" > Browserless > Install > OAuth sign-in > a successful MCP tool call.
Kiro documents filtering Available Powers by display name. Verify that exact
search and installation flow after acceptance; keywords for activation alone
are not evidence of search visibility. The catalog display name and final
description remain subject to review and Kiro acceptance.

## Maintenance and license

This Power is independently reviewed and versioned. Run
`node scripts/ci/verify-kiro-plugin.mjs` and
`node --test scripts/ci/verify-kiro-plugin.test.mjs` to check the package.
The checks do not require the Copilot package to be present.

Follow the Hermes release-isolation pattern: `release-please-config.json`
excludes `kiro` from the root MCP release, and the root npm `files` allowlist
omits it. Keep independent plugin versions and tags outside the root `v*`
release pattern. PR titles still follow the Conventional Commit check; use
`docs(kiro): ...` for documentation and `chore(kiro): ...` for maintenance.
Folder exclusions do not exempt a PR from title, formatting, or validation checks.

SSPL-1.0, consistent with this repository. Hermes's MIT license is not inherited.

- [Privacy policy](https://www.browserless.io/privacy-policy)
- Support: [support@browserless.io](mailto:support@browserless.io)
- [Create a Kiro power](https://kiro.dev/docs/powers/create/)
- [Kiro remote MCP and OAuth](https://kiro.dev/docs/mcp/configuration/)
- [Official contribution instructions](https://github.com/kirodotdev/powers/blob/main/CONTRIBUTING.md)
