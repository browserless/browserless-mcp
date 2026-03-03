# browserless-mcp

MCP (Model Context Protocol) server for [Browserless.io](https://browserless.io) — expose the Browserless power scraper API to LLM clients like Claude Desktop, Cursor, VS Code, and Windsurf.

## Quick Start

```bash
BROWSERLESS_TOKEN=your-token npx browserless-mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `browserless_powerscraper` | Scrape any webpage using cascading strategies (HTTP fetch, proxy, headless browser, captcha solving). Returns content in requested formats: `markdown`, `html`, `screenshot`, `pdf`, `links`. |

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

For hosted deployments or Docker, the server authenticates via the `Authorization` header. Pass your Browserless API token as a Bearer token:

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

To connect to an specific Browserless instance through the same MCP server, add the `x-browserless-api-url` header:

```json
{
  "mcpServers": {
    "browserless": {
      "url": "http://your-mcp-host:8080/mcp",
      "headers": {
        "Authorization": "Bearer your-token-here",
        "x-browserless-api-url": "https://your-browserless-instance.example.com"
      }
    }
  }
}
```

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
| `browserless://api-docs` | Power scraper API documentation |
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
