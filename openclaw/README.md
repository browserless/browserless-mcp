# Browserless plugin for OpenClaw

Connect [OpenClaw](https://openclaw.ai) to [Browserless](https://browserless.io)
to scrape, search, map, and crawl the web; drive a real cloud browser; solve
captchas; use residential proxies and saved login profiles; run Lighthouse
audits; export files; and inspect session replays.

This is a lightweight plugin bundle. It contains no code. It registers the
hosted Browserless MCP server (`https://mcp.browserless.io/mcp`) and ships a
short skill that tells the agent which Browserless tool fits which task. All
tools come from the hosted server, so they stay current without updating the
plugin.

## Installation

From ClawHub:

```bash
openclaw plugins install clawhub:browserless
```

Or from a checkout of this repository (local installs ask you to confirm the
source and the plugin's capabilities):

```bash
git clone https://github.com/browserless/browserless-mcp.git
openclaw plugins install ./browserless-mcp/openclaw
```

Then confirm it loaded:

```bash
openclaw plugins inspect browserless
```

The output should show `Format: bundle` and `Bundle capabilities: skills, mcpServers`.
Start a new session to pick up the tools.

MCP tools follow OpenClaw's tool profiles: the `coding` and `messaging`
profiles include them, and `minimal` hides them.

## Authentication

### Sign in with Browserless (default)

The plugin declares the server with OAuth, so no credential is stored in the
plugin or in your config.

1. Open the OpenClaw Control UI and go to the **Browserless** plugin page.
2. Under **Accounts**, choose **Connect** and sign in to Browserless.
3. Return to OpenClaw. The account shows **Connected**.

Sign-in needs an administrator connection to the Control UI. If **Connect** is
missing, **Settings → MCP** may offer **Sign in** for the same server.

Browser sign-in only works when the Control UI is opened on the Gateway's own
address: its HTTPS address (including a reverse proxy or Tailscale Serve
route), its loopback address, or its published Tailscale address. A separately
hosted UI can't receive the sign-in callback. Plugin-page **Connect** needs
OpenClaw 2026.9.9 or later. In any of these cases, use the terminal sign-in
below.

Until you connect, OpenClaw leaves the Browserless tools out of sessions
instead of failing them. Credentials are stored in OpenClaw's owner-only state
database and are shared by the Gateway's operator-managed sessions (see
[Shared credentials](#shared-credentials)).

To sign in from a terminal, add a matching server entry, which lets the CLI see
it, then log in. The Gateway must be stopped while `login` runs:

```bash
openclaw mcp set browserless '{"url":"https://mcp.browserless.io/mcp","transport":"streamable-http","auth":"oauth"}'
openclaw gateway stop
openclaw mcp login browserless
openclaw gateway start
```

`login` prints an authorization URL and captures the redirect on a loopback
address. If your browser runs on another machine and can't reach that address,
finish with the `--code` command it prints.

### Use an API token

For headless or automated setups, use a Browserless API token from your
[account dashboard](https://browserless.io/account). Keep it out of chat and
out of committed config.

1. Put the token in the Gateway's environment. For a Gateway running as a
   service, use `~/.openclaw/.env`:

   ```bash
   echo "BROWSERLESS_TOKEN=your-token" >> ~/.openclaw/.env
   chmod 600 ~/.openclaw/.env
   ```

2. Override the plugin's server definition so it sends the token instead of
   using OAuth. OpenClaw expands `${BROWSERLESS_TOKEN}` when it connects; the
   config file only ever holds the variable name.

   ```bash
   openclaw mcp set browserless '{"url":"https://mcp.browserless.io/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer ${BROWSERLESS_TOKEN}"}}'
   ```

3. Check the connection:

   ```bash
   openclaw mcp doctor browserless --probe
   ```

   `doctor` reports `headers.Authorization contains a literal sensitive value`
   whenever the variable is set, because it checks the expanded value. Your
   config still holds only `${BROWSERLESS_TOKEN}`.

To go back to OAuth, remove the override with `openclaw mcp unset browserless`.

### Regional endpoints

To route requests through a specific Browserless region, add the
`x-browserless-api-url` header to your server entry, for example
`"x-browserless-api-url": "https://production-lon.browserless.io"`.

### Shared credentials

By default, one Browserless sign-in (or one API token) serves the whole
Gateway. Anyone who can message your agent, on any connected channel, can use
that account's units, saved login profiles, session replays and Stripe Link
checkouts. Link checkouts still need your approval in Link, but the request is
made.

On a Gateway that other people can message, consider hiding the tools that act
on your account rather than on a web page. First add the server entry from
[Authentication](#authentication) (the OAuth or the token version), then:

```bash
openclaw mcp tools browserless --exclude 'browserless_link_connect,browserless_link_checkout,browserless_profiles,browserless_sessions,browserless_function'
```

To give each sender their own Browserless account instead, OpenClaw supports
per-requester OAuth (`"oauth": {"identity": "per-requester"}` on the server
entry), which also needs `gateway.publicOrigin`. See OpenClaw's
[MCP transports](https://docs.openclaw.ai/cli/mcp/transports) docs.

## What's included

| Path                          | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `.mcp.json`                   | Registers the hosted Browserless MCP server (Streamable HTTP, OAuth).   |
| `skills/browserless/SKILL.md` | Tool-selection, browser-driving, and credential-safety guidance.        |
| `.claude-plugin/plugin.json`  | Bundle manifest. OpenClaw loads this package as a Claude-format bundle. |
| `package.json`                | Package name and version for ClawHub.                                   |

Tools appear in OpenClaw with the server prefix, for example
`browserless__browserless_smartscraper`. To expose only some of them, see
[Shared credentials](#shared-credentials).

## Task skills

Three standalone skills in `clawhub-skills/` add step-by-step workflows and
example prompts for common jobs. They are published to ClawHub separately and
are not part of the plugin package. Each one uses the plugin's tools and tells
the agent to ask for the plugin when the tools are missing.

| Skill                            | For                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `browserless-web-scraper`        | Reading pages, web research, finding pages on a site, crawling a section     |
| `browserless-browser-automation` | Logins, forms, multi-step flows, captchas, downloads, handing off to a human |
| `browserless-site-audit`         | Lighthouse audits, accessibility and SEO checks, PDFs, screenshots, archives |

```bash
openclaw skills install @browserless/browserless-web-scraper
```

## Network access

The plugin connects to these Browserless endpoints:

- `https://mcp.browserless.io/mcp` — hosted MCP using Streamable HTTP
- `https://mcp.browserless.io/.well-known/oauth-protected-resource/mcp` — OAuth
  protected-resource discovery
- `https://mcp.browserless.io/.well-known/oauth-authorization-server` — OAuth
  authorization-server discovery
- `https://mcp.browserless.io/oauth/register` — OAuth dynamic client
  registration
- `https://mcp.browserless.io/oauth/authorize` — OAuth authorization
- `https://mcp.browserless.io/oauth/token` — OAuth token exchange

Credentials: a Browserless account for OAuth, or a Browserless API token. No
credential is stored in this plugin.

Browserless tools may connect to URLs you ask them to visit. Features such as
browser automation, residential proxies, account data, saved profiles, exports,
and session replays use Browserless-operated API and asset hosts as needed.

## Publishing (maintainers)

The package is versioned on its own; bump `version` in `package.json`,
and `.claude-plugin/plugin.json` together. Then, from
the repository root:

```bash
clawhub package validate ./openclaw
clawhub package publish ./openclaw --dry-run
clawhub package publish ./openclaw
```

`clawhub package validate` writes reports to `openclaw/reports/`. They are
excluded from git by `.gitignore` and from the published package by
`.clawhubignore`, which also keeps `clawhub-skills/` out of the package.

Publish each task skill under the same owner, with the source linked:

```bash
clawhub skill publish ./openclaw/clawhub-skills/browserless-web-scraper \
  --owner browserless --source-repo browserless/browserless-mcp \
  --source-commit "$(git rev-parse HEAD)" \
  --source-path openclaw/clawhub-skills/browserless-web-scraper
```

Repeat for `browserless-browser-automation` and `browserless-site-audit`. Add
`--dry-run` first to preview. Skills get the next patch version unless you pass
`--version`.

Keep in mind:

- Publish only from a pushed commit that contains your `openclaw/` changes.
  ClawHub records the source commit from the local checkout, so publishing
  uncommitted files links the listing to a commit that doesn't have them.
- Keep exactly one bundle marker: `.claude-plugin/plugin.json`. Do not add
  `openclaw.plugin.json` or an `openclaw.extensions` field to `package.json`: native
  plugin detection takes precedence over bundle detection, so the MCP config and
  skill would no longer load as bundle capabilities. ClawHub accepts the bundle
  marker directly; it does not require a native manifest envelope. See the
  [OpenClaw detection rules](https://docs.openclaw.ai/plugins/bundles#detection-precedence)
  and [ClawHub publishing requirements](https://github.com/openclaw/clawhub/blob/main/docs/cli.md).

## License

SSPL-1.0. See the repository's [LICENSE](../LICENSE).
