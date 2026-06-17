# Changelog

## [1.6.2](https://github.com/browserless/browserless-mcp/compare/v1.6.1...v1.6.2) (2026-06-08)


### Bug Fixes

* drop stale COPY patches/ from Dockerfile ([#109](https://github.com/browserless/browserless-mcp/issues/109)) ([976e38d](https://github.com/browserless/browserless-mcp/commit/976e38d4b79643d60485a01cdee0c16486b17afd))

## Latest

- Add file upload/download support to `browserless_agent` via the `uploadFile` and `getDownloads` commands, plus a `file-transfers` skill. Downloads are persisted to the MCP server's filesystem and returned as handles — a path in stdio mode, a `browserless-download://` resource link in HTTP mode — so large base64 payloads never pass through the conversation. `uploadFile` accepts a `handle` (re-upload a downloaded file in either transport), a local `path` (stdio), or base64 `content`. Honors the server-side 10MB/50MB transfer cap.
- Add a `POST /upload` HTTP endpoint (httpStream transport) for staging a local file into the temp store out-of-band: `curl -F file=@path "<base>/upload?token=<token>"` returns a handle for `uploadFile`, so HTTP-mode uploads never base64 through the conversation. Token-gated (same rules as the MCP surface); staged files share the 15-minute TTL store.

## v1.6.1
Drop vestigial mcp-proxy postinstall patch that broke `npm install` in consumers

- Dependency updates

## v1.6.0 - 2026-06-01

- Dependency updates
- Release repo aws npm package

## v1.5.3 - 2026-05-27

- Add destructive hints for tools.

## v1.5.2 - 2026-05-27

- Enable OpenAI connectors in OAuth

## v1.5.0 - 2026-05-26

- Dependency updates
- Autonomous login skill

## v1.4.0 - 2026-05-22

- Refactor repo architecture
- Dependency updates
- Improve system prompt and skills
- Initial Open Source release

## v1.3.4 — 2026-05-15

- Add profile parameter to agent, function, download, export, and performance tools

## v1.3.3 — 2026-05-14

- Add profile parameter to smartscraper and crawl tools
- Implement error classification and cross-origin notice handling

## v1.3.2 — 2026-05-06

- Enable Devin domains for OAuth

## v1.3.1 — 2026-05-05

- Enable stateful connections

## v1.3.0 — 2026-04-30

- Skills
- Screenshot support for vision engines
- Captcha handling support

## v1.2.2

- Introduce tab management methods for agent

## v1.2.1

- Fix OAuth patch

## v1.2.0

- Improve OAuth security
- Improve agentic browsing

## v1.1.0

- Support agentic browsing

## v1.0.0

- Fix OAuth flow for multi instance cluster

## v0.5.0

- Add bounded event store to prevent memory leak + OpenAI challenge

## v0.4.3

- Added crawl endpoint to mcp

## v0.4.2

- Adding search and map apis to the MCP server

## v0.4.0

- Support OAuth

## v0.3.1

- Adding function, download and export apis to the MCP server

## v0.3.0

- replace power-scrape with smart-scrape endpoint

## v0.2.0

- Analytics Events
- Support token param in URL

## v0.1.2

- Fix vulnerabilities

## v0.1.1

- Support power-scrape api
- Cache per account
- Git Actions to version and create docker images
