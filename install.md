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

Preferred: add a project server to `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "browserless": {
      "type": "http",
      "url": "https://mcp.browserless.io/mcp",
      "headers": {
        "Authorization": "Bearer ${BROWSERLESS_TOKEN}"
      }
    }
  }
}
```

Claude Code expands `${BROWSERLESS_TOKEN}` from the user's shell. Have the user
set it there, not paste it into chat. The Browserless CLI reads the same variable,
so local Chrome sync needs no second token. Never print or echo the value.

Alternatively, the user can run this locally (the shell expands the header):

```bash
claude mcp add --transport http browserless https://mcp.browserless.io/mcp --header "Authorization: Bearer ${BROWSERLESS_TOKEN}"
```

This defaults to local scope; add `--scope user` for all projects. Local and user
servers are stored in `~/.claude.json`, not Claude Code settings files.

## Profile import (CLI)

When running on the user's own machine with Node 24+, load the `profile-import`
skill for the complete recipe. Hosted agents without local browser access should
use `auth-profile` instead. Check `browserless_profiles` first to reuse a saved login.

```bash
npm install -g @browserless.io/cli
browserless profile terms
```

Show the disclaimer output verbatim and the proposed domain list, then wait for
an explicit yes before passing `--accept-terms`. With `BROWSERLESS_TOKEN` already
in the shell, upload only the consented site (and its identity-provider domains,
using additional `--only-domain` flags if needed):

```bash
browserless profile upload --browser chrome --profile Default --name <site> --only-domain <site> --accept-terms --json
```

Use the uploaded profile by passing `profile: "<site>"` to the MCP tools. Preserve
the same consented domain filters on retries and refreshes; follow the skill for
Keychain prompts, bounded recovery and authentication reporting.

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
