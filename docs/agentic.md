Add the following configuration at you Claude/agent settings file:

```
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