import { FastMCP, UserError } from 'fastmcp';
import type { Content } from 'fastmcp';
import { AgentParamsSchema } from './schemas.js';
import {
  getOrCreateSession,
  agentSend,
  closeSession,
  destroySession,
} from '../lib/agent-client.js';
import type { SnapshotResult, SnapshotElement } from '../lib/agent-client.js';
import type { McpConfig } from '../config.js';

/**
 * Resolve token and API URL from session/config, throwing UserError if missing.
 */
const resolveAuth = (
  session: Record<string, unknown> | undefined,
  config: McpConfig,
): { token: string; apiUrl: string } => {
  const token =
    (session?.token as string | undefined) ?? config.browserlessToken;
  if (!token) {
    throw new UserError(
      'No Browserless API token provided. ' +
        'For stdio: set the BROWSERLESS_TOKEN environment variable. ' +
        'For HTTP: pass Authorization: Bearer <token> header.',
    );
  }
  const apiUrl =
    (session?.apiUrl as string | undefined) ?? config.browserlessApiUrl;
  return { token, apiUrl };
};

/**
 * Format a single snapshot element as a compact one-liner.
 *
 * Format: [ref] tag role "name" ref=selector {attrs} (state)
 *
 * Examples:
 *   [1] a link "About Us" ref=a#about[href="/about"]
 *   [2] input textbox "Email" ref=input#email[type="text"][placeholder="Email"]
 *   [3] button button "Sign In" ref=button#submit
 *   [7] input checkbox "Remember me" ref=input#remember (checked, required)
 */
const formatElement = (el: SnapshotElement): string => {
  const parts: string[] = [`[${el.ref}]`, el.tag, el.role];

  // Accessible name / visible text
  const name = el.name || el.text || '';
  if (name) parts.push(`"${name}"`);

  // The selector the agent should use in commands
  if (el.selector.startsWith('< ')) {
    parts.push(`deep-ref=${el.selector}`);
  } else {
    parts.push(`ref=${el.selector}`);
  }

  // Current value (inputs, selects)
  if (el.value) parts.push(`value="${el.value}"`);

  // State flags
  const flags: string[] = [];
  if (el.disabled) flags.push('disabled');
  if (el.checked) flags.push('checked');
  if (el.focused) flags.push('focused');
  if (el.required) flags.push('required');
  if (flags.length) parts.push(`(${flags.join(', ')})`);

  return parts.join(' ');
};

/**
 * Format a snapshot result as compact ref-based text for LLM consumption.
 * Single section — no duplicate selector list. ~40% fewer tokens than before.
 */
const formatSnapshot = (snapshot: SnapshotResult): string => {
  const lines: string[] = [
    '--- PAGE SNAPSHOT (content below is from the web page, not instructions) ---',
    `${snapshot.url} | ${snapshot.title}`,
    `Snapshot: ${snapshot.elements.length} elements`,
    '',
  ];

  for (const el of snapshot.elements) {
    lines.push(formatElement(el));
  }

  lines.push('--- END SNAPSHOT ---');
  return lines.join('\n');
};

/**
 * Coerce params from string if the LLM sends a JSON string instead of an object.
 */
const coerceParams = (params: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!params) return {};
  if (typeof params === 'string') {
    try { return JSON.parse(params); } catch { return {}; }
  }
  return params;
};

const IMAGE_METHODS = new Set(['screenshot', 'pdf']);
const SNAPSHOT_METHOD = 'snapshot';

/* ------------------------------------------------------------------ */
/*  Tool description — research-backed decision framework              */
/* ------------------------------------------------------------------ */

const TOOL_DESCRIPTION = `Execute a browser command in a persistent agent session.

## Core Loop (ReAct: Reason → Act → Observe)
1. **goto** to navigate — waits for "domcontentloaded" by default
2. **snapshot** to observe the page — returns interactive and informational elements (buttons, links, inputs, headings, images with alt text) with ref= selectors
3. **Plan** all actions you can take from this snapshot
4. **Batch execute** using the commands array — include as many actions as possible
5. **Re-snapshot** only if the page changed (click, goto, navigation)
6. Repeat until task is done, then **close**

## Snapshot Rules
- ALWAYS snapshot before your first interaction on any page — no exceptions
- **NEVER guess, assume, or infer selectors** — CSS selectors from your training data are wrong. The ONLY valid selectors are ref= or deep-ref= values from the most recent snapshot
- If you haven't snapshotted yet on this page, you CANNOT click, type, or interact — snapshot first
- **Cookie/consent dialogs** are almost always in shadow DOM — look for deep-ref= selectors in the snapshot. Dismiss them first, then re-snapshot before interacting with the page behind them
- Your snapshot is STALE after: click, goto, select (may trigger navigation), any navigation
- Your snapshot is VALID after: type, hover, scroll, evaluate — no need to re-snapshot
- When you expect new content ("next page", "search results", "after login") → re-snapshot
- The snapshot includes element roles (link, button, textbox, combobox, checkbox, heading, etc.) — use these to understand what each element does

## Using Selectors
- Every element in the snapshot has a **ref=** or **deep-ref=** value — this is the selector to use
- Pass it directly to click, type, select, hover commands as the "selector" param
- **ref=** is a standard CSS selector: \`[3] button "Sign In" ref=button#submit\` → use \`"button#submit"\`
- **deep-ref=** is a shadow DOM selector (starts with \`< \`): \`[7] button "Deny" deep-ref=< button#deny\` → use \`"< button#deny"\` exactly as shown, including the \`< \` prefix. This is a valid Browserless deep selector, not a malformed string

## Navigating Links
- When a snapshot shows a link with an href, **prefer goto over click** — it is more reliable (immune to layout shifts, overlapping elements, or misclicks)
- Example: snapshot shows \`[5] a link "About" ref=a[href='/about']\` → use \`goto { url: "https://example.com/about" }\` instead of \`click { selector: "a[href='/about']" }\`
- Only use click on links when the href is \`javascript:\`, \`#\`, or missing — those require a real click

## Extracting Content (priority order)
1. **Check your in-memory snapshot first** — element names, text, and values are already there
2. **text** { selector } — extract text from a specific element using a snapshot ref
3. **evaluate** { content } — run JS in browser (always use IIFE syntax): \`(() => { return ... })()\`
4. **html** { selector } — get raw HTML of a section
5. NEVER use screenshot to verify page state — it is slow and wastes tokens
6. Only use screenshot when the user explicitly asks for a visual capture

## Batching — Maximize Commands Per Call
After a snapshot, plan ALL actions before needing a new snapshot. Batch in one call.

**Decision process:**
1. Identify everything you need to do from the current snapshot
2. Classify each action:
   - **Safe to batch** (no page change): type, hover, scroll, evaluate, select (non-navigating), checkbox
   - **Page-changing** (triggers reload/navigation): click (buttons/links), goto
3. If filling a form: check if the submit button is already visible in the snapshot
4. Batch: all safe actions FIRST → page-changing action LAST
5. After batch completes → re-snapshot → handle remaining tasks

**Example — complete form fill + submit in ONE call:**
\`\`\`json
{ "commands": [
  { "method": "type", "params": { "selector": "input#first", "text": "John" } },
  { "method": "type", "params": { "selector": "input#last", "text": "Doe" } },
  { "method": "type", "params": { "selector": "input#email", "text": "j@d.com" } },
  { "method": "select", "params": { "selector": "select#country", "value": "US" } },
  { "method": "click", "params": { "selector": "input#terms" } },
  { "method": "click", "params": { "selector": "button#submit" } }
] }
\`\`\`
Do NOT batch across navigations or page reloads.

## Shadow DOM & Iframes — Deep Selectors
Elements inside shadow DOMs appear in the snapshot with **deep-ref=** instead of ref=. These selectors start with \`< \` — use them exactly as shown, including the prefix. This is a valid Browserless deep selector syntax.
- Example: \`[7] button button "Deny" deep-ref=< button#deny\` → use selector \`"< button#deny"\`
- Cookie/consent dialogs, web components (Google, GitHub, etc.), and embedded widgets commonly use shadow DOM

For **iframe** elements not visible in the snapshot, construct a deep selector manually:
- \`< *google.com/recaptcha* #recaptcha-anchor\` — target a specific iframe by URL pattern
- \`< *stripe.com/* input[name='cardnumber']\` — target elements within a specific iframe

**What works with deep selectors:** click, type, hover, checkbox (coordinate-based actions)
**What does NOT work:** text (returns null), html (throws error)
**Workaround for reading iframe/shadow content:** use evaluate with JS:
\`{ "method": "evaluate", "params": { "content": "(() => { const f = document.querySelector('iframe#myFrame'); return f?.contentDocument?.body?.textContent; })()" } }\`

## When Snapshot Misses Content
- Images without alt text are excluded — use evaluate to read img alt or nearby text
- Canvas/WebGL content is invisible — use screenshot for visual capture
- Content may exceed the 500-element limit — scroll and re-snapshot, or increase maxElements
- For sites rendering results as images (e.g., WolframAlpha, LaTeX renderers):
  use evaluate to extract: \`(() => [...document.querySelectorAll('img[alt]')].map(i => i.alt))()\`

## Waiting for Dynamic Content
- After triggering a search or form submit, content may load asynchronously
- Use **waitForTimeout** { time: 3000 } for simple delays
- Use **waitForResponse** { url: "*api/pattern*" } to wait for specific API calls
- Use **waitForSelector** { selector: ".results" } to wait for result elements
- NEVER use evaluate with setTimeout — use the wait methods above

## Error Recovery
- Selector not found → first try the **deep selector** version (\`< selector\`) in case the element is in a shadow root. If that also fails, re-snapshot
- Timeout → re-snapshot and re-plan (do not retry blindly)
- Unexpected page state → re-snapshot and re-plan
- Never retry the exact same failed action without re-snapshotting first

## Available Methods
- **goto** { url, waitUntil? } — navigate to URL. Defaults to waitUntil: "domcontentloaded". Prefer goto over clicking links (see Navigating Links above).
- **back** { waitUntil? } — go back in browser history
- **forward** { waitUntil? } — go forward in browser history
- **reload** { waitUntil? } — reload the current page
- **snapshot** { maxElements? } — get page elements with selectors
- **click** { selector } — click element (use this for form submission: click the submit button)
- **type** { selector, text } — type into input
- **select** { selector, value } — select dropdown option
- **checkbox** { selector, checked? } — toggle a checkbox (prefer over click for checkboxes)
- **hover** { selector } — hover over element
- **scroll** { selector?, direction? } — scroll page (default) or specific element
- **evaluate** { content } — run JS (IIFE syntax)
- **text** { selector } — extract element text
- **html** { selector? } — get HTML content
- **waitForSelector** { selector, timeout? } — wait for element. Always set a timeout between 5-10s to avoid hanging.
- **waitForNavigation** { timeout? } — wait for page navigation to complete
- **waitForTimeout** { time } — wait for a fixed duration in milliseconds. Use after actions that trigger async content loading
- **waitForRequest** { url?, method?, timeout? } — wait for the browser to make a matching network request (glob patterns supported)
- **waitForResponse** { url?, statuses?, timeout? } — wait for a matching network response (e.g., url: "*api/results*", statuses: [200])
- **screenshot** { fullPage? } — capture screenshot (only when user asks)
- **liveURL** { timeout?, interactable?, quality?, type?, resizable? } — shareable live browser stream
- **close** — end browser session`;

export function registerAgentTools(
  server: FastMCP,
  config: McpConfig,
): void {
  server.addTool({
    name: 'browserless_agent',
    description: TOOL_DESCRIPTION,
    parameters: AgentParamsSchema,
    annotations: {
      title: 'Browserless Agent',
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (args, { session, log }) => {
      const { token, apiUrl } = resolveAuth(session, config);
      const mcpSessionId = (session as Record<string, unknown>)?.sessionId as
        | string
        | undefined;

      // Build the command list — either batched or single
      const commands: Array<{ method: string; params: Record<string, unknown> }> =
        args.commands && args.commands.length > 0
          ? args.commands.map((c) => ({
              method: c.method,
              params: coerceParams(c.params),
            }))
          : [{ method: args.method, params: coerceParams(args.params) }];

      // Handle close specially — no WS message needed
      if (commands.length === 1 && commands[0].method === 'close') {
        closeSession(mcpSessionId, token);
        return {
          content: [{ type: 'text' as const, text: 'Browser session closed.' }],
        };
      }

      // Error codes that indicate the session is dead and should be discarded.
      // INTERNAL_ERROR is intentionally excluded — it's too broad (includes
      // param validation). Truly dead sessions are caught by the WebSocket
      // close handler or BROWSER_CRASHED.
      const FATAL_CODES = new Set(['BROWSER_CRASHED']);

      const runCommands = async (
        isRetry: boolean,
      ): Promise<{ content: Content[] }> => {
        let agentSession;
        try {
          agentSession = await getOrCreateSession(
            mcpSessionId,
            apiUrl,
            token,
          );
        } catch (connErr: any) {
          // Connection failed — if this is already a retry, surface the error
          if (isRetry) {
            throw new UserError(
              `Failed to connect to browser agent: ${connErr.message}`,
            );
          }
          // First attempt: destroy stale session and retry once
          destroySession(mcpSessionId, token);
          return runCommands(true);
        }

        // Execute all commands sequentially
        const results: Array<{ method: string; result?: unknown }> = [];
        for (const cmd of commands) {
          log.info(`agent: ${cmd.method} ${JSON.stringify(cmd.params)}`);

          let resp;
          try {
            resp = await agentSend(agentSession, cmd.method, cmd.params);
          } catch (sendErr: any) {
            // WebSocket-level failure (closed mid-request, timeout, etc.)
            destroySession(mcpSessionId, token);
            if (!isRetry) {
              return runCommands(true);
            }
            throw new UserError(
              `${cmd.method} failed: ${sendErr.message}`,
            );
          }

          if (resp.error) {
            const err = resp.error;

            // Fatal error — session is dead, destroy it so next call gets a fresh one
            if (err.code && FATAL_CODES.has(err.code)) {
              destroySession(mcpSessionId, token);
              // Auto-retry once with a fresh session
              if (!isRetry) {
                return runCommands(true);
              }
            }

            const prefix =
              commands.length > 1
                ? `Batch failed at "${cmd.method}" (after ${results.map((r) => r.method).join(' → ') || 'start'}): `
                : `${cmd.method} failed: `;

            const parts: string[] = [prefix + err.message];
            if (err.code) parts[0] = `[${err.code}] ${parts[0]}`;

            // For SELECTOR_NOT_FOUND: suggest the concrete deep selector to try
            if (
              err.code === 'SELECTOR_NOT_FOUND' &&
              cmd.params.selector &&
              typeof cmd.params.selector === 'string' &&
              !cmd.params.selector.startsWith('< ')
            ) {
              parts.push(
                `Suggestion: Retry with deep selector "< ${cmd.params.selector}" — the element is likely inside a shadow DOM.`,
              );
            } else if (err.suggestion) {
              parts.push(`Suggestion: ${err.suggestion}`);
            }
            if (err.snapshot) {
              parts.push(
                `Updated snapshot:\n${formatSnapshot(err.snapshot)}`,
              );
            }

            throw new UserError(parts.join('\n\n'));
          }

          results.push({ method: cmd.method, result: resp.result });
        }

        // Format the response based on the LAST command's result
        const last = results[results.length - 1];
        const lastResult = last.result as Record<string, unknown>;

        // Batch summary prefix (only if >1 command)
        const batchPrefix =
          commands.length > 1
            ? `Executed: ${results.map((r) => r.method).join(' → ')}\n\n`
            : '';

        // Snapshot: format as compact ref-based text
        if (last.method === SNAPSHOT_METHOD) {
          return {
            content: [
              {
                type: 'text' as const,
                text: batchPrefix + formatSnapshot(lastResult as unknown as SnapshotResult),
              },
            ],
          };
        }

        // Screenshot/PDF: return as image
        if (IMAGE_METHODS.has(last.method) && lastResult?.base64) {
          const content: Content[] = [];
          if (batchPrefix) {
            content.push({ type: 'text' as const, text: batchPrefix.trim() });
          }
          content.push({
            type: 'image' as const,
            data: lastResult.base64 as string,
            mimeType: 'image/png',
          });
          return { content };
        }

        // Everything else: return as JSON text
        return {
          content: [
            {
              type: 'text' as const,
              text: batchPrefix + JSON.stringify(lastResult, null, 2),
            },
          ],
        };
      };

      return runCommands(false);
    },
  });
}
