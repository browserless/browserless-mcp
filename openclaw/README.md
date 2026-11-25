# Browserless for OpenClaw

Give your OpenClaw agent a real cloud browser.
[Browserless](https://browserless.io) lets [OpenClaw](https://openclaw.ai) read
any page as clean markdown, search the web, and map or crawl entire sites. It
drives a full Chrome session to log in, fill forms and click through
multi-step flows, with captcha solving, residential proxies and saved logins
built in. It also runs Lighthouse audits, exports pages as PDFs and
screenshots, and records session replays so you can see exactly what the agent
did.

Install the plugin, sign in with your Browserless account, and the tools appear
in your agent's sessions, along with a skill that teaches the agent which tool
fits each task. The tools are served by Browserless's hosted MCP server
(`https://mcp.browserless.io/mcp`), so new capabilities arrive without updating
the plugin. No account yet?
[Create one for free](https://www.browserless.io/signup/email?plan=free).

## Installation

From ClawHub:

```bash
openclaw plugins install clawhub:@browserless/clawhub
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
2. Under **Accounts**, choose **Sign in** (called **Connect** in some OpenClaw
   versions) and sign in to Browserless.
3. Return to OpenClaw. The account shows as signed in.

Sign-in needs an administrator connection to the Control UI. If **Sign in** is
missing, **Settings → MCP** may offer **Sign in** for the same server.

Browser sign-in only works when the Control UI is opened on the Gateway's own
address: its HTTPS address (including a reverse proxy or Tailscale Serve
route), its loopback address, or its published Tailscale address. A separately
hosted UI can't receive the sign-in callback. Plugin-page sign-in needs
OpenClaw 2026.9.9 or later. In any of these cases, use the terminal sign-in
below.

Until you connect, OpenClaw leaves the Browserless tools out of sessions
instead of failing them. Credentials are stored in OpenClaw's owner-only state
database and are shared by the Gateway's operator-managed sessions (see
[Sharing a Gateway](#sharing-a-gateway)).

To sign in from a terminal, add a matching server entry, which lets the CLI see
it, then log in. These commands set up the Gateway's shared sign-in. If you use
per-requester sign-in (see [Sharing a Gateway](#sharing-a-gateway)), don't run
them: this `mcp set` entry switches `browserless` back to shared sign-in, so
everyone who messages the agent would use the account that logs in. With
per-requester sign-in, each person signs in from their own chat instead. The
Gateway must be stopped while `login` runs:

```bash
openclaw mcp set browserless '{"url":"https://mcp.browserless.io/mcp","transport":"streamable-http","auth":"oauth","requestTimeoutMs":360000}'
openclaw gateway stop
openclaw mcp login browserless
openclaw gateway start
```

`gateway stop` and `gateway start` control the managed Gateway service. If you
run the Gateway in the foreground or under your own supervisor, stop it there,
run `mcp login`, then start it the same way.

`login` prints an authorization URL and captures the redirect on a loopback
address. If your browser runs on another machine and can't reach that address,
finish with the `--code` command it prints.

### Use an API token

For headless or automated setups, use a Browserless API token from your
[account dashboard](https://browserless.io/account). Keep it out of chat and
out of committed config.

1. Put the token in the Gateway's environment. For a Gateway running as a
   service, use the `.env` file in its state directory: `~/.openclaw/.env` by
   default, or `$OPENCLAW_STATE_DIR/.env` if the Gateway runs with
   `OPENCLAW_STATE_DIR` set. Run this in bash or zsh with the same
   `OPENCLAW_STATE_DIR` as the Gateway. It prompts for the token, so the value
   stays out of the command line and shell history, and it restricts the file
   before writing to it:

   ```bash
   ENV_FILE="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/.env"
   printf 'Browserless token: '; read -rs BROWSERLESS_TOKEN; echo
   if [ -n "$BROWSERLESS_TOKEN" ]; then
     (umask 077 && touch "$ENV_FILE") && chmod 600 "$ENV_FILE" &&
       printf '\nBROWSERLESS_TOKEN=%s\n' "$BROWSERLESS_TOKEN" >> "$ENV_FILE"
   else
     echo "No token entered; nothing written." >&2
   fi
   unset BROWSERLESS_TOKEN
   ```

   If you press Enter without a token, or `touch` or `chmod` fails, nothing is
   written, so an existing token in the file stays in effect. You can also open the file
   in an editor and add the `BROWSERLESS_TOKEN=` line yourself. Continue to
   step 2 only once the file has a `BROWSERLESS_TOKEN=` line; otherwise step 2
   replaces OAuth with a token the Gateway doesn't have, and the Browserless
   tools stop working until you add one.

2. Override the plugin's server definition so it sends the token instead of
   using OAuth. OpenClaw expands `${BROWSERLESS_TOKEN}` when it connects; the
   config file only ever holds the variable name.

   ```bash
   openclaw mcp set browserless '{"url":"https://mcp.browserless.io/mcp","transport":"streamable-http","requestTimeoutMs":360000,"headers":{"Authorization":"Bearer ${BROWSERLESS_TOKEN}"}}'
   ```

   If the Gateway was already running, restart it so it reads the new
   variable. A `BROWSERLESS_TOKEN` already set in the Gateway's service or
   shell environment takes precedence over the `.env` file, and a restart
   doesn't change it, so update or remove that value first:

   ```bash
   openclaw gateway restart
   ```

   `gateway restart` applies to the managed service. A foreground or
   externally supervised Gateway needs restarting the way you started it.

3. Check the connection:

   ```bash
   openclaw mcp doctor browserless --probe
   ```

   `doctor` reports `headers.Authorization contains a literal sensitive value`
   whenever the variable is set, because it checks the expanded value. Your
   config still holds only `${BROWSERLESS_TOKEN}`.

To go back to shared OAuth, replace the entry in one `mcp set` that also
carries your tool filter, so the saved entry is never left unfiltered. Copy the
names under `toolFilter.exclude` from `openclaw mcp show browserless --json`
into the `exclude` list (drop the `toolFilter` field if you have none):

```bash
openclaw mcp set browserless '{"url":"https://mcp.browserless.io/mcp","transport":"streamable-http","auth":"oauth","requestTimeoutMs":360000,"toolFilter":{"exclude":["<every name from the show output>"]}}'
```

Then sign in with `gateway stop`, `mcp login` and `gateway start` from the
terminal sign-in above, skipping its `mcp set` line, which has no tool filter.
`openclaw mcp unset browserless` also returns to the plugin's shared OAuth
definition, but it removes the whole entry, including any tool filter. To use
per-requester sign-in instead, set the entry from
[Sharing a Gateway](#sharing-a-gateway); each person then signs in again from
their own chat.

### Server entries

`openclaw mcp set` replaces the whole `browserless` entry. Each time you run
it, keep `"requestTimeoutMs":360000` and any headers you added (such as a
[regional endpoint](#regional-endpoints)) in the JSON, and re-apply any tool
filter from [Sharing a Gateway](#sharing-a-gateway) afterwards. Before you
replace the entry, note the tools it currently excludes
(`openclaw mcp show browserless --json`, under `toolFilter.exclude`). Each
`mcp tools --exclude` replaces the previous list, so name every tool you want
hidden, including those; a tool you leave out becomes available to the agent
again. Crawls can run for
up to five minutes and Lighthouse audits for up to two, so a shorter request
timeout cuts them off.

### Regional endpoints

To route requests through a specific Browserless region, add the
`x-browserless-api-url` header to your server entry, for example
`"x-browserless-api-url": "https://production-lon.browserless.io"`.

### Sharing a Gateway

The Browserless connection belongs to the Gateway, so everyone who can message
your agent uses the same Browserless account: its units, saved login profiles
and session recordings. That suits a personal assistant or a team that shares
one account.

To narrow what a shared agent can do with the account, remove the tools it
doesn't need. First add the server entry from [Authentication](#authentication),
then, for example:

```bash
openclaw mcp tools browserless --exclude 'browserless_link_connect,browserless_link_checkout,browserless_sessions,browserless_function'
```

Saved login profiles are part of the account, so any tool that accepts a
`profile` can use them. To give each person their own Browserless account and
saved logins, use OpenClaw's per-requester sign-in. It needs
`gateway.publicOrigin` set to the Gateway's public HTTPS address:

```bash
openclaw mcp set browserless '{"url":"https://mcp.browserless.io/mcp","transport":"streamable-http","auth":"oauth","oauth":{"identity":"per-requester"},"requestTimeoutMs":360000}'
```

See OpenClaw's [MCP transports](https://docs.openclaw.ai/cli/mcp/transports)
docs for how per-requester sign-in works.

Per-requester sign-in separates Browserless accounts, but not conversations. By
default, direct messages share one session, so one person could see another's
Browserless results. If several people message the agent directly, set
`session.dmScope` to `"per-channel-peer"` as described in OpenClaw's
[session docs](https://docs.openclaw.ai/concepts/session). For people who
shouldn't trust each other, use separate Gateways and credentials.

## What's included

| Path                          | Purpose                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `.mcp.json`                   | Registers the hosted Browserless MCP server (Streamable HTTP, OAuth, 6-minute request timeout).      |
| `skills/browserless/SKILL.md` | Tool-selection, browser-driving, and credential-safety guidance.                                     |
| `.claude-plugin/plugin.json`  | Bundle manifest. OpenClaw loads this package as a Claude-format bundle.                              |
| `package.json`                | Package name and version for ClawHub.                                                                |
| `openclaw.plugin.json`        | Plugin id and the ClawHub category (`web`). Nothing else; see [Publishing](#publishing-maintainers). |
| `assets/icon.png`             | Listing icon on ClawHub (512×512).                                                                   |

Tools appear in OpenClaw with the server prefix, for example
`browserless__browserless_smartscraper`. To expose only some of them, see
[Sharing a Gateway](#sharing-a-gateway).

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

Once the skills are published to ClawHub, install one by name. Until then the
command fails because there is no listing; copy the skill's folder from
`clawhub-skills/` into your agent's skills directory instead.

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
clawhub package publish ./openclaw --owner browserless --dry-run
clawhub package publish ./openclaw --owner browserless \
  --topics "Browser Automation,Web Scraping,Web Search,Data Extraction,MCP"
```

`clawhub package validate` writes reports to `openclaw/reports/`. They are
excluded from git by `.gitignore` and from the published package by
`.clawhubignore`, which also keeps `clawhub-skills/` out of the package.

ClawHub releases every published skill under MIT-0, whatever license the
source repository uses, and the task skills are approved for MIT-0. Publish
each one under the same owner, with the source linked:

```bash
publish_skill() {
  clawhub skill publish "./openclaw/clawhub-skills/$1" \
    --owner browserless --source-repo browserless/browserless-mcp \
    --source-commit "$(git rev-parse HEAD)" \
    --source-path "openclaw/clawhub-skills/$1" --topics "$2"
}
publish_skill browserless-web-scraper "Web Scraping,Web Search,Data Extraction,Research"
publish_skill browserless-browser-automation "Browser Automation,Logins,Forms,CAPTCHA"
publish_skill browserless-site-audit "Lighthouse,Performance,SEO,Accessibility,Screenshots"
```

Add `--dry-run` to the function to preview first. Skills get the next patch
version unless you pass `--version`.

Keep in mind:

- Publish only from a pushed commit that contains your `openclaw/` changes.
  ClawHub records the source commit from the local checkout, so publishing
  uncommitted files links the listing to a commit that doesn't have them.
- `.claude-plugin/plugin.json` is what makes OpenClaw load this package as a
  bundle. `openclaw.plugin.json` is only there for the ClawHub category, the
  same pattern other bundle plugins on ClawHub use: keep it to `id`, `name`,
  `categories` and an empty `configSchema`. Never add an `openclaw.extensions`
  field to `package.json`. That makes OpenClaw load the package as a native
  plugin, and `.mcp.json` and the skill silently stop loading. Checked on
  OpenClaw 2026.11.5 and 2026.11.10: with both manifests, `openclaw plugins
inspect browserless` reports `Format: bundle` and
  `Bundle capabilities: skills, mcpServers`. See the
  [OpenClaw detection rules](https://docs.openclaw.ai/plugins/bundles#detection-precedence).

## License

The plugin is SSPL-1.0. See the repository's [LICENSE](../LICENSE). The task
skills in `clawhub-skills/` are MIT-0, as published on ClawHub. See
[clawhub-skills/LICENSE](clawhub-skills/LICENSE).
