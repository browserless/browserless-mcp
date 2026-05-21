# Installing Browserless MCP — agent guide

Read this if you're an AI agent (Cline, Claude Desktop, etc.) installing Browserless on a user's machine. Humans should read `README.md`.

## What this server does

Browserless is a hosted MCP server for browser automation. Ten tools: smart scraping, web/news/image search, sitemap mapping, full-site crawling, Lighthouse audits, custom Puppeteer execution, file downloads, native exports, and a persistent agentic-browsing loop with ref-based snapshots, captcha solving, and residential proxies.

## Install path: hosted (recommended)

Use the hosted server at `https://mcp.browserless.io/mcp`. No local install needed.

1. **Ask the user for their Browserless API token.** Get one at `https://browserless.io/account/`.
2. **Add the server to the MCP client config:**

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp",
      "transport": "streamable-http",
      "headers": {
        "Authorization": "Bearer <BROWSERLESS_TOKEN>"
      }
    }
  }
}
```

3. **Replace `<BROWSERLESS_TOKEN>` with the user's token.**
4. **Reload the MCP client** so it picks up the new server.

## Install path: local stdio (fallback)

If the user needs a local-only / air-gapped install, use the npm package over stdio.

1. **Ensure Node.js >= 18 is installed.**
2. **Get the user's `BROWSERLESS_TOKEN`** (see above).
3. **Add to the MCP client config:**

```json
{
  "mcpServers": {
    "browserless": {
      "command": "npx",
      "args": ["browserless-mcp"],
      "env": {
        "BROWSERLESS_TOKEN": "<BROWSERLESS_TOKEN>"
      }
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

A successful response returns markdown of the example page. If you get an auth error, the token is invalid. If you get a connection error, check the transport and URL.

## Region override (optional)

The hosted server defaults to SFO. For LON or AMS regions, the user can add a header:

```
x-browserless-api-url: https://production-lon.browserless.io
```

Or pass `?browserlessUrl=https://production-lon.browserless.io` as a query parameter on the MCP URL.

## Token safety

`BROWSERLESS_TOKEN` is a billing-bound credential. Store it the same way you'd store other API keys. Never log or print it. For Bearer auth on the hosted server, the token only leaves the user's machine when the MCP client calls Browserless directly — no third-party intermediary.
