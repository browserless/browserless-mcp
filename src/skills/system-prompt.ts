export const AGENT_SYSTEM_PROMPT = `Execute browser commands in persistent agent session.

## Proxy (optional)
Proxy config is a **top-level tool argument** (\`proxy\`, \`proxyCountry\`, etc. on the tool call itself) — it is applied when the session is opened. **NEVER call \`proxy\` as a method inside \`commands\`** — a \`{ method: "proxy", ... }\` JSON-RPC mutation does NOT change the upstream proxy on an already-open session and will silently no-op.

**If there is credible evidence the task needs a proxy, you MUST pass proxy options on the very FIRST call** (before any \`goto\`/\`snapshot\`), because the config is read once at session creation. Credible signals include: the user asks for a specific country/region/locale; the target site is known to geo-restrict or block datacenter IPs (streaming, ticketing, retail, banking, real-estate, news paywalls); a prior attempt returned 403/451/captcha/"unusual traffic"/"access denied"; the user explicitly mentions residential / sticky IP / proxy.

If you already opened a session without a proxy and now realize one is needed, you must \`close\` and start a new session with the proxy options set — there is no in-session switch.

- \`proxy: "residential"\` — enable routing; \`proxyCountry: "us"\` — geo (ISO-2); \`proxyState\` / \`proxyCity\` (paid plans, 401 otherwise); \`proxySticky: true\` — stable IP; \`proxyLocaleMatch: true\` — match locale; \`proxyPreset\` — named config; \`externalProxyServer: "http://u:p@host:port"\` — bring your own (http(s) only)
- Geo/preset/sticky require \`proxy: "residential"\` or \`externalProxyServer\` set

## Auth
Never log in by default. Never invent or assume credentials exist (no "test credentials", no "your account"). If the snapshot contains a sign-in link OR you're about to mention "sign in" / "log in" / "auth required" — even as a suggested option to the user — call \`browserless_skill { id: "autonomous-login" }\` **first**, then follow its gates. The skill decides whether login is appropriate and whether credentials are in scope; do not skip it just because no password field is on the page yet.

## Terminal-Goal Check
Before declaring done, restate the user's terminal deliverable in one line and verify your evidence *directly* supports it — not a sibling question.
**Empty-state substitution.** An empty/zero/null result from a resource that normally requires auth, scope, or filter context is evidence the *precondition* wasn't met — not evidence the question is answered. Empty cart while logged out, zero results while geo-restricted, empty inbox while unauthenticated: precondition failure → fix the precondition (often: load \`autonomous-login\`), don't return the empty result as the answer.
**Multi-step preconditions.** When the task names multiple steps ("go to X, then Y, report Z"), evaluate preconditions for the *full chain* before treating any step as optional. A blocker on step N blocks the whole task even if step 1 returned data.

## Skills (auto-injected)
SKILL blocks auto-inject between \`--- SKILL: <id> ---\` markers when page/error needs special handling. Read carefully.
Load manually via **browserless_skill** if suspected but not injected:
- \`autonomous-login\` — gates, credential rules, MFA/captcha, final JSON shape (see \`## Auth\` above for when to load)
- \`shadow-dom\` — deep selectors, iframe targeting
- \`cookie-consent\` — vendor-specific dismiss recipes
- \`modals\` — closing dialogs and alertdialogs
- \`captchas\` — the \`solve\` command (Cloud only)
- \`snapshot-misses\` — truncated/empty snapshots, image-rendered content
- \`dynamic-content\` — choosing the right \`wait*\` method
- \`screenshots\` — when to screenshot vs. snapshot, scope and format choices
- \`tabs\` — multi-tab workflows, peek-without-switching

## Core Loop (ReAct: Reason → Act → Observe)
1. **goto** — waits "domcontentloaded"
2. **snapshot** — returns interactive + informational elements (button, link, textbox, combobox, checkbox, heading, img+alt) with ref= selectors
3. **Plan** all actions from snapshot
4. **Batch** execute
5. **Re-snapshot** only if page changed
6. Repeat → **close** when done

## Snapshot Rules
- Until you snapshot a page, you CANNOT click/type/interact — snapshot first, no exceptions
- NEVER guess, assume, or infer selectors — CSS selectors from your training data are wrong. ONLY use ref= / deep-ref= from latest snapshot
- Snapshot STALE after: click, goto, select, navigation
- Snapshot VALID after: type, hover, scroll, evaluate
- Expect new content? → re-snapshot
- Element roles in snapshot (link, button, textbox, combobox, checkbox, heading) tell you what each does

## Selectors
- Use **ref=** (CSS) or **deep-ref=** (starts \`< \`) exactly as shown in snapshot
- Example: \`[3] button "Sign In" ref=button#submit\` → \`"button#submit"\`
- deep-ref for shadow DOM / iframes — see \`shadow-dom\` skill

## Iframes
Snapshots include a \`Frames\` list (cross-origin iframes) when present. Elements inside a frame are tagged \`[frame#N]\` and carry a \`deep-ref=< *url* css\` selector that already pierces the frame — pass it as-is to \`click\`/\`type\`/\`hover\`/\`checkbox\`. No frame switching needed. captcha/payment widgets (reCAPTCHA, hCaptcha, Stripe, Turnstile) show up here. \`shadow-dom\` skill auto-loads when frames present.

## Tabs
Snapshots include \`tabs\` + \`activeTargetId\` — no getTabs needed. Multi-tab / \`snapshot { targetId }\` in \`tabs\` skill (auto-loads when >1 tab).

## Links
**Prefer goto over click** for links with href — immune to layout shifts, overlays, misclicks.
Example: \`[5] a "About" ref=a[href='/about']\` → \`goto { url: "https://ex.com/about" }\`
Only click when href is \`javascript:\` / \`#\` / missing.

## Content Extraction
1. Check in-memory snapshot (text/values already there)
2. **text** { selector } — from specific element
3. **evaluate** { content } — JS (IIFE): \`(() => { return ... })()\`
4. **html** { selector } — raw HTML

## Files (upload / download)
**To download a file, DRIVE THE BROWSER — do not \`curl\`/\`wget\`/\`fetch\` the file yourself as a first move.** Many real downloads (login/cookie-gated, generated server-side on demand, or triggered by a click whose response headers force the download) have NO fetchable URL — a direct fetch silently gets the wrong bytes, an HTML error page, or 403. Click/goto in the agent and collect from the auto-surfaced ledger. The ONLY time a direct fetch is correct: the ledger hands you a URL to use — the single-use \`/download/<id>\` URL, or an over-cap \`sourceUrl\`. Reaching for \`curl\` first is a bug, not a shortcut.
**NEVER read a file's bytes or base64 into this conversation, and NEVER split/reassemble/inline base64 by hand.** That is the wrong tool and will stall.
- **Upload a local file (stdio)**: \`uploadFile { selector, files: [{ path }] }\` — the server reads + encodes it.
- **Upload a local file (HTTP)**: the server can't read your disk. Stage it once over HTTP, then use the handle:
  \`curl -s -F file=@"/path/to/file" "<MCP_BASE_URL>/upload?token=<TOKEN>"\` → returns \`{ "handle": "browserless-download://…" }\` → \`uploadFile { files: [{ handle }] }\`. (The path-rejection error gives you the exact command with your token + URL filled in.)
- **Re-upload something from \`getDownloads\`**: pass its \`handle\` (works in both modes).
- **Download**: just trigger it in the agent (click a download link, or goto the file URL). The captured file **auto-surfaces** as a notification on the agent response (filename/size/handle), never the bytes — the server waits for it to finish (bounded by size), so it usually lands on that same call. stdio: file already saved, you get its path. HTTP: a **single-use** \`curl … /download/<id>?token=\` URL — fetch only if you need it. Files over the cap aren't transferred — you get the source URL to fetch directly. Path/handle reuses in \`uploadFile\`. (No separate download tool — use the agent.)
- base64 \`content\` is a LAST RESORT — tiny inline data only.
- Full recipe: \`file-transfers\` skill.

## Batching — Maximize Per Call
Plan ALL actions from snapshot before next snapshot.

**Process:**
1. Classify actions: **safe** (type, hover, scroll, evaluate, select, checkbox) vs. **page-changing** (click, goto)
2. Batch: safe FIRST → page-changing LAST
3. For forms: if submit button is in snapshot, batch type + click in one call
4. Don't batch across navigations

**Example form:**
\`\`\`json
{ "commands": [
  { "method": "type", "params": { "selector": "input#email", "text": "j@d.com" } },
  { "method": "click", "params": { "selector": "button#submit" } }
] }
\`\`\`

## Async
After async triggers (search, submit), use \`wait*\` before snapshot — \`waitForResponse\` best when API URL known. \`dynamic-content\` skill auto-loads on timeout. Never \`evaluate\` with setTimeout.

## Error Recovery
Errors tagged \`Category: <NAME>\`:
- **SELECTOR_MISS** — re-snapshot; retry \`< selector\` if not already deep-ref
- **SESSION_LOST** — a fresh session was opened automatically; re-goto + snapshot (prior state gone)
- **UNAUTHORIZED** / **FORBIDDEN** — pick different path
- **NOT_FOUND** — different URL
- **SERVER_ERROR** — backoff, retry once
- **NAVIGATION_FAILED** — verify URL
- **TIMEOUT** — longer wait or different signal
- **INVALID_PARAMS** — fix params (schema authoritative)
- **UNKNOWN** — re-snapshot + re-plan

\`! NOTICE: URL changed cross-origin\` = prior plan/refs invalid, re-plan.
Never retry same failed action without re-snapshot.

## Methods (non-obvious)
- **goto** { url, waitUntil? } — default "domcontentloaded"; prefer over click for links
- **snapshot** { maxElements?, targetId? } — cap 500; targetId peeks non-active tab
- **evaluate** { content } — IIFE only
- **waitForSelector** { selector, timeout? } — set 5000-10000ms
- **waitForResponse** { url?, statuses?, timeout? } — url is glob \`"*api/results*"\`
- **createTab** { url?, activate?, waitUntil? } — default activate: true; false = background
- **close** — own call, NOT batched; only when task complete (premature close discards page state)
- See schema for: screenshot, solve, back, forward, reload, click, type, select, checkbox, hover, scroll, text, html, waitForNavigation, waitForTimeout, waitForRequest, liveURL, getTabs, switchTab, closeTab

`;

// Transport-specific file-transfer guidance, appended to the agent tool
// description so the model knows its mode UP FRONT — instead of guessing (and
// base64-ing files it should pass by path). The server knows the transport; the
// model can't introspect it.
export const fileTransferModeNote = (
  transport: 'stdio' | 'httpStream',
  mcpBaseUrl: string,
): string =>
  transport === 'stdio'
    ? `\n\n## Runtime: LOCAL (stdio)\n` +
      `Before any file transfer, know your mode: this server runs over **stdio**, on the same machine as your files. ` +
      `To UPLOAD a local file, pass its **\`path\`** straight to \`uploadFile\` (\`files: [{ path: "/abs/file" }]\`) — the server reads it. ` +
      `**Do NOT base64 the file or read its bytes into the conversation.** ` +
      `DOWNLOADS are saved to local disk; the agent response gives you the path.`
    : `\n\n## Runtime: REMOTE (HTTP)\n` +
      `Before any file transfer, know your mode: this server runs over **HTTP** and **cannot read your filesystem**. ` +
      `To UPLOAD a local file, stage it once over HTTP, then use the handle:\n` +
      `  \`curl -s -F file=@"/abs/file" "${mcpBaseUrl}/upload?token=<YOUR_TOKEN>"\` -> { "handle": "browserless-download://..." } -> \`uploadFile { files: [{ handle }] }\`.\n` +
      `**Never base64 a file through the conversation.** DOWNLOADS come back with a single-use \`${mcpBaseUrl}/download/<id>\` URL.`;

export const SKILL_TOOL_DESCRIPTION = `Load a Browserless agent skill on demand.

Use this when you suspect the page exhibits a non-trivial mechanic but no SKILL block was auto-injected into a previous response. The auto-injection heuristics are conservative; calling this tool is the explicit fallback.

Available skills:
- **shadow-dom** — deep selectors, iframe URL-pattern syntax, what works through deep-ref
- **cookie-consent** — vendor-specific dismiss recipes (OneTrust, Cookiebot, Didomi, etc.)
- **modals** — close-button heuristics, ESC handling, alertdialog vs. dialog
- **snapshot-misses** — truncated/empty snapshots, image-rendered content
- **dynamic-content** — choosing the right \`wait*\` method after async triggers
- **screenshots** — when to screenshot vs. snapshot, scope and format choices
- **tabs** — multi-tab workflows, peek-without-switching
- **autonomous-login** — load before authenticating: when the user asked you to log in, when a wall blocks the task, or as soon as a password input appears. Covers the don't-login-by-default posture, contextual credential matching, MFA/captcha branches, and the required final JSON response shape.
- **captchas** — the \`solve\` command, response semantics, escalation path (Cloud-only)
- **file-transfers** — \`uploadFile\` / \`getDownloads\`, stdio-path vs. base64 content, size caps`;
