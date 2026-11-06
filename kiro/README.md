# Browserless for Kiro

A code-free Agent Plugins 1.0 power connecting Kiro to Browserless cloud browsers. It packages the hosted MCP endpoint and a focused skill for extraction, screenshots and browser workflows. No local browser process, native hook, or credential is included.

## Import and authenticate

For local review, open Kiro's Powers panel, choose **Add Custom Power**, then **Import power from a folder**, and select this `kiro/` directory. Review the requested capabilities.

Once this directory has been published, users can import it from the public `browserless/browserless-mcp` repository, selecting the `kiro` power. Repository import is separate from a curated Kiro catalog listing.

The MCP configuration uses Streamable HTTP without a token header. Kiro supports browser-based OAuth for remote MCP servers. Complete Browserless sign-in when prompted and review the consent request. Do not add a client secret or API token to these files. Actual Browserless OAuth compatibility still needs a client test; it is not proven by manifest validation.

Kiro namespaces power server names. Inspect the client to identify the actual server name instead of assuming it is literally `browserless`. Avoid creating a same-purpose manual MCP entry during the acceptance test: that would not establish that the power configuration works.

## Acceptance checks

1. Import into a clean Kiro profile; verify metadata and skill detection.
2. Use a browser/extraction prompt and confirm power activation.
3. Complete Browserless OAuth and verify the namespaced server discovers tools.
4. Ask Kiro to use Browserless tools to read `https://example.com` and return the title. Inspect the tool trace to verify execution. This uses model and Browserless quota.
5. Test restart/auth reuse and cancelled authentication without committing or logging credentials.

Kiro IDE import, activation and live OAuth/tool execution have not been tested in this draft.

## Curated catalog submission

The official submission route is [Submit a power](https://kiro.dev/powers/submit/), linked by `kirodotdev/powers/CONTRIBUTING.md`. It requires a tested, complete power, public source, license, privacy/support information, and a non-preview MCP service. Confirm Browserless service eligibility before submission. A local manifest or GitHub import does not imply catalog acceptance.

## Maintenance and license

The portable manifest, MCP configuration, skill, references and license are mirrored in `copilot/`. Update both together; run `node scripts/ci/verify-agent-plugins.mjs` to detect drift and validate boundaries. Keep client-specific instructions separate. Use independent plugin versions and tags outside the root `v*` release pattern. Root release calculation excludes this folder.

SSPL-1.0, consistent with this repository. Hermes's MIT license is not inherited.

- [Privacy policy](https://www.browserless.io/privacy-policy)
- Support: [support@browserless.io](mailto:support@browserless.io)
- [Create a Kiro power](https://kiro.dev/docs/powers/create/)
- [Kiro remote MCP and OAuth](https://kiro.dev/docs/mcp/configuration/)
- [Official contribution instructions](https://github.com/kirodotdev/powers/blob/main/CONTRIBUTING.md)
