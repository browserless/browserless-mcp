# Browserless MCP — Agent Installation Guide

This file is intended to be read by AI agents performing automated setup of the Browserless MCP server into an MCP client. For human-readable documentation, see [README.md](README.md).

**Server URL:** `https://mcp.browserless.io/mcp`
**Auth:** Bearer token via `Authorization: Bearer <token>` header (preferred), or `?token=<token>` query parameter (fallback — token may appear in server logs).
**Token:** Obtain from [browserless.io](https://browserless.io). Ask the user for their API token before writing any config.
**OAuth:** Claude Desktop and Cursor also support OAuth — connect without a token and the client will prompt sign-in via the browser.

---

## Claude Desktop

Config file location: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

Preferred (Bearer header):

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp",
      "headers": {
        "Authorization": "Bearer <BROWSERLESS_TOKEN>"
      }
    }
  }
}
```

Fallback (query parameter, token may appear in logs):

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp?token=<BROWSERLESS_TOKEN>"
    }
  }
}
```

After writing the file, tell the user to restart Claude Desktop for the change to take effect.

---

## Claude Code

Preferred (manual JSON — most reliable across CLI versions):

Add to `.claude/settings.json` (project-level) or `~/.claude/settings.json` (global):

```json
{
  "mcpServers": {
    "browserless": {
      "type": "http",
      "url": "https://mcp.browserless.io/mcp?token=<BROWSERLESS_TOKEN>"
    }
  }
}
```

Or via CLI (flag names may vary across versions — use the JSON snippet above if this fails):

```bash
claude mcp add browserless --transport http "https://mcp.browserless.io/mcp?token=<BROWSERLESS_TOKEN>"
```

---

## Cursor

Config file location: `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project-level).

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp?token=<BROWSERLESS_TOKEN>"
    }
  }
}
```

After writing, reload MCP servers in Cursor (open the MCP panel and click Refresh, or restart Cursor).

---

## VS Code

Config file location: `~/.vscode/settings.json` (user-level) or `.vscode/settings.json` (workspace-level).

```json
{
  "mcp": {
    "servers": {
      "browserless": {
        "type": "http",
        "url": "https://mcp.browserless.io/mcp",
        "headers": {
          "Authorization": "Bearer <BROWSERLESS_TOKEN>"
        }
      }
    }
  }
}
```

> If using VS Code with GitHub Copilot, the key may be `github.copilot.mcp` instead of `mcp` depending on your VS Code version and extension setup.

After writing, run the **MCP: List Servers** command in VS Code to confirm the server appears and connect.

---

## Windsurf

Config file location: `~/.codeium/windsurf/mcp_config.json`.

```json
{
  "mcpServers": {
    "browserless": {
      "serverUrl": "https://mcp.browserless.io/mcp?token=<BROWSERLESS_TOKEN>"
    }
  }
}
```

> Some versions of Windsurf use `url` instead of `serverUrl` — if the server doesn't appear after refreshing, try the other key.

After writing, open the Windsurf MCP panel and click **Refresh** to connect.

---

## Verification

After installing, call the `browserless_smartscraper` tool with:

```json
{
  "url": "https://example.com",
  "format": "markdown"
}
```

A successful response returns the page content in markdown. If you get an auth error, the token is wrong or was not passed correctly. If you get a connection error, check the URL and network.
