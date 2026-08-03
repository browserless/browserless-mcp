# Browserless MCP — agent installation guide

This is the canonical setup guide for AI agents. Machine-readable setup truth is
committed at [`setup/browserless-mcp-setup.json`](setup/browserless-mcp-setup.json).

## Safe default: hosted MCP with OAuth

- URL: `https://mcp.browserless.io/mcp`
- Transport: Streamable HTTP
- Authentication order: OAuth first, Bearer header second

Do not ask the user to paste a Browserless token unless OAuth is unavailable.
Do not generate a `?token=` URL. The server still accepts that legacy fallback,
but URLs can leak through logs, history, and copied configuration.

### Codex

```bash
codex mcp add browserless --url https://mcp.browserless.io/mcp
codex mcp login browserless
```

### Claude Desktop

Remote servers are added in the UI, not in `claude_desktop_config.json`:

1. Open **Settings > Connectors**.
2. Add a custom connector with `https://mcp.browserless.io/mcp`.
3. Select **Connect** and finish OAuth in the browser.

### Claude Code

```bash
claude mcp add --transport http browserless https://mcp.browserless.io/mcp
claude mcp login browserless
```

### Cursor

Write `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp"
    }
  }
}
```

Reload MCP servers and complete OAuth when prompted.

### VS Code

Write `.vscode/mcp.json` for the workspace, or use VS Code's MCP command to add
the server to the user profile:

```json
{
  "servers": {
    "browserless": {
      "type": "http",
      "url": "https://mcp.browserless.io/mcp"
    }
  }
}
```

Run **MCP: List Servers**, start Browserless, and authenticate.

### Windsurf

Write `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "browserless": {
      "serverUrl": "https://mcp.browserless.io/mcp"
    }
  }
}
```

Refresh MCP servers and complete OAuth when prompted. Current Windsurf versions
accept `serverUrl` or `url`; the Browserless generated default uses `serverUrl`.

## Bearer-header fallback

If the client cannot complete OAuth, have the user place a Browserless API token
in the client's secret/input facility or a secure environment variable. Do not
ask them to paste its value into chat. Add this header template to that client's
remote HTTP server entry:

```json
{
  "headers": {
    "Authorization": "Bearer <BROWSERLESS_TOKEN>"
  }
}
```

Use a client secret/input facility or environment interpolation when available.
Never print the resolved token, and never commit it.

## Local stdio fallback

The published package requires Node.js 24+ and npm 11.10+:

```json
{
  "mcpServers": {
    "browserless": {
      "command": "npx",
      "args": ["-y", "@browserless.io/mcp"],
      "env": {
        "BROWSERLESS_TOKEN": "<BROWSERLESS_TOKEN>"
      }
    }
  }
}
```

This launches the package over stdio. For a self-hosted HTTP server, set
`TRANSPORT=httpStream` (and optionally `PORT=8080`) before exposing `/mcp`.

## Verify

First list tools and compare them with the full or compliant inventory in
`setup/browserless-mcp-setup.json`. Then call the contract's cross-surface
`browserless_export` verification tool with:

```json
{
  "url": "https://example.com"
}
```

A successful response includes the Example Domain content. An authentication
error means the OAuth session or Bearer header is invalid; a connection error
means the URL or network path is unavailable.
