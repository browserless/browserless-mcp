# Browserless MCP — Agent Installation Guide

This file is intended to be read by AI agents performing automated setup of the Browserless MCP server into an MCP client. For human-readable documentation, see [README.md](README.md).

**Server URL:** `https://mcp.browserless.io/mcp`
**Auth:** Bearer token via `Authorization: Bearer <token>` header, or `?token=<token>` query parameter.
**Token:** Obtain from [browserless.io](https://browserless.io). Ask the user for their API token before writing any config.

---

## Claude Desktop

Config file location: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

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

Run the following command (Claude Code CLI):

```bash
claude mcp add browserless --transport http "https://mcp.browserless.io/mcp?token=<BROWSERLESS_TOKEN>"
```

Or add manually to `.claude/settings.json` (project-level) or `~/.claude/settings.json` (global):

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

Config file location: `~/.vscode/settings.json` (user-level) or `.vscode/settings.json` (workspace-level). VS Code supports the `Authorization` header, so prefer that over the query parameter.

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

After writing, open the Windsurf MCP panel and click **Refresh** to connect.

---

## Verification

After installing, verify connectivity by asking the client to call:

```
browserless_smartscraper on https://example.com, returning markdown
```

A successful response returns the page content in markdown. If you get an auth error, the token is wrong. If you get a connection error, check the URL and network.
