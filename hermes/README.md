# Browserless plugin for Hermes Agent

Run [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s browser tools on
[Browserless](https://browserless.io) cloud browsers: stealth mode, residential proxies, ad blocking and
captcha solving, with no local Chrome needed.

This is a Hermes **browser provider** plugin. Hermes keeps its own browser tools (navigate, snapshot, click,
type, screenshot, …); the plugin supplies the browser they drive.

## Installation

Requires Hermes Agent 0.21 or later.

```bash
hermes plugins install browserless/browserless-mcp/hermes --enable
hermes config set browser.cloud_provider browserless
hermes config set browser.backend off
```

`browser.backend off` makes Hermes use its built-in browser tools (otherwise Browser Use mode takes over when
`uvx` or `browser-use` is on your PATH). You can also pick **Browserless** under _Browser Automation_ in
`hermes tools`.

Hermes drives the browser with [agent-browser](https://www.npmjs.com/package/agent-browser). Install it with
`npm install -g agent-browser`, or Hermes falls back to `npx`.

Only install plugins from sources you trust. Start a new Hermes session after installation.

## Authentication

Get an API token from your [Browserless account](https://www.browserless.io/account) and add it to
`~/.hermes/.env` (or your `HERMES_HOME`). Never paste it into chat or commit it:

```bash
BROWSERLESS_TOKEN=your-token
```

## Try it

```bash
hermes -t browser -z 'Open https://news.ycombinator.com and tell me the top 3 story titles'
```

`-t browser` makes Hermes use its browser tools (and so Browserless) rather than its web search/extract tools.

## Settings

Set these in `~/.hermes/.env` or the environment.

| Variable                         | Default                                 | Meaning                                                                          |
| -------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `BROWSERLESS_TOKEN`              | — (required)                            | Browserless API token                                                            |
| `BROWSERLESS_BASE_URL`           | `https://production-sfo.browserless.io` | Region endpoint, e.g. `https://production-lon.browserless.io`                    |
| `BROWSERLESS_STEALTH`            | `true`                                  | Stealth browser: hides `navigator.webdriver` and the "HeadlessChrome" user agent |
| `BROWSERLESS_PROXY`              | unset                                   | `residential` routes traffic through a residential IP (uses more plan units)     |
| `BROWSERLESS_PROXY_COUNTRY`      | unset                                   | Proxy exit country, e.g. `us`, `gb`, `de`                                        |
| `BROWSERLESS_PROXY_STICKY`       | `true`                                  | Keep the same proxy IP for the whole session                                     |
| `BROWSERLESS_SOLVE_CAPTCHAS`     | `false`                                 | Browserless detects and solves captchas (reCAPTCHA, Cloudflare, …) automatically |
| `BROWSERLESS_BLOCK_ADS`          | `false`                                 | Block ads and trackers                                                           |
| `BROWSERLESS_EXTRA_QUERY`        | unset                                   | Extra launch parameters appended as-is, e.g. `humanlike=true`                    |
| `BROWSERLESS_SESSION_TIMEOUT_MS` | `600000`                                | Max browser lifetime; lowered automatically to your plan's maximum               |
| `BROWSERLESS_KEEPALIVE_MS`       | `60000`                                 | How long the browser survives a dropped connection                               |
| `BROWSERLESS_UPSTREAM`           | `auto`                                  | `auto` (reconnect, falling back to the session API), `reconnect`, or `session`   |
| `BROWSERLESS_MUX_LOG`            | unset                                   | File path for a connection log (tokens redacted), useful for troubleshooting     |

## How it works

For each Hermes browser task the plugin starts one Browserless browser and a small local CDP multiplexer
(`ws://127.0.0.1:<random port>/devtools/browser/<secret>`). Hermes connects its clients (the agent-browser
daemon and its CDP supervisor) to that local address, and they all share a single connection to Browserless.
Your token never leaves the Hermes process.

The plugin keeps the browser alive across brief network drops (it reconnects to the same browser and page),
starts a fresh browser when your plan's session limit is reached, and closes the browser when the task ends,
on Ctrl+C, or when Hermes exits.

## Tips

- **One Hermes task = one Browserless browser.** It counts once toward your plan's concurrent-browser limit;
  parallel subagents each get their own browser.
- **Bot detection.** Stealth is on by default. For sites that block datacenter IPs, add
  `BROWSERLESS_PROXY=residential`. Some sites still block automated traffic even then.
- **Captchas.** With `BROWSERLESS_SOLVE_CAPTCHAS=true` (works best together with the residential proxy),
  Browserless solves detected captchas immediately on its side, so no waiting is needed. The captcha widget may
  still _look_ unsolved (e.g. an unticked reCAPTCHA checkbox); submit the form normally.
- **Passwords.** Hermes' agent won't type passwords itself; store them with `hermes vault add` and it fills
  them from the vault.
- **Quote prompts with single quotes** in zsh: `!` inside double quotes triggers history expansion.
- **Local URLs** (`localhost`, LAN addresses) are sent by Hermes to a local browser, not to Browserless,
  which can't reach your machine.
- Stealth, proxy, captcha and ad-block settings apply in the default reconnect mode, not with
  `BROWSERLESS_UPSTREAM=session`.

## Troubleshooting

If a Browserless session can't start (wrong token, too many browsers open, …), **Hermes silently falls back to
a local browser**. Set `BROWSERLESS_MUX_LOG=/tmp/browserless.log` and check it:

- `create_session ... upstream=reconnect options=stealth` means Browserless is in use;
- `create_session ... FAILED: <reason>` explains why it isn't.

To test the plugin without an LLM, run the smoke test with the Python interpreter of your Hermes install:

```bash
BROWSERLESS_TOKEN=your-token HERMES_HOME=~/.hermes /path/to/hermes/venv/bin/python hermes/scripts/smoke_test.py --drop-upstream
```

To install from a local checkout instead of the repository, run `hermes/scripts/install.sh`
(honours `HERMES_HOME` and `HERMES_BIN`).

## Network access

The plugin connects to:

- `wss://production-sfo.browserless.io/chromium/stealth` (or `/chromium`): starts the browser
  (host follows `BROWSERLESS_BASE_URL`)
- `wss://production-sfo.browserless.io/e/<id>/reconnect/<id>`: reconnects to the same browser
- `https://production-sfo.browserless.io/session`: session API, only if reconnect isn't available on your plan
- `127.0.0.1` (random port): the local multiplexer that Hermes connects to

Pages you ask Hermes to visit are loaded by the Browserless browser. The API token is sent only to the
Browserless endpoints above and is not stored by the plugin.

## License

SSPL-1.0, like the rest of this repository.
