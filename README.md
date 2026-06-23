# Browserless MCP Server

[![MCP Badge](https://lobehub.com/badge/mcp/browserless-browserless-mcp?style=for-the-badge)](https://lobehub.com/mcp/browserless-browserless-mcp)

MCP (Model Context Protocol) server for [Browserless.io](https://browserless.io) — expose the Browserless smart scraper API to LLM clients like Claude Desktop, Cursor, VS Code, and Windsurf.

## Quick Start

Get an API token from [browserless.io](https://browserless.io) (free tier available), then point your MCP client at the hosted server:

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp?token=your-token-here"
    }
  }
}
```

No local install — see [Configuration](#configuration) for per-client snippets.

## Tools

| Tool                       | Description                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browserless_smartscraper` | Scrape a single webpage and return its content as markdown or HTML. Handles JavaScript-heavy pages and anti-bot measures automatically. For content across multiple pages, use `browserless_crawl`; to list a site's URLs, use `browserless_map`.                                                                                                                                                                                      |
| `browserless_search`       | Search the web using Browserless and optionally scrape each result. Supports web, news, and image search with geo-targeting and time filters.                                                                                                                                                                                                                                      |
| `browserless_map`          | Discover and map all URLs on a website. Scans via sitemaps and link extraction. Returns URLs with optional titles and descriptions. Useful for site audits and content discovery.                                                                                                                                                                                                 |
| `browserless_crawl`        | Crawl a website and scrape every discovered page. Supports depth control, path filtering, sitemap strategies, and configurable scrape options. Returns scraped content and metadata for each page.                                                                                                                                                                                 |
| `browserless_performance`  | Run Lighthouse audits on any URL. Returns scores and metrics for accessibility, best practices, performance, PWA, and SEO. Optionally filter by category or supply performance budgets.                                                                                                                                                                                            |
| `browserless_function`     | Execute custom Puppeteer JavaScript on the Browserless cloud. The function receives a `page` object and optional `context`; return `{ data, type }` to control the payload and Content-Type.                                                                                                                                                                                       |
| `browserless_export`       | Export a webpage via the Browserless `/export` API. Fetches the URL and returns its native content (HTML, PDF, image, etc.) with automatic content-type detection.                                                                                                                                                                                                                 |
| `browserless_agent`        | Drive a persistent browser session via a ReAct loop: snapshot the page, plan, batch interactions (click, type, scroll, evaluate, etc.), and re-snapshot. Uses ref-based selectors derived from snapshots, supports multi-tab workflows, screenshots, captcha solving, live URLs, and file upload/download (captured downloads auto-surface as handles; bytes never enter context). |
| `browserless_skill`        | Load an on-demand recipe for a non-trivial page mechanic (shadow DOM, cookie consent, modals, captchas, dynamic content, snapshot misses, screenshots, tabs). Companion to `browserless_agent`.                                                                                                                                                                                    |

## Skills

The server ships with a built-in library of **Skills** — on-demand recipes the agent can load to handle tricky page mechanics. Skills auto-inject into `browserless_agent` responses when their triggers fire (e.g. the agent hits a cookie banner), and can also be loaded manually via the `browserless_skill` tool.

| Skill             | Source                                                         | Purpose                                                                           |
| ----------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `shadow-dom`      | [src/skills/shadow-dom.md](src/skills/shadow-dom.md)           | Deep selectors and iframe targeting through shadow roots.                         |
| `cookie-consent`  | [src/skills/cookie-consent.md](src/skills/cookie-consent.md)   | Vendor-specific dismiss recipes (OneTrust, Cookiebot, Didomi, TrustArc, etc.).    |
| `modals`          | [src/skills/modals.md](src/skills/modals.md)                   | Closing dialogs, alertdialogs, and overlay close-button heuristics.               |
| `captchas`        | [src/skills/captchas.md](src/skills/captchas.md)               | Using the `solve` command, response semantics, and escalation paths (Cloud only). |
| `dynamic-content` | [src/skills/dynamic-content.md](src/skills/dynamic-content.md) | Choosing the right `wait*` method for async/AJAX/SPA content.                     |
| `snapshot-misses` | [src/skills/snapshot-misses.md](src/skills/snapshot-misses.md) | Handling truncated/empty snapshots and image-rendered content.                    |
| `screenshots`     | [src/skills/screenshots.md](src/skills/screenshots.md)         | When to screenshot vs. snapshot, scope and format choices.                        |
| `tabs`            | [src/skills/tabs.md](src/skills/tabs.md)                       | Multi-tab workflows and peek-without-switching via `targetId`.                    |

Load a skill explicitly:

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "browserless_skill",
    "arguments": { "id": "cookie-consent" },
  },
}
```

### Residential proxy (`browserless_agent`)

Pass a top-level `proxy` object on `browserless_agent` to route the session through residential IPs. Use this when targets IP-block datacenter traffic.

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "browserless_agent",
    "arguments": {
      "method": "goto",
      "params": { "url": "https://example.com" },
      "proxy": {
        "proxy": "residential",
        "proxyCountry": "us",
        "proxySticky": true,
      },
    },
  },
}
```

| Field                 | Notes                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `proxy`               | `"residential"` — only value supported today.                                                                                                 |
| `proxyCountry`        | ISO-2 country code (`"us"`, `"de"`). Auto-normalized to lowercase. Non-letter values are rejected.                                            |
| `proxyState`          | US state name with whitespace replaced by underscores (`"new_york"`). Paid-plan gated — non-eligible tokens get a 401.                        |
| `proxyCity`           | City target. Paid/enterprise plan gated — non-eligible tokens get a 401.                                                                      |
| `proxySticky`         | Stable IP while the underlying WebSocket stays open. Reconnects (idle drop, network blip, browser crash) allocate a new sticky id and new IP. |
| `proxyLocaleMatch`    | Match `navigator` locale to the proxy IP country.                                                                                             |
| `proxyPreset`         | Named preset (e.g. `"px_amazon01"`). Available presets are plan-dependent — ask Browserless support for your list.                            |
| `externalProxyServer` | Bring-your-own upstream, e.g. `http://user:pass@host:port`. Must be `http://` or `https://`.                                                  |

> **Note:** `proxyCountry` / `proxyState` / `proxyCity` / `proxySticky` / `proxyLocaleMatch` / `proxyPreset` require either `proxy: "residential"` or `externalProxyServer` to be set. The MCP rejects this combination at validation time; without it, the API would silently ignore them.

The `proxy` object is read once at session creation. To change it, call `close` and start a new session — the agent client keys sessions on the proxy fingerprint, so passing a different config will land on a fresh WebSocket.

## Configuration

The server is hosted at `https://mcp.browserless.io/mcp`. Authenticate via headers (preferred) or a `?token=` query parameter.

Installing via an AI agent? See [install.md](install.md) for agent-readable setup instructions.

**Using headers** (recommended for clients that support them):

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

**Using URL query parameters** (for clients like Claude.ai custom connectors that only accept a URL):

```text
https://mcp.browserless.io/mcp?token=your-token-here
```

To connect to a specific Browserless regional endpoint, add the `x-browserless-api-url` header or the `browserlessUrl` query parameter:

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here",
        "x-browserless-api-url": "https://production-lon.browserless.io"
      }
    }
  }
}
```

```text
https://mcp.browserless.io/mcp?token=your-token-here&browserlessUrl=https://production-lon.browserless.io
```

When both headers and query parameters are present, headers take precedence.

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp?token=your-token-here"
    }
  }
}
```

### Cursor

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp?token=your-token-here"
    }
  }
}
```

### VS Code

Add to your VS Code settings (`settings.json`):

```json
{
  "mcp": {
    "servers": {
      "browserless": {
        "url": "https://mcp.browserless.io/mcp",
        "headers": {
          "Authorization": "Bearer your-token-here"
        }
      }
    }
  }
}
```

### Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "browserless": {
      "url": "https://mcp.browserless.io/mcp?token=your-token-here"
    }
  }
}
```

## Self-Hosting

The server can also be run locally — useful for air-gapped deployments or pointing at a self-hosted Browserless instance. Clone this repo and build the Docker image:

```bash
docker build -f docker/Dockerfile -t browserless-mcp .

docker run \
  -e BROWSERLESS_TOKEN=your-token \
  -e BROWSERLESS_API_URL=https://your-browserless-instance.example.com \
  -p 8080:8080 \
  browserless-mcp
```

Then point your MCP client at `http://localhost:8080/mcp` using the same header/query-parameter auth as above.

### Self-hosted environment variables

| Variable                  | Required | Default                                 | Description                                        |
| ------------------------- | -------- | --------------------------------------- | -------------------------------------------------- |
| `BROWSERLESS_TOKEN`       | Yes      | —                                       | Your Browserless API token                         |
| `BROWSERLESS_API_URL`     | No       | `https://production-sfo.browserless.io` | API endpoint (for self-hosted Browserless)         |
| `TRANSPORT`               | No       | `stdio`                                 | Transport type: `stdio` or `httpStream`            |
| `PORT`                    | No       | `8080`                                  | HTTP server port (only for `httpStream` transport) |
| `BROWSERLESS_TIMEOUT`     | No       | `30000`                                 | Request timeout in milliseconds                    |
| `BROWSERLESS_MAX_RETRIES` | No       | `3`                                     | Max retry attempts for failed requests             |
| `BROWSERLESS_CACHE_TTL`   | No       | `60000`                                 | Cache TTL in milliseconds (0 to disable)           |

## MCP Resources

| Resource URI             | Description                     |
| ------------------------ | ------------------------------- |
| `browserless://api-docs` | Smart scraper API documentation |
| `browserless://status`   | Live service health status      |

## MCP Prompts

| Prompt            | Description                                 |
| ----------------- | ------------------------------------------- |
| `scrape-url`      | Scrape a webpage and summarize its content  |
| `extract-content` | Extract specific information from a webpage |

## Development

```bash
npm install
npm run build
npm test
npm run coverage
```

### Tests

The test suite uses [Mocha](https://mochajs.org/) with [Chai](https://www.chaijs.com/) and [Sinon](https://sinonjs.org/). Specs live alongside the code in `test/` (`test/lib/`, `test/tools/`, `test/prompts/`, `test/resources/`, `test/integration/`) and run against the compiled output in `build/`.

- `npm test` — compiles TypeScript and runs every `*.spec.js` under `build/test/`. No external services or `BROWSERLESS_TOKEN` are required; the API client is stubbed.
- `npm run coverage` — runs the suite under [c8](https://github.com/bcoe/c8) with the thresholds configured in `package.json` (lines ≥ 80%, branches ≥ 70%, functions ≥ 80%).

Tests run automatically on every pull request via the [Test workflow](.github/workflows/test.yml) on Node 24. PRs must keep the suite green before they can merge.

## API Token

Get your API token at [browserless.io](https://browserless.io). The token authenticates all requests to the Browserless API.

## License

SSPL-1.0
