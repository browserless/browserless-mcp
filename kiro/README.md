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

### Local import

1. Open a project folder in Kiro before testing. An empty folder is sufficient;
   **Try power** fails when no workspace folder is open.
2. Open **Powers > Add Custom Power > Import power from a folder** and select
   this `kiro/` directory. For draft review, use branch `feat/kiro-power` of
   `browserless/browserless-mcp`. The draft is not yet on the default branch
   or in Kiro's curated catalog.
3. Confirm Browserless appears under **Installed** and its details show the
   Browserless skill and MCP configuration.

After publication, test **Import power from GitHub** against the public
repository/package path. Local folder import does not establish that this
route or curated catalog installation works.

### OAuth sign-in

The MCP configuration uses Streamable HTTP without a token header. Do not add
an API token, client secret, or hand-written callback to these files.

1. Open **MCP Servers** in Kiro. To find it, open the command palette, select
   **View: Open View**, and search for **MCP Servers**.
2. Locate the Power-managed server. In the tested folder import it was named
   `power-kiro-browserless`; Kiro may use a different namespace for another
   import path. Leave any old manual `browserless` entry disabled.
3. If its status is **Unauthenticated**, click **Authenticate**. The initial
   connection check can report Unauthorized without opening a browser.
4. Accept Kiro's external-site prompt for `https://mcp.browserless.io/oauth/authorize`,
   then complete Browserless sign-in and review any consent request in the browser.
5. Return to Kiro and confirm **Connected** with tools available. The browser's
   authorization-success page alone does not prove token exchange succeeded.

If the callback page says the request expired or already completed, check
Kiro's connection status first. If disconnected, start a fresh attempt through
**Retry**, then **Authenticate** if shown. Do not refresh or reuse the old
callback URL. One such failure occurred in testing and a subsequent attempt
succeeded; the original cause has not been established. No callback allowlist
change or extra OAuth configuration was required for the successful test.

### Safe first tool call

Open the Power details and choose **Try power**, then ask:

> Use the connected Browserless Power's `browserless_smartscraper` tool to read
> only https://example.com and return its main heading and a one-sentence
> summary. Make one request without following links. Use the actual MCP tool,
> not another browsing method. If the call fails, report the error and stop.

Approve only the requested tool call if prompted. Expand the tool trace and
verify the namespaced Browserless scraper ran successfully and returned
**Example Domain**. Smart Scraper can use a direct HTTP fetch for simple pages;
that does not imply Kiro bypassed Browserless when the MCP trace confirms the call.

## Validation record and remaining checks

Local user test on November 17, 2026, macOS, Kiro IDE **1.4.215**:

- Folder import and recognition of the Browserless skill passed.
- Explicit **Authenticate** completed OAuth; the Power server showed
  **Connected (23 tools)**. Tool counts can change with the hosted server.
- The user confirmed the trace contained **Tool Load** and
  `@kiro/browserless/browserless_smartscraper`; the example.com request returned
  **Example Domain**. No API key was added to the package.
- The old manually configured server remained disabled during the Power test.

Still pending: restart/auth reuse, clean cancellation/recovery, installation
from the final public GitHub location, and catalog discovery after acceptance.
This was a local folder test, not a clean-profile or public catalog test.
Multi-step browser, proxy, stealth and CAPTCHA features were not exercised.

For failures, record the Kiro version, the Power's actual server name, and the
redacted connection error. Do not paste API keys, OAuth codes, tokens,
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
