---
name: ui-test
description: 'AI-powered adversarial UI testing via the Browserless MCP tools. Analyzes git diffs to test only what changed, or explores the full app to find bugs. Tests functional correctness, accessibility, responsive layout, and UX heuristics. Use when the user asks to test UI changes, QA a pull request, audit accessibility, or run exploratory testing. Supports local dev servers (localhost) and deployed sites.'
license: MIT
metadata:
  author: browserbase
  version: '0.4.0'
allowed-tools: Bash Read Glob Grep Agent
compatibility: 'Requires the Browserless MCP tools (browserless_agent for driving the browser; browserless_skill to load autonomous-login). For deployed-site testing behind auth: log in inside the same browserless_agent call.'
---

# UI Test — Agentic UI Testing Skill

Test UI changes in a real browser. Your job is to **try to break things**, not confirm they work.

Three workflows:

- **Diff-driven** — analyze a git diff, test only what changed
- **Exploratory** — navigate the app, find bugs the developer didn't think about
- **Parallel** — fan out independent test groups across multiple Browserbase browsers

## How Testing Works

The main agent **coordinates** — it plans test strategy, delegates to sub-agents, and merges results. Sub-agents do the actual browser testing.

### Planning: multiple angles, then execute once

**You MUST complete all three planning rounds yourself and output them before launching any sub-agents.** Planning happens in your own response — it is NOT delegated to sub-agents. Do not skip ahead to execution.

**Round 1 — Functional:** What are the core user flows? What should work? Write out each test as: action → expected result.

**Round 2 — Adversarial:** Re-read Round 1. What did you miss? Think about: different user types/roles, error paths, empty states, race conditions, edge inputs (empty, huge, special chars, rapid clicks).

**Round 3 — Coverage gaps:** Re-read Rounds 1–2. What about: accessibility (axe-core, keyboard-only), mobile viewports, console errors, visual consistency with the rest of the app?

**Deduplicate:** Merge all three rounds into one numbered list of tests. Remove overlaps. Assign each test to a group (e.g. Group A, Group B).

**Then execute once** — launch one sub-agent per group. Each sub-agent receives its specific list of tests to run, nothing more. Sub-agents do not explore or plan — they execute assigned tests and report results.

Output the three rounds, the merged plan, and the group assignments in your response before calling any Agent tool.

### Principles for splitting work

- **Sub-agents run assigned tests, not open exploration.** The main agent hands each sub-agent a specific numbered list of tests. Sub-agents do not plan, explore, or decide what to test — they execute the list and stop.
- **The bottleneck is the slowest agent** — split work so no single agent has a disproportionate share. Many small agents > few large ones.
- **Size the effort to the change** — a single component fix doesn't need many agents or many steps. A full-page redesign does. Let the scope of the diff drive the plan.
- **No early stopping on failures** — find as many bugs as possible within the assigned tests.

### Giving sub-agents a step budget

**The main agent MUST include an explicit Browserless step limit in every sub-agent prompt.** Sub-agents do not self-limit — they will run until done unless told otherwise.

As a rough heuristic: ~25 steps for a few targeted checks, ~40 for a full page with functional + adversarial + a11y, ~75 for multiple pages or a broad category. **Adjust based on what the assigned tests actually require** — these are starting points, not rules.

As a rough heuristic: ~25 steps for a few targeted checks, ~40 for a full page with functional + adversarial + a11y, ~75 for multiple pages or a broad category. **Adjust based on what the assigned tests actually require** — these are starting points, not rules.

Every sub-agent prompt must include:

```
You have a budget of N Browserless steps (each Browserless command/tool call = 1 step). Count your steps as you go. When you reach N, stop immediately and report:
- STEP_PASS/STEP_FAIL for every test you completed
- STEP_SKIP|<test-id>|budget reached for every test you didn't get to

Do not retry or continue after hitting the budget.
Run only these tests: [numbered list from the merged plan]
Do not explore beyond the assigned tests.
Do NOT generate an HTML report or write any files. Return only step markers and your findings as text.
```

The main agent should NOT run Browserless browser commands itself (except to verify the dev server is up). All testing happens in sub-agents.

**When a sub-agent hits its budget, the main agent accepts the partial results as-is.** Do not re-run or retry the sub-agent. Include SKIPPED tests in the final report so the developer knows what wasn't covered.

### Reporting

**Every sub-agent reports back with:**

```
Tests: 8 | Passed: 5 | Failed: 2 | Skipped: 1 | Pages visited: 2
```

**The main agent merges into a final report with:**

```
Tests: 20 | Passed: 14 | Failed: 4 | Skipped: 2 | Agents: 3 | Pass rate: 70%
```

Do not report "steps used" — Browserless command counts are implementation plumbing, not a meaningful metric for reviewers.

## Testing Philosophy

**You are an adversarial tester.** Your goal is to find bugs, not prove correctness.

- **Try to break every feature you test.** Don't just check "does the button exist?" — click it twice rapidly, submit empty forms, paste 500 characters, press Escape mid-flow.
- **Test what the developer didn't think about.** Empty states, error recovery, keyboard-only navigation, mobile overflow.
- **Every assertion must be evidence-based.** Compare before/after snapshots. Check specific elements by ref. Never report PASS without concrete evidence from the accessibility tree or a deterministic check.
- **Report failures with enough detail to reproduce.** Include the exact action, what you expected, what you got, and a suggested fix.

## Assertion Protocol

Every test step MUST produce a structured assertion. Do not write freeform "this looks good."

### Step markers

For each test step, emit exactly one marker:

```
STEP_PASS|<step-id>|<evidence>
```

or

```
STEP_FAIL|<step-id>|<expected> → <actual>|<screenshot-path>
```

- `step-id`: short identifier like `homepage-cta`, `form-validation-error`, `modal-cancel`
- `evidence`: what you observed that proves the step passed (element ref, text content, URL, eval result)
- `expected → actual`: what you expected vs what you got
- `screenshot-path`: path to the saved screenshot (failures only — see Screenshot Capture below)

### Screenshot Capture for Failures

**Every STEP_FAIL MUST have an accompanying screenshot** so the developer can see what went wrong visually.

When a test step fails, take a screenshot immediately after observing the failure with a `browserless_agent` `screenshot` command, and persist the returned image to `.context/ui-test-screenshots/<step-id>.png`:

```jsonc
// browserless_agent command — capture the broken state
{ "method": "screenshot", "params": { "type": "png" } }
```

The screenshot comes back as image data on the response — write it to `.context/ui-test-screenshots/<step-id>.png` (base64-decode if the transport returns it encoded). Setup the screenshot directory at the start of any test run:

```bash
mkdir -p .context/ui-test-screenshots
```

**Rules:**

- File name = step-id (e.g., `double-submit.png`, `axe-audit.png`, `modal-focus-trap.png`)
- Store in `.context/ui-test-screenshots/` — this directory is gitignored and accessible to the developer and other agents
- For parallel runs, include the session name: `<session>-<step-id>.png` (e.g., `signup-double-submit.png`)
- Take the screenshot at the moment of failure — capture the broken state, not after recovery
- For visual/layout bugs, also screenshot the baseline (working state) for comparison: `<step-id>-baseline.png`

### How to verify (in order of rigor)

1. **Deterministic check** (strongest) — an `evaluate` command returns structured data you can inspect (the return value comes back under `.value`; wrap it in `JSON.stringify`). Examples: axe-core violation count, `document.title`, form field value, console error array, element count.
2. **Snapshot element match** — a specific element with a specific role and text exists in the accessibility tree. Check by ref: `@0-12 button "Save"`. An element either exists in the tree or it doesn't.
3. **Before/after comparison** — snapshot before action, act, snapshot after. Verify the tree changed in the expected way (element appeared, disappeared, text changed).
4. **Screenshot + visual judgment** (weakest) — only for visual-only properties (color, spacing, layout) that the accessibility tree cannot capture. Always accompany with what specifically you're evaluating.

### Before/after comparison pattern

This is the core verification loop. Use it for every interaction — sequence the steps inside one `browserless_agent` `commands` array so the session state carries through:

```jsonc
// browserless_agent commands array
[
  // 1. BEFORE: capture state — record what elements exist, their text, their refs
  { "method": "snapshot" },
  // 2. ACT: perform the interaction
  { "method": "click", "params": { "selector": "button:has-text('Confirm')" } },
  // 3. AFTER: capture new state — compare: what changed? appeared? disappeared?
  { "method": "snapshot" },
]
// 4. ASSERT: emit marker based on comparison
//   If dialog appeared: STEP_PASS|modal-open|dialog "Confirm" appeared
//   If nothing changed, screenshot the broken state and fail:
//     { "method": "screenshot", "params": { "type": "png" } }  → save to .context/ui-test-screenshots/modal-open.png
//     STEP_FAIL|modal-open|expected dialog to appear → snapshot unchanged|.context/ui-test-screenshots/modal-open.png
```

## Setup

No CLI install — the Browserless MCP tools are the interface. Drive the browser through `browserless_agent` (a `commands` array of `goto`/`snapshot`/`click`/`type`/`evaluate`/`scroll`/`screenshot` steps) and load helper skills (e.g. `autonomous-login`) through `browserless_skill`. If the Browserless MCP server is not yet connected, connect it before running any test.

### Avoid permission fatigue

This skill issues many Browserless commands (snapshots, clicks, evaluates) across many `browserless_agent` calls. To avoid approving each one, allow the Browserless MCP tools in `.claude/settings.json` (project-level) or `~/.claude/settings.json` (user-level):

```json
{
  "permissions": {
    "allow": [
      "mcp__browserless-agent__browserless_agent",
      "mcp__browserless-agent__browserless_skill"
    ]
  }
}
```

Parallel test groups (Workflow C) are just separate `browserless_agent` calls — each is its own ephemeral session — so no extra session-naming permission is needed.

## Mode Selection

Every browser interaction goes through `browserless_agent` — a `commands` array whose first step is a `goto`. The target only changes the auth handling, not the tool:

| Target                    | Auth                                                                                              | Notes                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `localhost` / `127.0.0.1` | None needed                                                                                       | The Browserless browser must be able to reach the dev server (e.g. a local/self-hosted Browserless instance, or a tunnel to the deployed dev server). Clean isolated session per call — best for reproducible QA runs. |
| Deployed/staging site     | Log in inside the same `browserless_agent` call (via the `autonomous-login` skill + `loadSecret`) | Each call is an ephemeral session; keep login + tests in ONE `commands` array so cookies persist.                                                                                                                      |

**Rule: for a `localhost` / `127.0.0.1` target, no auth step is required — just `goto` the URL.**

### Local target (default for localhost)

```jsonc
// browserless_agent commands array
[
  {
    "method": "goto",
    "params": {
      "url": "http://localhost:3000",
      "waitUntil": "load",
      "timeout": 45000,
    },
  },
  { "method": "snapshot" },
]
```

Each `browserless_agent` call is a clean, isolated session by default, which is best for reproducible localhost QA runs. If a test explicitly needs existing login/cookies/state, do the login as the first steps of the same call (see the deployed-site flow below) rather than relying on a pre-existing browser profile.

### Deployed sites (auth inside one call)

There is no cookie-sync to configure — a session persists across calls only when you carry the same `proxy`/`profile`, and this deployed-site flow uses neither, so run the login and the tests together in ONE call's `commands` array so the authenticated cookies carry through:

```jsonc
// browserless_agent commands array — load autonomous-login via browserless_skill first
[
  {
    "method": "goto",
    "params": {
      "url": "https://staging.your-app.com/login",
      "waitUntil": "load",
      "timeout": 45000,
    },
  },
  {
    "method": "type",
    "params": {
      "selector": "input[name='email']",
      "text": "<from loadSecret>",
    },
  },
  {
    "method": "type",
    "params": {
      "selector": "input[name='password']",
      "text": "<from loadSecret>",
    },
  },
  { "method": "click", "params": { "selector": "button[type='submit']" } },
  {
    "method": "goto",
    "params": {
      "url": "https://staging.your-app.com",
      "waitUntil": "load",
      "timeout": 45000,
    },
  },
  { "method": "snapshot" },
  // ... run tests in the same array ...
]
```

Pull credentials with `loadSecret` — never put them in the `type` text or context. If the site fronts an anti-bot wall, add a `solve` command (Cloudflare/Turnstile → `solve { type: "cloudflare" }`, etc.); a terminal `action=deny` block cannot be solved.

## Workflow A: Diff-Driven Testing

### Phase 1: Analyze the diff

```bash
git diff --name-only HEAD~1          # or: git diff --name-only / git diff --name-only main...HEAD
git diff HEAD~1 -- <file>            # read actual changes
```

Categorize changed files:

| File pattern                          | UI impact   | What to test                                                   |
| ------------------------------------- | ----------- | -------------------------------------------------------------- |
| `*.tsx`, `*.jsx`, `*.vue`, `*.svelte` | Component   | Render, interaction, state, edge cases                         |
| `pages/**`, `app/**`, `src/routes/**` | Route/page  | Navigation, page load, content, 404 handling                   |
| `*.css`, `*.scss`, `*.module.css`     | Style       | Visual appearance (screenshot), responsive                     |
| `*form*`, `*input*`, `*field*`        | Form        | Validation, submission, empty input, long input, special chars |
| `*modal*`, `*dialog*`, `*dropdown*`   | Interactive | Open/close, escape, focus trap, cancel vs confirm              |
| `*nav*`, `*menu*`, `*header*`         | Navigation  | Links, active states, routing, keyboard nav                    |
| Non-UI files only                     | None        | Skip — report "no UI tests needed"                             |

### Phase 2: Map files to URLs

Detect framework: `cat package.json | grep -E '"(next|react|vue|nuxt|svelte|@sveltejs|angular|vite)"'`

| Framework            | Default port | File → URL pattern                      |
| -------------------- | ------------ | --------------------------------------- |
| Next.js App Router   | 3000         | `app/dashboard/page.tsx` → `/dashboard` |
| Next.js Pages Router | 3000         | `pages/about.tsx` → `/about`            |
| Vite                 | 5173         | Check router config                     |
| Nuxt                 | 3000         | `pages/index.vue` → `/`                 |
| SvelteKit            | 5173         | `src/routes/+page.svelte` → `/`         |
| Angular              | 4200         | Check routing module                    |

### Phase 3: Ensure the right code is running

Before testing, verify the dev server is serving the code from the diff — not a stale branch.

**If testing a PR or specific branch:**

```bash
# Check what branch is currently checked out
git branch --show-current

# If it's not the PR branch, switch to it
git fetch origin <branch> && git checkout <branch>

# Install deps — the lockfile may differ between branches
yarn install  # or npm install / pnpm install
```

If the dev server was already running on a different branch, restart it after checkout.

**Find a running dev server:**

```bash
for port in 3000 3001 5173 4200 8080 8000 5000; do
  s=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port" 2>/dev/null)
  if [ "$s" != "000" ]; then echo "Dev server on port $port (HTTP $s)"; fi
done
```

If nothing found: tell the user to start their dev server.

**Verify it actually renders:**
After a `goto` + `snapshot` (in one `browserless_agent` call), check that the accessibility tree contains real page content (navigation, headings, interactive elements) — not just an error overlay or empty body. Next.js dev servers can return HTTP 200 while showing a full-screen build error dialog. If the snapshot is empty or dominated by an error dialog, the server is broken — fix the build before testing.

### Phase 4: Generate test plan

For each changed area, plan **both happy path AND adversarial tests**:

```
Test Plan (based on git diff)
=============================
Changed: src/components/SignupForm.tsx (added email validation)

1. [happy] Valid email submits successfully
   URL: http://localhost:3000/signup
   Steps: fill valid email → submit → verify success message appears

2. [adversarial] Invalid email shows error
   Steps: fill "not-an-email" → submit → verify error message appears

3. [adversarial] Empty form submission
   Steps: click submit without filling anything → verify error, no crash

4. [adversarial] XSS in email field
   Steps: fill "<script>alert(1)</script>" → submit → verify sanitized/rejected

5. [adversarial] Rapid double-submit
   Steps: click submit twice quickly → verify no duplicate submission

6. [adversarial] Keyboard-only flow
   Steps: Tab to email → type → Tab to submit → Enter → verify success
```

### Phase 5: Execute tests

```bash
mkdir -p .context/ui-test-screenshots
```

Then, for each test, drive the browser through a `browserless_agent` call. Each call is a clean, isolated session; follow the **before/after pattern** inside one `commands` array so state carries through:

```jsonc
// browserless_agent commands array
[
  // Navigate — waitUntil:"load" replaces an explicit wait step (never networkidle on SPAs)
  {
    "method": "goto",
    "params": {
      "url": "http://localhost:3000/path",
      "waitUntil": "load",
      "timeout": 45000,
    },
  },
  // BEFORE snapshot — note the current state: elements, refs, text
  { "method": "snapshot" },
  // ACT — one of:
  { "method": "click", "params": { "selector": "<selector>" } },
  // { "method": "type",  "params": { "selector": "<selector>", "text": "value" } },
  // { "method": "press", "params": { "key": "Enter" } },
  // AFTER snapshot — compare against BEFORE: what changed?
  { "method": "snapshot" },
]
// ASSERT with marker
//   STEP_PASS|step-id|evidence  OR  STEP_FAIL|step-id|expected → actual
```

Waiting: use `waitUntil: "load"` on `goto`; for an explicit pause use `{ "method": "waitForTimeout", "params": { "time": N } }`, and to gate on an element `{ "method": "waitForSelector", "params": { "selector": "S", "timeout": 10000 } }`.

### Phase 6: Report results

```
## UI Test Results

### STEP_PASS|valid-email-submit|status "Thanks!" appeared at @0-42 after submit
- URL: http://localhost:3000/signup
- Before: form with email input @0-3, submit button @0-7
- Action: filled "user@test.com", clicked @0-7
- After: form replaced by status element with "Thanks! We'll be in touch."

### STEP_FAIL|double-submit|expected single submission → form submitted twice|.context/ui-test-screenshots/double-submit.png
- URL: http://localhost:3000/signup
- Before: form with submit button @0-7
- Action: clicked @0-7 twice rapidly
- After: two success toasts appeared, suggesting duplicate submission
- Screenshot: .context/ui-test-screenshots/double-submit.png
- Suggestion: disable submit button after first click, or debounce the handler

---
**Summary: 4/6 passed, 2 failed**
Failed: double-submit, xss-sanitization

Screenshots saved to `.context/ui-test-screenshots/` — open any failed step's screenshot to see the broken state.
```

No teardown step is needed — there is nothing to release.

### Phase 7: Generate HTML report

After producing the text report, generate a standalone HTML report that a reviewer can open in a browser. The report embeds screenshots inline (base64) so it works as a single file — no external dependencies.

**Why:** Text reports are good for the agent conversation, but reviewers (PMs, designers, other engineers) want a visual artifact they can open, scan, and share. Screenshots inline make failures immediately obvious.

#### How to generate

1. Read the HTML template at [references/report-template.html](references/report-template.html)
2. Build the report by replacing the template placeholders with actual test data:

| Placeholder            | Value                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{TITLE}}`            | Report title for `<title>` tag (e.g., "UI Test: PR #1234 — OAuth Settings")                                                                                                                                                                                             |
| `{{TITLE_HTML}}`       | Report title for the visible `<h1>`. If a PR URL is available, wrap the PR reference in an `<a>` tag so it's clickable (e.g., `UI Test: <a href="https://github.com/org/repo/pull/1234">PR #1234</a> — OAuth Settings`). If no URL, use plain text same as `{{TITLE}}`. |
| `{{META}}`             | One-line context: date, app URL, user, branch                                                                                                                                                                                                                           |
| `{{TOTAL_TESTS}}`      | Total STEP_PASS + STEP_FAIL count                                                                                                                                                                                                                                       |
| `{{AGENT_COUNT}}`      | Number of sub-agents that ran                                                                                                                                                                                                                                           |
| `{{PASS_COUNT}}`       | Number of STEP_PASS                                                                                                                                                                                                                                                     |
| `{{FAIL_COUNT}}`       | Number of STEP_FAIL                                                                                                                                                                                                                                                     |
| `{{PASS_RATE}}`        | Integer percentage (e.g., "92")                                                                                                                                                                                                                                         |
| `{{RATE_CLASS}}`       | `good` (≥90%), `warn` (70–89%), `bad` (<70%)                                                                                                                                                                                                                            |
| `{{FAILURES_SECTION}}` | HTML for failed test cards (see below)                                                                                                                                                                                                                                  |
| `{{PASSES_SECTION}}`   | HTML for passed test cards (see below)                                                                                                                                                                                                                                  |

3. For each test result, generate a `<details>` card. Failed tests should be **open by default** so reviewers see them immediately:

```html
<!-- Failed test card (open by default) -->
<div class="section">
  <h2>Failures <span class="count">{{FAIL_COUNT}}</span></h2>
  <details class="test-card fail" open>
    <summary>
      <span class="badge fail">FAIL</span>
      <span class="step-id">step-id-here</span>
      <span class="evidence">expected → actual</span>
    </summary>
    <div class="body">
      <dl>
        <dt>URL</dt>
        <dd>http://localhost:3000/path</dd>
        <dt>Action</dt>
        <dd>What was done</dd>
        <dt>Expected</dt>
        <dd>What should have happened</dd>
        <dt>Actual</dt>
        <dd>What happened instead</dd>
      </dl>
      <div class="suggestion">Fix: description of suggested fix</div>
      <div class="screenshot">
        <img src="data:image/png;base64,..." alt="Screenshot of failure" />
        <div class="caption">step-id.png — captured at moment of failure</div>
      </div>
    </div>
  </details>
</div>

<!-- Passed test card (collapsed by default) -->
<div class="section">
  <h2>Passed <span class="count">{{PASS_COUNT}}</span></h2>
  <details class="test-card pass">
    <summary>
      <span class="badge pass">PASS</span>
      <span class="step-id">step-id-here</span>
      <span class="evidence">evidence summary</span>
    </summary>
    <div class="body">
      <dl>
        <dt>URL</dt>
        <dd>http://localhost:3000/path</dd>
        <dt>Evidence</dt>
        <dd>What was observed</dd>
      </dl>
    </div>
  </details>
</div>
```

4. **Embed screenshots as base64** so the HTML is fully self-contained:

```bash
# Convert screenshot to base64 data URI
base64 -i .context/ui-test-screenshots/step-id.png | tr -d '\n'
# Use as: src="data:image/png;base64,<output>"
```

Read each screenshot file referenced in STEP_FAIL markers, base64-encode it, and embed it as an `<img src="data:image/png;base64,...">` in the corresponding test card. For STEP_PASS, only embed a screenshot if one was explicitly taken (e.g., baseline screenshots).

5. Write the final HTML to `.context/ui-test-report.html`:

```bash
# Write the generated HTML
cat > .context/ui-test-report.html << 'REPORT_EOF'
<!DOCTYPE html>
...generated report...
REPORT_EOF

# Open it for the reviewer
open .context/ui-test-report.html  # macOS
# xdg-open .context/ui-test-report.html  # Linux
```

6. Tell the user: `Report saved to .context/ui-test-report.html` and offer to open it.

**Rules:**

- Failures section comes before passes — reviewers care about what's broken first
- Failed cards are `open` by default; passed cards are collapsed
- Every STEP_FAIL card MUST have an embedded screenshot — if the screenshot file is missing, note it in the card
- Include the suggestion/fix in each failure card if one was provided
- The report must work offline — no CDN links, no external assets
- Keep the HTML under 5MB — if screenshots push it over, reduce image quality or skip baseline screenshots for passes

## Adversarial Test Patterns

Apply these to every interactive element you test. Read [references/adversarial-patterns.md](references/adversarial-patterns.md) for the full pattern library (forms, modals, navigation, error states, keyboard accessibility).

## Deterministic Checks

These produce structured data, not judgment calls. Use them as the strongest form of assertion.

| Check          | What it catches                     | Assertion                           |
| -------------- | ----------------------------------- | ----------------------------------- |
| axe-core       | WCAG violations                     | `violations.length === 0`           |
| Console errors | Runtime exceptions, failed requests | empty error array                   |
| Broken images  | Missing/failed image loads          | no images with `naturalWidth === 0` |
| Form labels    | Inputs without accessible labels    | every input has `hasLabel: true`    |

For the exact `evaluate` recipes, read [references/browser-recipes.md](references/browser-recipes.md).

## Workflow B: Exploratory Testing

No diff, no plan — just open the app and try to break it. Use this when the user says "test my app", "find bugs", or "QA this site."

### Approach

1. **Discover the app** — read `package.json` to detect the framework, then open the root URL and snapshot to see what's there
2. **Navigate everything** — click through nav links, visit every reachable page, note what exists
3. **Test what you find** — for each page, apply the adversarial patterns below (forms, modals, navigation, keyboard, error states)
4. **Run deterministic checks** — axe-core, console errors, broken images, form labels on every page
5. **Report findings** — use STEP_PASS/STEP_FAIL markers, include reproduction steps for failures

Don't try to be systematic about coverage. Just explore like a user would, but with the intent to break things. The agent is good at this — let it roam.

### Tips for exploratory runs

- Start with the homepage, then follow the navigation naturally
- Try the 404 page (`/does-not-exist`) — is it custom or default?
- Look for empty states (pages with no data)
- Test forms with garbage input before valid input
- Check mobile viewport (375px) on every page — does it overflow?
- If the app has auth, log in as the first steps of the `browserless_agent` call

## Workflow C: Parallel Testing

Run independent test groups concurrently as separate `browserless_agent` calls — each call is its own ephemeral session with its own browser. Works for both localhost and deployed targets.

Use when testing multiple pages or categories and you want faster wall clock time.

Read [references/parallel-testing.md](references/parallel-testing.md) for the full workflow: fanning out across parallel `browserless_agent` calls, in-call auth, and result merging.

## Design Consistency

Check whether changed UI matches the rest of the app visually. Read [references/design-consistency.md](references/design-consistency.md) when doing visual or design checks.

## Test Categories

| Category           | How                                           | Assertion type                                |
| ------------------ | --------------------------------------------- | --------------------------------------------- |
| Accessibility      | axe-core + keyboard nav                       | Deterministic (violation count)               |
| Visual Quality     | Screenshot + heuristic evaluation             | Visual judgment (weakest — note specifics)    |
| Responsive         | Viewport sweep + screenshots                  | Visual + deterministic (overflow check)       |
| Console Health     | Console capture eval                          | Deterministic (error count)                   |
| UX Heuristics      | Snapshot + Laws of UX + Nielsen's             | Structured judgment (cite specific heuristic) |
| Error States       | Navigate to empty/error states                | Before/after comparison                       |
| Data Display       | Snapshot on tables/dashboards                 | Element match (column count, formatting)      |
| Design Consistency | Screenshot baseline + changed page comparison | Visual judgment (cite specific property)      |
| Exploratory        | Free navigation + adversarial testing         | Before/after + judgment                       |

Reference guides (load on demand):

- **Adversarial patterns** — [references/adversarial-patterns.md](references/adversarial-patterns.md) — load when testing forms, modals, navigation, or keyboard a11y
- **Browser recipes** — [references/browser-recipes.md](references/browser-recipes.md) — load when running deterministic checks (axe-core, console, images, form labels)
- **Exploratory testing** — [references/exploratory-testing.md](references/exploratory-testing.md) — load for Workflow B (no diff, open exploration)
- **UX heuristics** — [references/ux-heuristics.md](references/ux-heuristics.md) — load when evaluating UX quality or citing specific heuristics
- **Design system** — [references/design-system.example.md](references/design-system.example.md) — template for users to customize
- **Design consistency** — [references/design-consistency.md](references/design-consistency.md) — load when doing visual consistency checks
- **Parallel testing** — [references/parallel-testing.md](references/parallel-testing.md) — load for Workflow C (concurrent sessions)
- **Report template** — [references/report-template.html](references/report-template.html) — HTML template for Phase 7 report generation

For worked examples with exact commands, read [EXAMPLES.md](EXAMPLES.md) if you need to see the assertion protocol in action.

## Best Practices

1. **Be adversarial** — try to break things, don't just confirm they work
2. **Every assertion needs evidence** — snapshot ref, eval result, or before/after diff
3. **Before/after for every interaction** — snapshot, act, snapshot, compare
4. **Screenshot every failure** — a `screenshot` command immediately on STEP_FAIL, save to `.context/ui-test-screenshots/<step-id>.png`
5. **Deterministic checks first** — axe-core, console errors, form labels before visual judgment
6. **For localhost, rely on the clean isolated session** — with no `proxy`/`profile` to key the session on, each `browserless_agent` call starts clean, which is ideal for reproducible runs (a session only persists across calls when you carry the same `proxy`/`profile`); if a test needs existing login/state, do the login as the first steps of the same call
7. **No teardown needed** — there is nothing to stop, even for parallel runs; a session only persists across calls when you carry the same `proxy`/`profile`, and these runs carry neither
8. **Report failures with reproduction steps** — action, expected, actual, screenshot path, suggestion
9. **Parallelize independent tests** — use Workflow C (separate `browserless_agent` calls) when testing multiple pages or categories on a deployed site

## Troubleshooting

- **"No active page" / session error**: re-issue the `browserless_agent` call — each call spins up a fresh session
- **Dev server not responding**: `curl http://localhost:<port>` — ask user to start it
- **`evaluate` with top-level `await` fails**: wrap the body in an async IIFE or use `.then()`; return the projected value (it comes back under `.value`)
- **Element ref not found**: `snapshot` again — refs change on page update
- **Blank snapshot**: add a `waitForSelector` on an expected element (or a `goto` with `waitUntil: "load"`) before snapshotting
- **SPA deep links 404**: Navigate to `/` first, then click through
- **Deployed-site auth fails**: make sure the login steps run in the SAME `browserless_agent` call as the tests — with no `proxy`/`profile` to key the session on, the authenticated cookies won't carry to a separate call; if an anti-bot wall blocks login, add a `solve` command (a terminal `action=deny` block cannot be solved)
- **Parallel runs**: each test group is a separate `browserless_agent` call with its own isolated session — there is no shared session to collide on
- **Stale state between tests**: with no `proxy`/`profile` to key the session on, state doesn't carry across `browserless_agent` calls — a clean slate is the default (a session only persists across calls when you carry the same `proxy`/`profile`); if a test needs prior state, keep the setup and the test in one call
