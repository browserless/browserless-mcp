# Changelog

## [1.26.0](https://github.com/browserless/browserless-mcp/compare/v1.25.0...v1.26.0) (2026-09-03)


### Features

* add recording functionality to mcp agent AUTO-376 ([#284](https://github.com/browserless/browserless-mcp/issues/284)) ([c1d422f](https://github.com/browserless/browserless-mcp/commit/c1d422f549910699b31bd5b25e54fcaeb5b45215))

## [1.25.0](https://github.com/browserless/browserless-mcp/compare/v1.24.0...v1.25.0) (2026-09-01)


### Features

* add vision fallback skill for clicking by coordinate when snapshot fails ([#274](https://github.com/browserless/browserless-mcp/issues/274)) ([d6c56a6](https://github.com/browserless/browserless-mcp/commit/d6c56a6ea20fa424e1be5f40b2b77f1822119159))

## [1.24.0](https://github.com/browserless/browserless-mcp/compare/v1.23.0...v1.24.0) (2026-08-25)


### Features

* render snapshot context signals ([#273](https://github.com/browserless/browserless-mcp/issues/273)) ([0164050](https://github.com/browserless/browserless-mcp/commit/0164050bc7efd7c9522e124f4aca4beea8a21afc))
* update `loadSecret` tool definition to mention mail OTP ([#267](https://github.com/browserless/browserless-mcp/issues/267)) ([c9d9988](https://github.com/browserless/browserless-mcp/commit/c9d99881ff56799377bbb95caa91e7296c37ede6))


### Bug Fixes

* PLT-1521 harden OAuth redirect matching ([#265](https://github.com/browserless/browserless-mcp/issues/265)) ([8ab07ab](https://github.com/browserless/browserless-mcp/commit/8ab07ab454f1f74a8f64e13196c62d16b157c2a9))

## [1.23.0](https://github.com/browserless/browserless-mcp/compare/v1.22.1...v1.23.0) (2026-08-24)


### Features

* bind 1Password integration to agent sessions so loadSecret can resolve op:// refs ([#264](https://github.com/browserless/browserless-mcp/issues/264)) ([108007e](https://github.com/browserless/browserless-mcp/commit/108007e07bba49562f6ef70dbe9175d543e25438))

## [1.22.1](https://github.com/browserless/browserless-mcp/compare/v1.22.0...v1.22.1) (2026-08-20)


### Bug Fixes

* update replay rendering instructions ([#262](https://github.com/browserless/browserless-mcp/issues/262)) ([a7adbdb](https://github.com/browserless/browserless-mcp/commit/a7adbdbdecad24d15e1943f94a2b52da72f796a6))

## [1.22.0](https://github.com/browserless/browserless-mcp/compare/v1.21.0...v1.22.0) (2026-08-19)


### Features

* enhance rrweb-player integration with dynamic CSS and JS slot filling ([#261](https://github.com/browserless/browserless-mcp/issues/261)) ([0e72c32](https://github.com/browserless/browserless-mcp/commit/0e72c3261423ba5362ce8b5ce1ef15f5f084e474))
* inline rrweb-player for self-contained session replays ([#259](https://github.com/browserless/browserless-mcp/issues/259)) ([180c19f](https://github.com/browserless/browserless-mcp/commit/180c19fd7b3bf0f1bf88b2c2e0d3fd73ef588006))

## [1.21.0](https://github.com/browserless/browserless-mcp/compare/v1.20.2...v1.21.0) (2026-08-19)


### Features

* account management tools ([#256](https://github.com/browserless/browserless-mcp/issues/256)) ([4af5c70](https://github.com/browserless/browserless-mcp/commit/4af5c7024adc9e1acb00ca18403ad4303e4356f9))

## [1.20.2](https://github.com/browserless/browserless-mcp/compare/v1.20.1...v1.20.2) (2026-08-11)


### Bug Fixes

* **agent:** ensure calls receive isolated browsers handle ([#249](https://github.com/browserless/browserless-mcp/issues/249)) ([f3fb119](https://github.com/browserless/browserless-mcp/commit/f3fb119cfcc705c5ff2da0949fb8d688fd7b6f2e))
* fill error gaps with more useful error outcomes ([#238](https://github.com/browserless/browserless-mcp/issues/238)) ([2a043e6](https://github.com/browserless/browserless-mcp/commit/2a043e69c794413559b66d6be5d66146d8c8b1c5))

## [1.20.1](https://github.com/browserless/browserless-mcp/compare/v1.20.0...v1.20.1) (2026-08-06)


### Bug Fixes

* **amplitude:** add token validation and deduplication for events AUTO-277 ([#235](https://github.com/browserless/browserless-mcp/issues/235)) ([1061d7c](https://github.com/browserless/browserless-mcp/commit/1061d7c008bdc4d10526b8ac0e096b8ddca8bed3))

## [1.20.0](https://github.com/browserless/browserless-mcp/compare/v1.19.0...v1.20.0) (2026-08-05)


### Features

* **skills:** implement remote skill cache with TTL and update hydration logic ([befc898](https://github.com/browserless/browserless-mcp/commit/befc8985257775f9ba7a5ae74b731df8b4d15672))

## [1.19.0](https://github.com/browserless/browserless-mcp/compare/v1.18.0...v1.19.0) (2026-08-04)


### Features

* **analytics:** enhance error categorization and enrich analytics events for tools ([#232](https://github.com/browserless/browserless-mcp/issues/232)) ([323ae67](https://github.com/browserless/browserless-mcp/commit/323ae673ecb6cc3d5bad1054dbe32f975c04b4c9))

## [1.18.0](https://github.com/browserless/browserless-mcp/compare/v1.17.0...v1.18.0) (2026-08-03)


### Features

* add session closing reminders to system prompts and agent tools ([#222](https://github.com/browserless/browserless-mcp/issues/222)) ([ece33bc](https://github.com/browserless/browserless-mcp/commit/ece33bce9796a4e54ab37559e4d56742ef27431b))

## [1.17.0](https://github.com/browserless/browserless-mcp/compare/v1.16.0...v1.17.0) (2026-08-03)


### Features

* add options field to SnapshotElement and update select command value description ([fcbcf18](https://github.com/browserless/browserless-mcp/commit/fcbcf18a52e68187e41812b35fe3095fef6a92fe))
* add session closing reminders to system prompts and agent tools AUTO-279 ([#219](https://github.com/browserless/browserless-mcp/issues/219)) ([8cc8fd1](https://github.com/browserless/browserless-mcp/commit/8cc8fd142e9b86d246389a7c9d0d83e03c1b1019))
* **analytics:** AUTO-265 emit MCP usage events to Amplitude via @amplitude/mcp-analytics ([#206](https://github.com/browserless/browserless-mcp/issues/206)) ([7028be6](https://github.com/browserless/browserless-mcp/commit/7028be66393ef9daf86e9b065c5776d34f01a8b4))
* enhance session continuity by attaching sessions to browserIds and not mcpSessions ([#218](https://github.com/browserless/browserless-mcp/issues/218)) ([44dd101](https://github.com/browserless/browserless-mcp/commit/44dd101608286e5a386ed6318996bbac08f01701))

## [1.16.0](https://github.com/browserless/browserless-mcp/compare/v1.15.0...v1.16.0) (2026-07-27)


### Features

* self-reported prompts, client and used skills ([#205](https://github.com/browserless/browserless-mcp/issues/205)) ([ee4f11a](https://github.com/browserless/browserless-mcp/commit/ee4f11aebfb181b7e454a8a547c5caa051c8bc17))

## [1.15.0](https://github.com/browserless/browserless-mcp/compare/v1.14.3...v1.15.0) (2026-07-21)


### Features

* pull skills from cloud ([#182](https://github.com/browserless/browserless-mcp/issues/182)) ([255dcc5](https://github.com/browserless/browserless-mcp/commit/255dcc58555307a4f9eac4a0fd4db2a5d93c128d))

## [1.14.3](https://github.com/browserless/browserless-mcp/compare/v1.14.2...v1.14.3) (2026-07-20)


### Bug Fixes

* add scripts directory copy in Dockerfile for build process ([a460e14](https://github.com/browserless/browserless-mcp/commit/a460e14fd513d1188a0f43889be5f8ec4b3a5cea))

## [1.14.2](https://github.com/browserless/browserless-mcp/compare/v1.14.1...v1.14.2) (2026-07-20)


### Bug Fixes

* resolve hoisted fastmcp in postinstall so npm ci installs cleanly ([#189](https://github.com/browserless/browserless-mcp/issues/189)) ([6e1a5e2](https://github.com/browserless/browserless-mcp/commit/6e1a5e23c8ce71d859491ba88a799e493a0f65f7))

## [1.14.1](https://github.com/browserless/browserless-mcp/compare/v1.14.0...v1.14.1) (2026-07-20)


### Bug Fixes

* publish patches and make patch-package a runtime dependency ([#187](https://github.com/browserless/browserless-mcp/issues/187)) ([969156d](https://github.com/browserless/browserless-mcp/commit/969156df70883686f8e5cb2cd69feb0ce2dc7d26))

## [1.14.0](https://github.com/browserless/browserless-mcp/compare/v1.13.0...v1.14.0) (2026-07-17)


### Features

* add source tracking for analytics ([#184](https://github.com/browserless/browserless-mcp/issues/184)) ([d4ebc83](https://github.com/browserless/browserless-mcp/commit/d4ebc83b5a1594f3c98c7f1cf237ad8fb1deee4a))


### Bug Fixes

* register all MCP tools via registerSurface so /mcp/connector stays compliant ([#186](https://github.com/browserless/browserless-mcp/issues/186)) ([78417cc](https://github.com/browserless/browserless-mcp/commit/78417cc6ca57de37f657e2f7816dfe2915203b9c))

## [1.13.0](https://github.com/browserless/browserless-mcp/compare/v1.12.0...v1.13.0) (2026-07-16)


### Features

* add prompt field for telemetry AUTO-248 ([#180](https://github.com/browserless/browserless-mcp/issues/180)) ([9a2119c](https://github.com/browserless/browserless-mcp/commit/9a2119cfbfa363a947f4ddb98962665f2840fcd2))
* force updating tool list on client connect AUTO-245 ([#181](https://github.com/browserless/browserless-mcp/issues/181)) ([3f526c0](https://github.com/browserless/browserless-mcp/commit/3f526c022212a8e093db2986441ca8c828d1e91c))
* get browserless profiles [AUTO-240] ([#179](https://github.com/browserless/browserless-mcp/issues/179)) ([8928462](https://github.com/browserless/browserless-mcp/commit/892846226613eb5bdea3ed1e4d38b0306488a328))

## [1.12.0](https://github.com/browserless/browserless-mcp/compare/v1.11.0...v1.12.0) (2026-07-15)


### Features

* add compliant MCP tool surface via MCP_COMPLIANCE_MODE  ([#166](https://github.com/browserless/browserless-mcp/issues/166)) ([0109fbb](https://github.com/browserless/browserless-mcp/commit/0109fbb0df6da462a392c19364f2179b43d5b6fe))


### Bug Fixes

* **auth:** PLT-1318 verify Supabase JWT signature before trusting accountId ([#176](https://github.com/browserless/browserless-mcp/issues/176)) ([4778052](https://github.com/browserless/browserless-mcp/commit/477805229b328fe8e93dc2213693925ab544bd57))

## [1.11.0](https://github.com/browserless/browserless-mcp/compare/v1.10.1...v1.11.0) (2026-07-09)


### Features

* bundle skills ([#165](https://github.com/browserless/browserless-mcp/issues/165)) ([e7e6b4e](https://github.com/browserless/browserless-mcp/commit/e7e6b4e1f51207076aaff9fd3ac7c454c66ee1f7))

## [1.10.1](https://github.com/browserless/browserless-mcp/compare/v1.10.0...v1.10.1) (2026-07-08)


### Bug Fixes

* allow-list Make.com Celonis-hosted MCP client OAuth redirect URIs ([#163](https://github.com/browserless/browserless-mcp/issues/163)) ([d3933d4](https://github.com/browserless/browserless-mcp/commit/d3933d47bc93f9af248cfac736d859f7136aa050))

## [1.10.0](https://github.com/browserless/browserless-mcp/compare/v1.9.0...v1.10.0) (2026-07-07)


### Features

* snapshot diffing AUTO-40 ([#154](https://github.com/browserless/browserless-mcp/issues/154)) ([9bca439](https://github.com/browserless/browserless-mcp/commit/9bca439f2e11f5ec9d65c581a18b22bdbeb036e2))


### Bug Fixes

* allow-list Make.com MCP client OAuth redirect URI ([#162](https://github.com/browserless/browserless-mcp/issues/162)) ([b52fa94](https://github.com/browserless/browserless-mcp/commit/b52fa94c7f9d0905cc51fbe3d77b600fafa3063f))

## [1.9.0](https://github.com/browserless/browserless-mcp/compare/v1.8.0...v1.9.0) (2026-06-30)


### Features

* include rationale in browserless_agent analytics event ([#147](https://github.com/browserless/browserless-mcp/issues/147)) ([4bd9233](https://github.com/browserless/browserless-mcp/commit/4bd923337f1994a9a6862803e5a4f7a3d9919f88))


### Bug Fixes

* drill multi-step sign-in choosers in autonomous-login skill ([#153](https://github.com/browserless/browserless-mcp/issues/153)) ([7119acc](https://github.com/browserless/browserless-mcp/commit/7119accf18885753d902cb53c68c39e8738426f4))

## [1.8.0](https://github.com/browserless/browserless-mcp/compare/v1.7.2...v1.8.0) (2026-06-25)


### Features

* add support for saving screenshots to disk with reusable handles ([#145](https://github.com/browserless/browserless-mcp/issues/145)) ([2ff2903](https://github.com/browserless/browserless-mcp/commit/2ff29037e469cf78aee40e63d2e066f312184995))

## [1.7.2](https://github.com/browserless/browserless-mcp/compare/v1.7.1...v1.7.2) (2026-06-24)


### Bug Fixes

* recognize DCR-issued client_id across instances in OAuth proxy ([#141](https://github.com/browserless/browserless-mcp/issues/141)) ([783528b](https://github.com/browserless/browserless-mcp/commit/783528bba831f2e077e4f68d464760c1e701015c))

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
