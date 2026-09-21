# Browserless plugin for Grok Build

Connect Grok Build to [Browserless](https://browserless.io) to scrape, search,
map, and crawl the web; automate a real browser; solve captchas; use residential
proxies and saved login profiles; run Lighthouse audits; export files; and
inspect session replays.

## Installation

Install directly from the official Browserless repository:

```bash
grok plugin install browserless/browserless-mcp#grok --trust
```

Only install plugins from sources you trust. Start a new Grok session after
installation.

## Authentication

By default, Grok opens Browserless sign-in in your browser on first connection.

To use a Browserless API token instead, set it outside the plugin and never
paste it into chat or commit it:

```bash
export BROWSERLESS_TOKEN='your-token'
```

Then add this user-level configuration to `~/.grok/config.toml`:

```toml
[mcp_servers.browserless]
url = "https://mcp.browserless.io/mcp"
headers = { Authorization = "Bearer ${BROWSERLESS_TOKEN}" }
```

## Network access

The plugin connects to these Browserless endpoints:

- `https://mcp.browserless.io/mcp` — hosted MCP using Streamable HTTP
- `https://mcp.browserless.io/.well-known/oauth-protected-resource` — OAuth
  protected-resource discovery
- `https://mcp.browserless.io/.well-known/oauth-authorization-server` — OAuth
  authorization-server discovery
- `https://mcp.browserless.io/oauth/register` — OAuth dynamic client
  registration
- `https://mcp.browserless.io/oauth/authorize` — OAuth authorization
- `https://mcp.browserless.io/oauth/callback` — OAuth authorization callback
- `https://mcp.browserless.io/oauth/token` — OAuth token exchange

Credentials: a Browserless account for OAuth, or a Browserless API token. OAuth
access tokens and API tokens authorize requests to the hosted MCP. No credential
is stored in this plugin.

Browserless tools may connect to URLs you ask them to visit. Features such as
browser automation, residential proxies, account data, saved profiles, exports,
and session replays use Browserless-operated API and asset hosts as needed.

## License

SSPL-1.0. See the repository's [LICENSE](../LICENSE).
