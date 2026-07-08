---
name: browserbase-cli
description: Use the Browserbase CLI (`browse`) for Browserbase Functions and platform API workflows. Use when the user asks to run `browse`, deploy or invoke functions, manage sessions, projects, contexts, or extensions, fetch a page through the Browserbase Fetch API, search the web through the Browserbase Search API, or scaffold starter templates. Prefer the Browser skill for interactive browsing; use the top-level `browse` driver commands only when the user explicitly wants the CLI path.
compatibility: 'Requires the Browserbase CLI (`npm install -g browse`). API commands require `BROWSERBASE_API_KEY`.'
license: MIT
allowed-tools: Bash
---

# Browserbase CLI

Use the official `browse` CLI for Browserbase platform operations, Functions workflows, and Fetch API calls.

## Setup check

Before using the CLI, verify it is installed:

```bash
which browse || npm install -g browse
browse --help
```

For authenticated commands, set the API key:

```bash
export BROWSERBASE_API_KEY="your_api_key"
```

## When to use this skill

Use this skill when the user wants to:

- run Browserbase commands through `browse`
- scaffold, develop, publish, or invoke Browserbase Functions
- inspect or manage Browserbase sessions, projects, contexts, or extensions
- fetch a page through Browserbase without opening a browser session
- search the web through Browserbase without opening a browser session
- browse or scaffold starter templates with browserless templates

## When not to use this skill

- For interactive browsing, page inspection, screenshots, clicking, typing, or login flows, prefer the `browser` skill.
- For simple HTTP content retrieval where the user does not care about using the CLI specifically, the dedicated `fetch` skill is often a better fit.
- Use the top-level `browse` driver verbs (open, get, click, …) only when the user explicitly wants the CLI path or is already working in a `browse`-centric workflow.

## Command selection

- browserless_function for local dev, packaging, publishing, and invocation
- the `cloud sessions`, `cloud projects`, `cloud contexts`, `cloud extensions` subcommands for Browserbase platform resources
- the `a direct HTTP fetch <url>` subcommand for Fetch API requests
- the `cloud search "<query>"` subcommand for Search API requests
- browserless templates to browse and scaffold starter templates
- the top-level driver verbs (open, get, click, …) for direct local/remote browser driving
- `browse skills install` to install Browserbase agent skills for Claude Code

For local browser work, the `open <url> --local` driver command starts a clean isolated browser. Use `open <url> --auto-connect` only when you need to attach to an existing debuggable Chrome session.

## Common workflows

### Functions

```bash
browserless_function init my-function
cd my-function
browserless_function dev index.ts
browserless_function publish index.ts
browserless_function invoke <function_id> --params '{"url":"https://example.com"}'
```

Use `browserless_function invoke --check-status <invocation_id>` to poll an existing invocation instead of creating a new one.

### Platform APIs

```bash
# All run under the `browse` CLI as `cloud …` subcommands:
cloud projects list
cloud sessions create --region us-east-1                # add stealth + residential-proxy options as needed
cloud sessions create --context-id ctx_abc --persist    # add the captcha-solving option as needed
cloud sessions get <session_id>
cloud sessions downloads get <session_id> --output session-artifacts.zip
cloud contexts create --body '{"region":"us-west-2"}'
cloud extensions upload ./my-extension.zip
```

### Fetch API

```bash
a direct HTTP fetch https://example.com
a direct HTTP fetch https://example.com --output page.html      # add the follow-redirects option as needed
```

### Search API

```bash
cloud search "browser automation"
cloud search "web scraping" --num-results 5
cloud search "AI agents" --output results.json
```

### Templates

```bash
browserless templates list
browserless templates list --tag Python --source Browserbase
browserless templates clone form-filling --language typescript
browserless templates clone amazon-product-scraping --language python ./my-scraper
```

## Best practices

1. Prefer `browse --help` and subgroup `--help` before guessing flags.
2. Use dash-case flags exactly as shown in CLI help.
3. Use `--output <file>` on the direct HTTP fetch and the browserless_search tool subcommands to save results to a file.
4. Use environment variables for auth unless the user explicitly wants one-off overrides.
5. Pass structured request bodies with JSON strings in `--body` or `--params`.
6. Remember that both the `functions` and `cloud` subcommand groups use `--base-url` for API base URL overrides.

## Troubleshooting

- Missing API key: set `BROWSERBASE_API_KEY` or pass `--api-key`
- Unknown flag: rerun the relevant command with `--help` and use the exact dash-case form
- Command not found: re-run `npm install -g browse` and verify with `which browse`

For command-by-command reference and more examples, see [REFERENCE.md](REFERENCE.md).
