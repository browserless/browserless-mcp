# Bounded Browserless workflows

Check the live MCP tool schema before running these examples. Tool names may
have a client namespace prefix. These are example inputs, not automatic actions.

## Read one page

Use `browserless_smartscraper` with:

```json
{
  "url": "https://example.com",
  "formats": ["markdown"],
  "onlyMainContent": true
}
```

Return the observed page content with its source URL. A successful transport
response can still contain an extraction failure; inspect the result.

## Extract structured fields

Use the JSON format with an explicit schema:

```json
{
  "url": "https://example.com",
  "formats": ["json"],
  "jsonOptions": {
    "schema": {
      "type": "object",
      "properties": { "title": { "type": "string" } },
      "required": ["title"]
    }
  }
}
```

Validate the returned fields against the source. Missing values are missing
information, not a reason to invent them. JSON extraction uses additional AI
extraction units compared with basic page scraping.

## Discover before crawling

Use `browserless_map` with:

```json
{
  "url": "https://example.com",
  "limit": 10,
  "includeSubdomains": false
}
```

Review the returned URLs before choosing a crawl scope. For an authorized
multi-page crawl, set explicit page/depth/path limits from the current schema.
A job ID or in-progress response is not completed content: follow the returned
status instructions and report partial results as partial.

## Start and retain a browser session

First call to `browserless_agent`:

```json
{
  "commands": [{ "method": "goto", "params": { "url": "https://example.com" } }]
}
```

Read the resulting snapshot and retain the returned session ID. For a requested
screenshot, the next call uses that exact ID:

```json
{
  "sessionId": "<the sessionId returned by the first call>",
  "commands": [{ "method": "screenshot", "params": {} }]
}
```

The placeholder is explanatory; never send it literally. Verify the returned
image/artifact. After the task is complete, use the same session ID with a
`close` command. Do not reuse element references across a changed snapshot.

## Recover without losing context

- Authentication error: use Antigravity's Browserless plugin setup dialog to
  configure the API token. Do not ask for it in chat or write it into plugin files.
- Session expired: explain that state was lost, create a fresh session, and
  re-establish only the steps still authorized. Do not blindly repeat writes.
- Element not found: obtain a fresh snapshot and select a current reference.
- Partial/large output: narrow the requested page or fields instead of retrying
  the same broad extraction repeatedly.
- Download handle or URL: follow its returned storage/download instructions.
  Do not claim a local path from one machine exists on another.
- Access restriction: stop that operation and report the block. A different
  proxy or provider is not authorization to bypass it.
