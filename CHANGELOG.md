# Changelog

## [1.7.1](https://github.com/browserless/browserless-mcp/compare/v1.7.0...v1.7.1) (2026-06-23)


### Bug Fixes

* prevent smartscraper from dominating tool selection ([#139](https://github.com/browserless/browserless-mcp/issues/139)) ([e3e8285](https://github.com/browserless/browserless-mcp/commit/e3e8285b680da9bfda347e0d0285840b93afda4c))

## [1.7.0](https://github.com/browserless/browserless-mcp/compare/v1.6.2...v1.7.0) (2026-06-23)


### Features

* agent file transfers ([#128](https://github.com/browserless/browserless-mcp/issues/128)) ([06483c1](https://github.com/browserless/browserless-mcp/commit/06483c1922744e1eef7b5130b4ce12d9f76978a6))
* allow mcp agents to create and save profiles ([#117](https://github.com/browserless/browserless-mcp/issues/117)) ([a928e2d](https://github.com/browserless/browserless-mcp/commit/a928e2da9705e52f33b39722a9d57646e0a7cd4b))
* enhance iframe handling AUTO-39 ([#132](https://github.com/browserless/browserless-mcp/issues/132)) ([70ba096](https://github.com/browserless/browserless-mcp/commit/70ba0967ab8185d6b797027d8759c332be7bce25))
* improve 429 error handling AUTO-158 ([#129](https://github.com/browserless/browserless-mcp/issues/129)) ([f4b0122](https://github.com/browserless/browserless-mcp/commit/f4b01222284bf12aa89f1ee26d1cf6da090f4fa6))
* surface load secrets from integrations ([#130](https://github.com/browserless/browserless-mcp/issues/130)) ([991daa7](https://github.com/browserless/browserless-mcp/commit/991daa70a5e814bb11338b7b05469870e613ea33))

## [1.6.2](https://github.com/browserless/browserless-mcp/compare/v1.6.1...v1.6.2) (2026-06-08)

### Bug Fixes

- drop stale COPY patches/ from Dockerfile ([#109](https://github.com/browserless/browserless-mcp/issues/109)) ([976e38d](https://github.com/browserless/browserless-mcp/commit/976e38d4b79643d60485a01cdee0c16486b17afd))

## Latest

- Add file upload/download support to `browserless_agent` via the `uploadFile` and `getDownloads` commands, plus a `file-transfers` skill. Downloads **auto-surface** on every agent response as a ledger — never the bytes, without the model calling `getDownloads`: completed files (handle/path), still-running ones (with progress, so the model re-checks on its next browser touch), and over-cap ones (source URL for a direct fetch). In stdio mode the file is saved locally and you get its path; `uploadFile` accepts a `handle`, a local `path`, or base64 `content`. Honors the server-side 10MB/50MB transfer cap.
- Add out-of-band HTTP file endpoints (httpStream transport), token-gated like the MCP surface: `POST /upload` stages a local file (`curl -F file=@path "<base>/upload?token=<token>"`) and returns a handle for `uploadFile`; `GET /download/<id>?token=<token>` fetches a captured download. Files share a temp store dropped after one download fetch, a 15-minute TTL, or session end — whichever comes first.
- **Removed the standalone `browserless_download` tool.** File downloads now go through `browserless_agent` (trigger the download, then it auto-surfaces) — a single path that never inlines bytes into context. Replaces the old tool that returned the file as base64.

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
