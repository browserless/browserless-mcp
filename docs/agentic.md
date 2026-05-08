Add the following configuration at your Claude/agent settings file:

```json
  "mcpServers": {
    "browserless-agent": {
      "type": "stdio",
      "command": "node",
      "args": [
        "path/to/proj/build/src/index.js"
      ],
      "env": {
        "BROWSERLESS_TOKEN": "1234",
        "BROWSERLESS_API_URL": "http://localhost:5555"
      }
    }
  }
```

## Residential proxying

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
        "proxySticky": true
      }
    }
  }
}
```

Supported fields:

| Field                 | Notes                                                                |
| --------------------- | -------------------------------------------------------------------- |
| `proxy`               | `"residential"` — only value supported today.                        |
| `proxyCountry`        | ISO-2 country code, lowercase preferred (`"us"`, `"de"`).            |
| `proxyState`          | Region/state name.                                                   |
| `proxyCity`           | Enterprise license only — non-enterprise tokens get a 403.           |
| `proxySticky`         | Stable IP for the session. Resets to a new IP if the WS reconnects.  |
| `proxyLocaleMatch`    | Match browser locale to the proxy geo.                               |
| `externalProxyServer` | Bring-your-own upstream, e.g. `http://user:pass@host:port`.          |

The `proxy` object is read once at session create. To change it, call `close` and start a new session — the agent client keys sessions on the proxy fingerprint, so passing a different config will land on a fresh WebSocket.