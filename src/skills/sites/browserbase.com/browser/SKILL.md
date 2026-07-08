---
name: browser
description: Automate web browser interactions via the Browserless MCP tools. Use when the user asks to browse websites, navigate web pages, extract data from websites, take screenshots, fill forms, click buttons, or interact with web applications. Runs on Browserless cloud browsers with residential proxies and automatic CAPTCHA solving — ideal for protected websites and JavaScript-heavy pages.
compatibility: "Requires the Browserless MCP server (endpoint + bearer token). Page driving goes through the `browserless_agent` tool's `commands` array; web search through `browserless_search`."
license: MIT
allowed-tools: mcp__browserless-agent__browserless_agent, mcp__browserless-agent__browserless_search
metadata:
  homepage: https://browserless.io
---

# Browser Automation

Automate browser interactions using the Browserless MCP tools. Each `browserless_agent` call runs an ordered `commands` array against a cloud browser session that **persists across calls, keyed by the call's `proxy`/`profile`** — a later call carrying the same config reconnects to the same warmed browser (page, cookies, and session state intact). Batching a full flow (navigate → read → interact → confirm) into ONE call is still the default: it saves round-trips and avoids accidentally dropping the session config on a follow-up, not because the session would otherwise die.

## Session model

There is no local daemon and no `stop`/`status` bookkeeping — nothing to release. The session persists across calls, keyed by the call's `proxy`/`profile`; carry the same config to reconnect to it:

- **Simple / public sites** (docs, wikis, public pages): plain `browserless_agent` with no `proxy` arg.
- **Protected sites** (bot detection, CAPTCHAs, IP rate limiting, Cloudflare, geo-gating): add the top-level `proxy` arg (`proxy: { proxy: "residential" }`, optionally `proxyCountry: "us"`) and, when a challenge appears, a `solve` command. Repeat the `proxy` arg on EVERY call — dropping or changing it on a follow-up lands you in a different (default) session that looks logged out.

### When to escalate to a proxy / solve

Add `proxy` (and `solve`) when you detect: CAPTCHAs (reCAPTCHA, hCaptcha, Turnstile), bot-detection interstitials ("Checking your browser…"), HTTP 403/429, or empty pages on sites that should have content. Don't add a proxy for simple sites — it's slower and, on some anti-bot stacks (e.g. DataDome-style), counter-productive.

## Commands

Every command below is one object in the `browserless_agent` `commands` array.

### Navigation

```json
{ "method": "goto", "params": { "url": "https://example.com", "waitUntil": "load", "timeout": 45000 } }
{ "method": "reload", "params": { "waitUntil": "load" } }
```

Use `waitUntil: "load"` — never `networkidle0`/`networkidle2` (they hang on SPAs). `goto` replaces both "open" and the load-wait in one step.

### Page state (prefer snapshot/evaluate over screenshot)

```json
{ "method": "snapshot" }
{ "method": "text", "params": { "selector": "body" } }
{ "method": "html", "params": { "selector": "main" } }
{ "method": "evaluate", "params": { "content": "(()=>{ return JSON.stringify({ url: location.href, title: document.title }); })()" } }
```

`snapshot` returns the accessibility tree (each node carries a ref you can act on) — the default for understanding page structure. For large pages (Amazon-scale) prefer `evaluate` and project a compact result inside the eval; `snapshot` can exceed the result-size limit. `evaluate`'s return comes back under `.value` — wrap it in `JSON.stringify(...)` and return a projection, not raw DOM. Only take a screenshot when you need visual context (layout, images, debugging).

### Interaction

```json
{ "method": "click", "params": { "selector": "..." } }
{ "method": "type", "params": { "selector": "...", "text": "..." } }
{ "method": "select", "params": { "selector": "...", "value": "..." } }
{ "method": "checkbox", "params": { "selector": "...", "checked": true } }
{ "method": "scroll", "params": { "direction": "down" } }
{ "method": "waitForSelector", "params": { "selector": "...", "timeout": 10000 } }
{ "method": "waitForTimeout", "params": { "time": 2000 } }
```

Repeat `scroll` to append more batches on infinite-scroll pages. Use `waitForSelector` to gate on an element appearing, `waitForTimeout` for a fixed pause (spinners/animations).

### Anti-bot

```json
{ "method": "solve", "params": { "type": "cloudflare" } }
{ "method": "solve", "params": { "type": "dataDome" } }
```

Match the `type` to the challenge (`cloudflare`/`turnstile`, `dataDome`, `recaptcha`, `hcaptcha`). If a block is terminal (action = deny, no captcha presented), `solve` can't help.

### Web search

For "search the web" tasks, use the `browserless_search` tool directly instead of driving a search-engine page.

### Typical flow (one call)

1. `goto` the URL (`waitUntil: "load"`).
2. `snapshot` (or `evaluate`) to read structure and get element refs.
3. `click` / `type` / `select` to interact.
4. `snapshot` / `evaluate` again to confirm the action worked.
5. Repeat 3–4 as needed — all inside the same `commands` array so session state persists.

## Quick Example

A single `browserless_agent` call whose `commands` array is:

```json
[
  {
    "method": "goto",
    "params": {
      "url": "https://example.com",
      "waitUntil": "load",
      "timeout": 45000
    }
  },
  { "method": "snapshot" },
  {
    "method": "evaluate",
    "params": { "content": "(()=>JSON.stringify({title:document.title}))()" }
  }
]
```

## Mode Comparison

| Feature             | Plain `browserless_agent`                                                              | With `proxy` + `solve`                                    |
| ------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Speed               | Faster                                                                                 | Slightly slower                                           |
| CAPTCHA solving     | No                                                                                     | Yes (`solve`: reCAPTCHA/hCaptcha/Turnstile/DataDome)      |
| Residential proxies | No                                                                                     | Yes (`proxy: {proxy:"residential", proxyCountry:"us"}`)   |
| Session persistence | Across calls with the same `proxy`/`profile`; batch a flow in one call for convenience | Same; keep the whole flow in one call                     |
| Best for            | Public/simple pages                                                                    | Protected sites, geo-specific access, production scraping |

## Best Practices

1. **Keep multi-step flows in ONE call** — nav → read → interact → confirm in a single `commands` array, so cookies/session survive across steps.
2. **`goto` first** with `waitUntil: "load"` before interacting.
3. **Use `snapshot`** to read page state and get element refs; **`evaluate`** to parse in-page and return a compact projection.
4. **Only screenshot when visual context is needed** (layout, images, debugging).
5. **Repeat the `proxy` arg on every call** for protected sites — the session persists keyed by `proxy`/`profile`, and a dropped or changed proxy lands you in a different, logged-out session, not stale cookies.
6. **Escalate to `proxy` + `solve`** on 403/429, CAPTCHAs, or bot-detection interstitials; stay on plain `browserless_agent` for simple sites.

## Troubleshooting

- **Action fails / element missing**: run `snapshot` to see available elements and confirm the selector; large pages may need `evaluate` instead.
- **Empty/blocked page on a site that should have content**: add `proxy` and, if a challenge shows, a matching `solve` command.
- **Navigation hangs**: ensure `waitUntil: "load"` (not `networkidle`), and gate on a concrete element with `waitForSelector`.
- **Follow-up call is logged out**: you dropped the `proxy` (and so landed in a different session) — repeat the `proxy` arg and keep the flow in one call.

For detailed examples, see [EXAMPLES.md](EXAMPLES.md).
For API reference, see [REFERENCE.md](REFERENCE.md).
