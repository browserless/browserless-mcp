# Installing Browserless MCP — agent guide

Read this if you're an AI agent (Cline, Claude Desktop, etc.) installing Browserless on a user's machine. Humans should read `README.md`.

## What this server does

Browserless is a hosted MCP server for browser automation. Ten tools: smart scraping, web/news/image search, sitemap mapping, full-site crawling, Lighthouse audits, custom Puppeteer execution, file downloads, native exports, and a persistent agentic-browsing loop with ref-based snapshots, captcha solving, and residential proxies.

## Install path: hosted (recommended)

Use the hosted server at `https://mcp.browserless.io/mcp`. No local install needed.

1. **Ask the user for their Browserless API token.** Get one at `https://browserless.io/account/`.
2. **Add the server to the MCP client config** (replace `<BROWSERLESS_TOKEN>` with the user's actual token):

```json
{
  "mcpServers": {
    "Browserless": {
      "url": "https://mcp.browserless.io/mcp?token=<BROWSERLESS_TOKEN>",
      "type": "streamableHttp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

3. **Reload the MCP client** so it picks up the new server.

> The token is passed via the `?token=` query parameter. `autoApprove: []` keeps all tool calls requiring user confirmation — recommended default. The client may flag a config-shape variant; some MCP clients use `transport` instead of `type` and `streamable-http` instead of `streamableHttp` — adjust if your client rejects the shape above.

## Install path: local stdio (fallback)

If the user needs a local-only / air-gapped install, use the npm package over stdio.

1. **Ensure Node.js >= 18 is installed.**
2. **Get the user's `BROWSERLESS_TOKEN`** (see above).
3. **Add to the MCP client config:**

```json
{
  "mcpServers": {
    "Browserless": {
      "command": "npx",
      "args": ["browserless-mcp"],
      "env": {
        "BROWSERLESS_TOKEN": "<BROWSERLESS_TOKEN>"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

4. **Reload the MCP client.**

## Verify install

Ask the client to call `browserless_smartscraper` on a simple URL:

```
Scrape https://example.com and return the markdown
```

A successful response returns markdown of the example page. If you get an auth error, the token is invalid. If you get a connection error, check the transport / URL / network.

## Region override (optional)

The hosted server defaults to SFO. For LON or AMS regions, append a query parameter:

```
https://mcp.browserless.io/mcp?token=<BROWSERLESS_TOKEN>&browserlessUrl=https://production-lon.browserless.io
```

Or send the header `x-browserless-api-url: https://production-lon.browserless.io` if the client supports custom headers.

## Token safety

`BROWSERLESS_TOKEN` is a billing-bound credential.

- Never log, print, or commit the token to a public repo.
- The `?token=...` query parameter is encrypted in transit (HTTPS), but URLs can leak via referer headers, browser history, and server logs. For maximum hygiene, prefer the stdio path (env var) or use the Bearer header form if your MCP client supports custom headers: `Authorization: Bearer <BROWSERLESS_TOKEN>`.
- Rotate immediately at `https://browserless.io/account/` if the token has been exposed.
