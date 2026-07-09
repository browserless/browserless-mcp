---
name: view-documentation
title: View Liveblocks Documentation
description: >-
  Look up Liveblocks developer documentation for any topic and return the page
  title, URL, and full content. Uses the site's machine-readable docs (llms.txt
  index + per-page .md endpoints) instead of scraping rendered HTML.
website: liveblocks.io
category: developer-docs
tags:
  - documentation
  - liveblocks
  - developer-docs
  - llms-txt
  - markdown
  - read-only
source: 'browserbase: agent-runtime 2026-06-13'
updated: '2026-06-13'
recommended_method: fetch
alternative_methods:
  - method: browser
    rationale: >-
      If the .md / llms.txt endpoints ever change or are unavailable, navigate
      the rendered docs page directly and extract text. ~100x slower and more
      brittle than fetch — the page is JS-rendered Next.js, so prefer the
      markdown endpoint.
  - method: fetch
    rationale: >-
      llms-full.txt (~2.9 MB) concatenates the entire docs corpus into one
      request — useful for full-text search / RAG ingestion when you don't yet
      know which page you need.
verified: false
proxies: false
---

# View Liveblocks Documentation

## Purpose

Look up Liveblocks developer documentation for a given topic and return the canonical page title, its URL, and the full page content (concepts, installation steps, code snippets, API references). Liveblocks publishes its docs as **machine-readable markdown** alongside the rendered HTML, so the optimal path is a plain HTTP `fetch` — no browser, no JavaScript rendering, no authentication, and no anti-bot stealth. Read-only.

## When to Use

- Answering a developer question from authoritative Liveblocks docs (e.g. "how do I set up Comments in Next.js?", "what hooks does `@liveblocks/react` export?", "how does access-token auth work?").
- Pulling a specific guide, API reference, or tutorial as clean markdown for summarization, RAG ingestion, or code generation.
- Enumerating every available docs page (the `llms.txt` index is a complete URL list).
- Bulk-ingesting the entire documentation corpus in a single request (`llms-full.txt`).

## Workflow

**Recommended method: `fetch`.** Liveblocks (a Next.js site on Vercel) exposes its docs three machine-readable ways. None require JS rendering, proxies, a stealth session, cookies, or auth — a plain HTTP GET of the endpoint works. Pre-run probe and live testing on 2026-06-13 showed **no anti-bot of any kind** on `liveblocks.io`.

Run the GET with a `browserless_function` that first navigates to the liveblocks.io origin, then does a **same-origin** `fetch` — the function body executes inside a browser page, so it only has network egress after `page.goto`:

1. **Discover the page URL from the index.** Fetch the docs index, which lists every documentation page with its title and URL:

   ```js
   export default async function ({ page }) {
     await page.goto('https://liveblocks.io/', {
       waitUntil: 'load',
       timeout: 45000,
     });
     const body = await page.evaluate(() =>
       fetch('/llms.txt').then((r) => r.text()),
     );
     return { data: body, type: 'text/plain' };
   }
   ```

   The index is grouped into sections (Readme, Ready-made features, SDKs and packages, Developers, Documentation). The `## Documentation` section is an explicit `TITLE → https://liveblocks.io/docs/...` list and is prefixed with the note: _"suffix docs URLs with `.md` to view markdown files."_ Match the requested topic to the closest entry (e.g. `GET_STARTED_REACT → https://liveblocks.io/docs/get-started/react`).

2. **Fetch the page as markdown** by appending `.md` to the docs path (reuse the same function, swapping the fetched path — the page is already on the liveblocks.io origin):

   ```js
   const body = await page.evaluate(() =>
     fetch('/docs/get-started/react.md').then((r) => r.text()),
   );
   ```

   Returns `Content-Type: text/markdown` (served by the internal route `/api/docs-raw/[...path]`). The body starts with a YAML frontmatter block (`meta.title`, `meta.parentTitle`, `meta.description`) followed by the full markdown content, including fenced code blocks. Internal links inside the markdown are **already rewritten with the `.md` suffix** (e.g. `[BlockNote with Next.js](/docs/get-started/nextjs-blocknote.md)`), so you can crawl deeper by following them directly.

3. **Extract and return.** Parse `meta.title` from frontmatter for the page title, use the canonical (non-`.md`) URL as `page_url`, and return the markdown body (or a summary + extracted `key_steps`/code snippets) per the schema below.

4. **(Optional) Whole-corpus fetch.** When you don't yet know which page you need, or you're building a search index:
   ```js
   const body = await page.evaluate(() =>
     fetch('/llms-full.txt').then((r) => r.text()),
   ); // ~2.9 MB, entire docs concatenated
   ```
   Each page within is delimited by its own frontmatter block. **Caution:** at ~2.9 MB this exceeds the function's ~200k-char text-return cap — slice or keyword-filter it _inside_ the `page.evaluate` and return only the matched sections, never the whole blob. Prefer the per-page `.md` fetch for targeted lookups — it's far smaller.

### Rendered-HTML fallback (only if the markdown endpoints ever change)

The `.md` / `llms.txt` endpoints are the contract; if they ever 404 or change shape, fall back to the rendered HTML with `browserless_agent`:

```json
{ "method": "goto", "params": { "url": "https://liveblocks.io/docs/get-started/react", "waitUntil": "load", "timeout": 45000 } }
{ "method": "waitForTimeout", "params": { "time": 2500 } }
{ "method": "text", "params": { "selector": "body" } }
```

This works (no proxy or stealth needed) but is ~100× slower and more brittle (JS-rendered Next.js app). Use the markdown endpoint whenever it's available.

## Site-Specific Gotchas

- **No anti-bot — do NOT enable stealth.** The successful runs used a plain session with no residential proxy and no stealth/verified mode. The pre-run probe reported `antibots: none detected` and live fetches all returned 200. Turning on proxies or stealth only adds cost and latency for zero benefit.
- **`.md` suffix is the killer feature.** Appending `.md` to _any_ `https://liveblocks.io/docs/...` URL returns the raw markdown source. This is stated directly in `llms.txt`. It is served by `/api/docs-raw/[...path]`, not a static file.
- **404 on a `.md` URL returns HTTP 404 with a helpful body**, not a silent redirect: `"Sorry, we don't have a markdown file for this page. Try visiting the page directly... For an overview of all available documentation, see /llms.txt"`. If you hit this, your URL/path is wrong — re-derive it from `llms.txt` (titles in the index are UPPER_SNAKE aliases, not the page's real `meta.title`; trust the URL, not the alias).
- **Frontmatter is part of the body.** The `.md` response begins with a `---` YAML block (`meta.title`, `meta.parentTitle`, `meta.description`, sometimes `alwaysShowAllNavigationLevels`). Strip or parse it; don't treat it as page content.
- **Index titles ≠ page titles.** In `llms.txt` the docs are labelled with screaming-snake aliases like `GET_STARTED_REACT`, `FEATURES_COMMENTS_HOOKS`, `API_REFERENCE_REACT`. The human page title comes from the fetched page's `meta.title` (e.g. `GET_STARTED_REACT` → _"Get started with Liveblocks and React"_).
- **API reference pages are large.** `liveblocks-react.md` is ~219 KB and `llms-full.txt` is ~2.9 MB. Budget for big responses; fetch the specific `.md` page rather than the full corpus when you can.
- **`pricing.md` exists too.** Non-docs marketing pages aren't all markdown-backed, but `/pricing.md` is explicitly listed in `llms.txt` as a markdown alternative to `/pricing`.
- **Liveblocks also ships an MCP server** (`/docs/tools/mcp-server`) and "agent skills" (`/docs/tools/agent-skills`) — but those are for _operating_ Liveblocks projects/APIs, not for reading docs. For pure documentation lookup, the `fetch` path above is simpler and needs no setup.
- **Caching:** responses are served via Vercel edge with `X-Vercel-Cache: HIT` and a long `Age`. Content is effectively static between releases; safe to cache locally.

## Expected Output

```json
// Success — single page fetched as markdown
{
  "success": true,
  "method": "fetch",
  "topic": "get started with Liveblocks in React",
  "page_title": "Get started with Liveblocks and React",
  "page_url": "https://liveblocks.io/docs/get-started/react",
  "content_summary": "Step-by-step quickstart for adding realtime collaboration to a React app using @liveblocks/client and @liveblocks/react: install packages, init the config file, set up LiveblocksProvider + RoomProvider, join a room with ClientSideSuspense, sync shared state with useStorage/useMutation, show presence with useOthers, and configure auth.",
  "key_steps": [
    "Install packages: npm install @liveblocks/client @liveblocks/react",
    "Initialize config: npx create-liveblocks-app@latest --init --framework react",
    "Set up LiveblocksProvider (publicApiKey) and RoomProvider (room id) in App.tsx",
    "Wrap room children in ClientSideSuspense for loading states",
    "Define typed Storage and set initialStorage on RoomProvider",
    "Read shared state with useStorage; update it with useMutation",
    "Access connected users with useOthers to build presence (e.g. avatar stack)",
    "Optionally add an authentication endpoint to restrict room access"
  ],
  "markdown": "---\nmeta:\n  title: \"Get started with Liveblocks and React\"\n  ...\n---\n\n# Get started ...",
  "error_reasoning": null
}
```

```json
// Topic not matched to a page (index lookup found no good candidate)
{
  "success": false,
  "method": "fetch",
  "topic": "<requested topic>",
  "error_reasoning": "No documentation page in /llms.txt matched the topic. Closest candidates: [GET_STARTED_REACT, GET_STARTED_NEXTJS]. Ask the user to narrow the topic or pick a candidate."
}
```

```json
// .md endpoint 404 (wrong path)
{
  "success": false,
  "method": "fetch",
  "topic": "<requested topic>",
  "page_url": "https://liveblocks.io/docs/<bad-path>",
  "error_reasoning": "GET /docs/<bad-path>.md returned 404 ('no markdown file for this page'). Re-derive the URL from /llms.txt."
}
```
