# How `browserless-mcp` Works

A field guide for engineers who need to modify this project. Covers the architecture, install/run instructions, and concrete recipes for the modifications you're most likely to make: adding a tool, editing a skill, wiring up auth, etc.

> **Companion repo:** This project is a thin layer on top of the [`enterprise`](https://github.com/browserless/enterprise) repo (`/Users/andy/projects/enterprise` locally). Every tool here ultimately calls an HTTP/WS route defined in that repo. When in doubt about API shape or behavior, the enterprise repo is the source of truth — links to the relevant files appear throughout this document.

---

## 1. What this project is

`browserless-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. It exposes the Browserless API as a set of MCP **tools**, **resources**, and **prompts** that LLM clients (Claude Desktop, Cursor, VS Code, Windsurf, Claude.ai custom connectors, ChatGPT, etc.) can call directly.

It is built on [`fastmcp`](https://github.com/punkpeye/fastmcp). Two transports are supported:

- **`stdio`** — local process, the LLM client spawns the binary
- **`httpStream`** — long-running HTTP server, used for hosted deployments at `mcp.browserless.io`

The full list of tools, resources, prompts, and config knobs lives in [README.md](../README.md). This doc focuses on the _how_ and the _why_.

---

## 2. High-level architecture

```
LLM client (Claude / Cursor / etc.)
         │
         │  MCP protocol (stdio or HTTP+SSE)
         ▼
  ┌──────────────────────┐
  │  src/index.ts        │   ← entry point: builds FastMCP server,
  │  (FastMCP + auth)    │     registers everything, picks transport
  └──────────┬───────────┘
             │
   ┌─────────┼─────────┬─────────────┬──────────────┐
   ▼         ▼         ▼             ▼              ▼
 tools/    skills/   prompts/    resources/      lib/
 (10×)     (8 .md)    (2×)        (2×)         (api-client,
                                                agent-client,
                                                amplitude,
                                                cache, retry,
                                                redis-oauth)
             │                                       │
             │  ──────────── HTTP ──────────────►    │
             │  (POST /smart-scrape, /search,        │
             │   /map, /crawl, /performance, etc.)   │
             │                                       │
             │  ──────── WebSocket ────────────►     │
             │  (/chromium/agent — agent tool only)  │
             ▼                                       ▼
   ┌────────────────────────────────────────────────┐
   │    Browserless instance (enterprise repo)     │
   │    or browserless.io cloud                    │
   └────────────────────────────────────────────────┘
```

### Where each piece of code lives

| Path                                                            | Role                                                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [src/index.ts](../src/index.ts)                                 | Entry point. Constructs the FastMCP server, sets up OAuth/auth, wires every `register*` function, picks the transport.                                                         |
| [src/config.ts](../src/config.ts)                               | Reads `process.env` into a typed `McpConfig`. Single source of truth for all configurable values.                                                                              |
| [src/tools/](../src/tools/)                                     | One file per MCP tool. Each exports a `register<Name>Tool(server, config, amplitude)` function.                                                                                |
| [src/tools/schemas.ts](../src/tools/schemas.ts)                 | Zod parameter schemas for every tool. The schema _is_ the user-facing contract; LLMs see this verbatim.                                                                        |
| [src/lib/api-client.ts](../src/lib/api-client.ts)               | One HTTP client wrapping every Browserless REST endpoint we hit. Handles retries, timeouts, caching, base64 vs. text.                                                          |
| [src/lib/agent-client.ts](../src/lib/agent-client.ts)           | Persistent WebSocket session pool for the `browserless_agent` tool — distinct from the REST client because the agent tool needs stateful conversations with `/chromium/agent`. |
| [src/skills/](../src/skills/)                                   | Just-in-time guidance for the agent loop. `index.ts` is the registry + detection logic; `*.md` files are the actual prose injected into responses.                             |
| [src/prompts/](../src/prompts/)                                 | MCP prompts (user-invoked starter templates — not auto-injected).                                                                                                              |
| [src/resources/](../src/resources/)                             | MCP resources (live status + API docs the client can read).                                                                                                                    |
| [src/lib/redis-oauth-proxy.ts](../src/lib/redis-oauth-proxy.ts) | Multi-instance OAuth state store. Only used when `REDIS_URL` is set (hosted deploys behind a load balancer).                                                                   |
| [src/lib/account-resolver.ts](../src/lib/account-resolver.ts)   | Resolves a Supabase JWT → Browserless API key by hitting Supabase PostgREST.                                                                                                   |
| [src/lib/amplitude.ts](../src/lib/amplitude.ts)                 | Fire-and-forget analytics events sent via SQS. Disabled unless `ANALYTICS_ENABLED=true`.                                                                                       |

---

## 3. The request lifecycle

When an LLM client calls a tool:

1. **Transport receives the call.** stdio reads JSON from stdin; httpStream reads it from the HTTP body.
2. **Authentication runs** (httpStream only — see `hybridAuthenticate` in [src/index.ts:119-165](../src/index.ts#L119-L165)). The flow:
   - Plain `Authorization: Bearer <api-key>` header → use as-is
   - `?token=<api-key>` query param → use as-is
   - Authorization header with a JWT → resolve via Supabase to a Browserless API key
   - The token + chosen `apiUrl` are stashed on the FastMCP `session`
3. **The tool's `execute` callback runs.** It pulls `token`/`apiUrl` from the session (httpStream) or falls back to env vars (stdio). See [src/tools/smartscraper.ts:30-40](../src/tools/smartscraper.ts#L30-L40) for the canonical pattern.
4. **The HTTP/WS call to Browserless happens** via `createApiClient(...)` (REST) or `getOrCreateSession(...)` (WS).
5. **Result is converted to MCP `Content[]`** — text blocks, image blocks for screenshots, JSON for structured payloads. Every tool ends with `return { content: [...] }`.
6. **Analytics fires** (best-effort, never blocks the response).

### Tools that are just thin wrappers vs. tools with real logic

Most tools (`smartscraper`, `search`, `map`, `crawl`, `performance`, `function`, `download`, `export`) are **one HTTP call → one response**. They mostly translate parameters, handle errors, and shape the response.

Two tools are different:

- **`browserless_agent`** ([src/tools/agent.ts](../src/tools/agent.ts)) — drives a stateful WebSocket session against the enterprise `/chromium/agent` route. It maintains a session pool (15-min idle TTL, 500-session cap) keyed by MCP session ID, runs a ReAct loop (snapshot → plan → batch act → re-snapshot), and auto-injects skills.
- **`browserless_skill`** — just renders a skill `.md` file as text. The agent calls this when it suspects a non-trivial mechanic but the auto-detector didn't fire.

---

## 4. Connection to the `enterprise` repo

Each tool maps to one or more routes in the enterprise repo (or to OSS browserless routes that enterprise inherits). When debugging a tool, start by reading the matching enterprise file:

| MCP tool                   | Enterprise route         | File                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browserless_smartscraper` | `POST /smart-scrape`     | [enterprise/src/shared/http/smart-scrape.http.ts](/Users/andy/projects/enterprise/src/shared/http/smart-scrape.http.ts)                                                                                                                  |
| `browserless_search`       | `POST /search`           | [enterprise/src/shared/http/search.http.ts](/Users/andy/projects/enterprise/src/shared/http/search.http.ts)                                                                                                                              |
| `browserless_map`          | `POST /map`              | [enterprise/src/shared/http/map.http.ts](/Users/andy/projects/enterprise/src/shared/http/map.http.ts)                                                                                                                                    |
| `browserless_crawl`        | `POST/GET/DELETE /crawl` | [enterprise/src/cloud/http/crawl-post.http.ts](/Users/andy/projects/enterprise/src/cloud/http/crawl-post.http.ts), `crawl-get.http.ts`, `crawl-delete.http.ts`                                                                           |
| `browserless_export`       | `POST /chromium/export`  | [enterprise/src/shared/http/chromium.export.http.ts](/Users/andy/projects/enterprise/src/shared/http/chromium.export.http.ts)                                                                                                            |
| `browserless_function`     | `POST /function`         | OSS browserless (`@browserless.io/browserless`)                                                                                                                                                                                          |
| `browserless_download`     | `POST /download`         | OSS browserless                                                                                                                                                                                                                          |
| `browserless_performance`  | `POST /performance`      | OSS browserless                                                                                                                                                                                                                          |
| `browserless_agent` (WS)   | `WS /chromium/agent`     | [enterprise/src/shared/browserql/agent/agent.chromium.ws.ts](/Users/andy/projects/enterprise/src/shared/browserql/agent/agent.chromium.ws.ts), [`agent-api.ts`](/Users/andy/projects/enterprise/src/shared/browserql/agent/agent-api.ts) |

The agent tool is the one most often impacted by enterprise-side changes. If a new agent command is added in [agent-api.ts](/Users/andy/projects/enterprise/src/shared/browserql/agent/agent-api.ts) (e.g. a new `Browserless.*` method), the MCP's agent tool description, the schema, and possibly a skill all need updating in this repo.

---

## 5. Installing & running locally

### Prerequisites

- Node.js ≥ 18
- A Browserless API token (from [browserless.io](https://browserless.io)) **or** a self-hosted enterprise instance URL.

### Install

```bash
npm install
npm run build
```

`npm run build` runs `tsc` and copies the skill markdown files into `build/src/skills/` (they're loaded at runtime via `readFileSync`, so they must be physically present next to the compiled JS — see [src/skills/index.ts:51-53](../src/skills/index.ts#L51-L53)).

### Run against production

```bash
BROWSERLESS_TOKEN=your-token node build/src/index.js
```

### Run against a local enterprise instance

```bash
BROWSERLESS_TOKEN=any-local-token \
BROWSERLESS_API_URL=http://localhost:3000 \
node build/src/index.js
```

To bring up the enterprise instance: see the **Local Development with Docker** section in [enterprise/CLAUDE.md](/Users/andy/projects/enterprise/CLAUDE.md). TL;DR: `npm run docker:up:detached` in the enterprise repo, then point this MCP server at `http://localhost:3000`.

### Run as an HTTP server

```bash
TRANSPORT=httpStream PORT=8080 BROWSERLESS_TOKEN=your-token node build/src/index.js
```

Clients then connect via `http://localhost:8080/mcp` with `Authorization: Bearer <token>` or `?token=...`.

### Wiring it into a client

The simplest setup (stdio against a local build):

```json
{
  "mcpServers": {
    "browserless-agent": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/browserless-mcp/build/src/index.js"],
      "env": {
        "BROWSERLESS_TOKEN": "your-token",
        "BROWSERLESS_API_URL": "http://localhost:3000"
      }
    }
  }
}
```

For published-package and remote setups (Claude Desktop, Cursor, VS Code, Windsurf, Claude.ai custom connectors), see the [README](../README.md) — it has copy-pasteable JSON for each client.

### Tests

```bash
npm test            # builds, then runs every *.spec.js under build/test/
npm run coverage    # same, with c8 thresholds (lines ≥80, branches ≥70, functions ≥80)
```

The test suite stubs the Browserless API client — no token or live service is needed.

---

## 6. How to add a new tool

This is the most common modification. There's a fixed pattern; follow it.

### Step 1: Add the API method

If the new tool calls a new Browserless endpoint, add a method to `ApiClient` in [src/lib/api-client.ts](../src/lib/api-client.ts). Mirror an existing method (`map`, `performance`, `search` are good templates). The method should:

1. Accept a typed request param.
2. Build a `URLSearchParams` with `token` (and `timeout` if the endpoint supports it).
3. Call `retryWithBackoff(...)` so transient 5xx errors retry but 4xx don't.
4. Use `AbortController` with `timeout + 5000ms` so we always beat the server's own timeout.
5. Return a typed response.

If the new tool talks to the agent WebSocket, you don't need a new client — extend [src/lib/agent-client.ts](../src/lib/agent-client.ts) only if the protocol itself changes; otherwise just add a new `method` value that the existing `send()` will pass through.

### Step 2: Add the Zod schema

In [src/tools/schemas.ts](../src/tools/schemas.ts), define and export the parameter schema. The `.describe()` text on each field is **shown to the LLM** — be precise and concrete. LLMs use these descriptions to decide which tool to call and how to fill arguments, so vague descriptions cost real reliability.

### Step 3: Create the tool file

Create `src/tools/<name>.ts`. The skeleton:

```ts
import { FastMCP, UserError } from 'fastmcp';
import { MyToolParamsSchema } from './schemas.js';
import { createApiClient } from '../lib/api-client.js';
import { AmplitudeHelper, djb2 } from '../lib/amplitude.js';
import type { McpConfig } from '../config.js';

export function registerMyTool(
  server: FastMCP,
  config: McpConfig,
  amplitude?: AmplitudeHelper,
): void {
  server.addTool({
    name: 'browserless_mything',
    description:
      'One-paragraph explanation of when to use this tool. The LLM reads this verbatim.',
    parameters: MyToolParamsSchema,
    annotations: {
      title: 'Browserless My Thing',
      readOnlyHint: true, // false if it has side effects
      openWorldHint: true, // true if it touches the open web
    },
    execute: async (args, { session, log }) => {
      const token =
        (session?.token as string | undefined) ?? config.browserlessToken;
      if (!token) throw new UserError('No Browserless API token provided. ...');
      const apiUrl =
        (session?.apiUrl as string | undefined) ?? config.browserlessApiUrl;

      const client = createApiClient({
        ...config,
        browserlessToken: token,
        browserlessApiUrl: apiUrl,
      });
      const response = await client.myThing(args);

      amplitude
        ?.send('MCP Tool Request', djb2(token), {
          token,
          tool: 'browserless_mything',
          api_url: apiUrl,
          ok: true,
        })
        .catch(() => {});

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    },
  });
}
```

[src/tools/smartscraper.ts](../src/tools/smartscraper.ts) is the canonical reference — copy its structure, including the auth fallback, error handling, and analytics call.

### Step 4: Register the tool

Import and call your `register*Tool` from [src/index.ts](../src/index.ts), next to the other registrations (~line 174). One line.

### Step 5: Add a spec

Tests live in `test/tools/`. Stub `createApiClient` and assert that:

- Required params are validated (Zod throws on invalid input).
- The right API method is called with the right args.
- Errors surface as `UserError`.
- The response shape matches the contract.

### Step 6: Update the README

Add a row to the **Tools** table in [README.md](../README.md). This is the public docs.

---

## 7. Skills — what they are and why

### The problem they solve

The agent tool drives a generic browser. Real pages have non-generic mechanics: shadow-DOM banners, cookie consent, captchas, lazy-loading content, multi-tab flows, etc. Each of these has a specific recipe — a sequence of steps and selectors that work reliably.

We can't shove every recipe into the system prompt: it would be 50× longer, mostly irrelevant, and the LLM would skim it. We also can't expect the LLM to "just know" — selector syntax for shadow DOM, the difference between `wait*` methods, the `solve` command for captchas, etc., are all Browserless-specific and not in any LLM's training data.

**Skills are just-in-time guidance.** Each skill is a short markdown recipe that gets injected into the agent's response _only when_ the page state suggests it's relevant. The LLM gets the right recipe at the moment it needs it.

### How a skill is built

A skill is two things:

1. **A markdown file** in [src/skills/](../src/skills/) — the actual recipe. Written for an LLM reader: terse, imperative, code blocks with concrete selectors. See [src/skills/cookie-consent.md](../src/skills/cookie-consent.md) for an example.
2. **A registry entry** in [src/skills/index.ts](../src/skills/index.ts) — id, file path, body (loaded at startup), and a `detect(ctx)` predicate that decides when to fire.

```ts
{
  id: 'cookie-consent',
  path: 'src/skills/cookie-consent.md',
  body: loadBody('cookie-consent.md'),
  detect: ({ snapshot }) => {
    if (!snapshot?.elements) return false;
    return snapshot.elements.some((el) => {
      if (el.role !== 'button' && el.role !== 'link') return false;
      const name = el.name || el.text || '';
      return COOKIE_NAME_RE.test(name);
    });
  },
}
```

### Detection inputs

The `DetectContext` passed to `detect()` is built fresh after every agent command. It includes:

- `snapshot` — the latest page snapshot (elements, URL, tabs, detected challenges).
- `error` — the error from the just-executed command (if any).
- `cmd` — the command that just ran (`{ method, params }`).
- `resp` — the raw response.
- `apiUrl` — used by `cloudOnly` skills (e.g. captcha solving, which only works against the cloud regions).

### Firing rules

- **First match always fires.**
- **Refire suppression**: by default, once fired, a skill won't fire again for the same session. Add `refireAfter: N` to allow it to refire after `N` more commands have been issued (`shadow-dom` does this — the agent forgets across long sessions).
- **`cloudOnly: true`** restricts to `production-sfo.browserless.io` / `chrome.browserless.io` (see `CLOUD_API_HOSTS` and `isCloudApi`).

### Where the skill ends up

Triggered skills are rendered into the agent tool's response between `--- SKILL: <id> ---` and `--- END SKILL ---` markers (see `appendSkills` and `renderSkill` in [src/skills/index.ts](../src/skills/index.ts)). The agent's tool description teaches the LLM to read these blocks as authoritative recipes.

If detection misses, the LLM can also call `browserless_skill { id: "..." }` directly to load a recipe on demand.

### How to add a new skill

1. **Write the markdown.** Create `src/skills/<id>.md`. Keep it under ~80 lines. Lead with the trigger condition ("The current snapshot contains X"). Then: recipe steps, vendor-specific selectors if relevant, anti-patterns. Be terse.
2. **Add to the `SkillId` union** in [src/skills/index.ts](../src/skills/index.ts).
3. **Add a registry entry** with a `detect()` predicate. Test the predicate carefully — over-firing wastes tokens, under-firing means the agent flounders.
4. **Mention the skill in the agent tool description.** [src/tools/agent.ts:30-39](../src/tools/agent.ts#L30-L39) lists every skill so the LLM knows it can call `browserless_skill` for it.
5. **Build the skills bundle.** `npm run build` copies `*.md` from `src/skills/` to `build/src/skills/`. If you add a skill and tests fail at runtime with `ENOENT`, the markdown didn't get copied — check `package.json`'s `build:skills` script.
6. **Spec it.** Tests in `test/skills/` should cover both detection (`detect()` returns true/false on representative `DetectContext`s) and rendering.

### How to modify an existing skill

For prose changes: just edit the `.md` file and rebuild. No code changes.

For detection changes: edit the `detect` predicate in `index.ts` and update the spec.

If you change the trigger condition meaningfully, also update the matching bullet in the agent tool description — it's the user-visible contract for what each skill is _for_.

---

## 8. Prompts and resources

These are MCP-level extras that LLM clients surface in their UIs:

- **Prompts** ([src/prompts/](../src/prompts/)) — user-invoked templates (Claude Desktop shows them in the `/` menu). To add: copy `scrape-url.ts`, register in `index.ts`.
- **Resources** ([src/resources/](../src/resources/)) — readable URIs the client can fetch (e.g. `browserless://status`). To add: copy `status.ts`, register in `index.ts`.

Both are low-traffic compared to tools. Don't over-engineer.

---

## 9. Auth & deployment notes

The hosted deployment at `mcp.browserless.io` runs with `TRANSPORT=httpStream` and `OAUTH_ENABLED=true`. The flow is:

1. The user's MCP client does Dynamic Client Registration against this server.
2. The client redirects the user through Supabase OAuth.
3. Supabase issues a short-lived JWT (60s by default — we override to 1 hour in [src/index.ts:33-57](../src/index.ts#L33-L57) by intercepting the `/oauth/token` response).
4. The MCP client sends the JWT on every tool call as `Authorization: Bearer <jwt>`.
5. `hybridAuthenticate` decodes the JWT and calls `resolveApiKey` against Supabase PostgREST to resolve the user's Browserless API key — that's what's actually used to call the Browserless API.

Multi-instance state (OAuth flow tokens) lives in Redis when `REDIS_URL` is set ([src/lib/redis-oauth-proxy.ts](../src/lib/redis-oauth-proxy.ts)). For local dev, the in-memory FastMCP default is fine.

If a client is failing to register, check `oauthAllowedRedirectUriPatterns` in [src/config.ts](../src/config.ts) — new MCP hosts need their callback URI added. Set `OAUTH_ADDITIONAL_REDIRECT_URI_PATTERNS` (comma-separated) at runtime to extend without a code change.

---

## 10. Common modification recipes

### "The Browserless API added a new field — surface it in the tool's response"

1. Update the response type in [src/tools/schemas.ts](../src/tools/schemas.ts).
2. Update the corresponding API method in [src/lib/api-client.ts](../src/lib/api-client.ts) if it strips or transforms the field.
3. Update the tool's `execute` to include the field in the returned `Content[]`.
4. Update the spec.

### "The agent is hallucinating CSS selectors instead of using snapshot refs"

This is a prompt issue, not a skill issue. Edit the `TOOL_DESCRIPTION` in [src/tools/agent.ts](../src/tools/agent.ts) — specifically the **Snapshot Rules** and **Using Selectors** sections. The description is the agent's system prompt. Re-build, re-test against a representative page.

### "The agent is missing a non-obvious mechanic on a class of pages"

That's a new skill. Follow the recipe in §7.

### "We need to support a new Browserless region for OAuth users"

Region selection is per-request via the `x-browserless-api-url` header or `?browserlessUrl=` query param (see `hybridAuthenticate` in [src/index.ts](../src/index.ts)). No code change needed unless you want to add a new default — in which case edit `DEFAULT_API_URL` in [src/config.ts](../src/config.ts).

### "An enterprise PR changes the agent WebSocket protocol"

The agent tool depends on the message shape defined by [enterprise/src/shared/browserql/agent/agent-api.ts](/Users/andy/projects/enterprise/src/shared/browserql/agent/agent-api.ts) and [`types.ts`](/Users/andy/projects/enterprise/src/shared/browserql/agent/types.ts). If those change:

1. Update [src/lib/agent-client.ts](../src/lib/agent-client.ts) types (`SnapshotElement`, `SnapshotResult`, `AgentResponse`).
2. Check `formatElement` and `formatSnapshot` in [src/tools/agent.ts](../src/tools/agent.ts) — they depend on `SnapshotElement` shape.
3. If a new agent command is added: add it to `AgentParamsSchema` in [src/tools/schemas.ts](../src/tools/schemas.ts) and document it in `TOOL_DESCRIPTION`.
4. Run the agent specs against a local enterprise instance (`docker:up:detached`) — the unit tests stub the WS but won't catch protocol drift.

---

## 11. Pointers when something breaks

- **Skills not loading** → `build/src/skills/*.md` exist? `npm run build:skills` failed silently?
- **Auth loop / constant token refresh** → Supabase token TTL override broke. Check the `globalThis.fetch` interceptor at the top of [src/index.ts](../src/index.ts).
- **Tool works locally but not in hosted MCP** → likely an `oauthAllowedRedirectUriPatterns` mismatch, or Redis is misconfigured. Check server logs for `[browserless-mcp]` lines.
- **Agent tool times out on first command** → WebSocket can't reach `/chromium/agent`. Check the enterprise instance is reachable on the same `apiUrl` the REST tools use, and that the route is registered in the enterprise build.
- **Smart scraper returns empty content** → look at the `strategy` and `attempted` fields in the response metadata block. The enterprise `smart-scrape` route logs each strategy attempt.

When in doubt, the enterprise repo's CLAUDE.md has its own deep dive on the server side; this doc is the client (MCP) side.
