# browserless-mcp

MCP (Model Context Protocol) server for [Browserless.io](https://browserless.io) — expose the Browserless smart scraper API to LLM clients like Claude Desktop, Cursor, VS Code, and Windsurf.

## Quick Start

```bash
BROWSERLESS_TOKEN=your-token npx browserless-mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `browserless_smartscraper` | Scrape any webpage using cascading strategies (HTTP fetch, proxy, headless browser, captcha solving). Returns content in requested formats: `markdown`, `html`, `screenshot`, `pdf`, `links`. |
| `browserless_performance` | Run Lighthouse audits on any URL. Returns scores and metrics for accessibility, best practices, performance, PWA, and SEO. Optionally filter by category or supply performance budgets. |

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BROWSERLESS_TOKEN` | Yes | — | Your Browserless API token |
| `BROWSERLESS_API_URL` | No | `https://production-sfo.browserless.io` | API endpoint (for self-hosted instances) |
| `TRANSPORT` | No | `stdio` | Transport type: `stdio` or `httpStream` |
| `PORT` | No | `8080` | HTTP server port (only for `httpStream` transport) |
| `BROWSERLESS_TIMEOUT` | No | `30000` | Request timeout in milliseconds |
| `BROWSERLESS_MAX_RETRIES` | No | `3` | Max retry attempts for failed requests |
| `BROWSERLESS_CACHE_TTL` | No | `60000` | Cache TTL in milliseconds (0 to disable) |

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browserless": {
      "command": "npx",
      "args": ["browserless-mcp"],
      "env": {
        "BROWSERLESS_TOKEN": "your-token-here"
      }
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
      "command": "npx",
      "args": ["browserless-mcp"],
      "env": {
        "BROWSERLESS_TOKEN": "your-token-here"
      }
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
        "command": "npx",
        "args": ["browserless-mcp"],
        "env": {
          "BROWSERLESS_TOKEN": "your-token-here"
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
      "command": "npx",
      "args": ["browserless-mcp"],
      "env": {
        "BROWSERLESS_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Remote (HTTP Stream)

For hosted deployments or Docker, the server supports authentication via headers or URL query parameters.

**Using headers** (recommended for clients that support them):

```json
{
  "mcpServers": {
    "browserless": {
      "url": "http://localhost:8080/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

To connect to a specific Browserless regional endpoint, add the `x-browserless-api-url` header:

```json
{
  "mcpServers": {
    "browserless": {
      "url": "http://your-mcp-host:8080/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here",
        "x-browserless-api-url": "https://production-sfo.browserless.io"
      }
    }
  }
}
```

**Using URL query parameters** (for clients like Claude.ai custom connectors that only accept a URL):

```text
https://your-mcp-host:8080/mcp?token=your-token-here
```

To also specify a regional endpoint:

```text
https://your-mcp-host:8080/mcp?token=your-token-here&browserlessUrl=https://production-sfo.browserless.io
```

When both headers and query parameters are present, headers take precedence.

## Docker

```bash
docker build -f docker/Dockerfile -t browserless-mcp .

docker run -e BROWSERLESS_TOKEN=your-token -p 8080:8080 browserless-mcp
```

## Self-Hosted Instances

Point to your own Browserless instance:

```bash
BROWSERLESS_TOKEN=your-token \
BROWSERLESS_API_URL=https://your-instance.example.com \
npx browserless-mcp
```

## MCP Resources

| Resource URI | Description |
|-------------|-------------|
| `browserless://api-docs` | Smart scraper API documentation |
| `browserless://status` | Live service health status |

## MCP Prompts

| Prompt | Description |
|--------|-------------|
| `scrape-url` | Scrape a webpage and summarize its content |
| `extract-content` | Extract specific information from a webpage |

## Development

```bash
npm install
npm run build
npm test
npm run coverage
```

## API Token

Get your API token at [browserless.io](https://browserless.io). The token authenticates all requests to the Browserless API.

## License

SSPL-1.0
