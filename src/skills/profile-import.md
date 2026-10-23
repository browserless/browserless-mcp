# Profile Import (CLI)

Import the user's own signed-in Chrome/Brave/Edge/Chromium with the Browserless
CLI (`@browserless.io/cli`, Node 24+). This requires running on the user's own
machine (Claude Code, Codex, Cursor, a terminal). Hosted chat, remote shells and
containers without access to that browser must use the creation recipe in
`auth-profile` instead; do not try to capture a different machine's browser.

## Recipe

1. **Check existing profiles.** Call `browserless_profiles`. The listing gives
   saved names and counts, not host or origin metadata. Have the user
   confirm the exact saved profile name for the target host before reusing it
   and stopping this import recipe; do not infer a match from the name alone.
   Otherwise continue the import recipe.

2. **Ensure the CLI.** Run `browserless --version`. If missing, run
   `npm install -g @browserless.io/cli`. If `browserless profile terms` exits 1
   with `error: unknown command` on stderr, upgrade with
   `npm install -g @browserless.io/cli@latest` and retry. Allow only one upgrade
   attempt for this recipe, including Step 6: if the required command or option
   remains unavailable, stop and explain rather than looping or bypassing consent.
   Do not treat a generic failure as a reason to upgrade.

3. **Resolve the token without exposing it.** In this order:
   - Run `test -n "$BROWSERLESS_TOKEN"`; if successful, the CLI inherits it.
   - Otherwise, if `jq` is available, read only this client's **Browserless**
     entry, project `.mcp.json` first, otherwise `~/.claude.json`. The only
     token-carrying form is a shell substitution inside the environment prefix
     of the same CLI command. For a literal Bearer header, use this prefix on
     the upload or refresh command from Step 6:
     ```bash
     BROWSERLESS_TOKEN="$(jq -r '.mcpServers.browserless.headers.Authorization // empty' .mcp.json | sed 's/^Bearer //')" browserless profile upload --browser <b> --profile <p> --name <host> --only-domain <host> --only-domain <idp> --accept-terms --json
     ```
     This is a command template, **not permission to upload before Step 5**.
     Omit the identity-provider flag only when no identity provider is needed.
     For a legacy query-parameter URL, extract the token query value from that
     Browserless entry through the same substitution, never output the URL.
     In `~/.claude.json`, user-scope entries are at `.mcpServers.browserless`;
     local-scope entries are at `.projects["<cwd>"].mcpServers.browserless`.
     A header containing `${BROWSERLESS_TOKEN}` is not a literal credential:
     the user must set the shell variable; never pass that placeholder to the CLI.
     Never `cat` the config, inspect another server's entry, echo, persist or
     separately assign the token. Disable shell tracing; do not run this with
     `set -x`. If no usable entry exists or `jq` is missing, skip this route.
   - Ask the user to export `BROWSERLESS_TOKEN` in their shell or run
     `browserless auth login` themselves. Never invent a token or ask them to
     paste one into chat. Stop until credentials are available.

4. **Pick the source profile.** Run `browserless profile sources list --json`.
   If more than one browser/profile candidate exists, ask the user which one.

5. **Consent (required).** Run `browserless profile terms` and relay its output
   **verbatim**, together with the proposed `--only-domain` list: the target
   host and its identity provider (for example, `example.com` and `google.com`).
   Ask when unsure which domains are needed. Wait for an **explicit yes** to
   that notice and domain list. No yes → stop. Never pass `--accept-terms`
   otherwise. If the domain list changes, ask again before sending it.

6. **Upload.** On macOS, warn that the one-time "Chrome Safe Storage" Keychain
   prompt may appear and the user must click **Always Allow**. With the consented
   browser, profile, name and domains, run:

   ```bash
   browserless profile upload --browser <b> --profile <p> --name <host> --only-domain <host> --only-domain <idp> --accept-terms --json
   ```

   Use the Step 3 environment prefix if needed; omit `<idp>` only if unnecessary.
   Preserve every consented `--only-domain` on **every retry and refresh**.

   | Exit                                                                 | Recovery                                                                                                                                                                                               |
   | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | 1 with `error: unknown command` or `error: unknown option` on stderr | Older CLI: use Step 2's one upgrade attempt and retry once; still unsupported → stop. Other exit-1 errors: explain, do not loop.                                                                       |
   | 2 (usage)                                                            | Fix invalid flag values; do not broaden the consented domains.                                                                                                                                         |
   | 3 (precondition)                                                     | Missing token or unaccepted terms: return to Step 3 or 5.                                                                                                                                              |
   | 4 (capture)                                                          | Keychain unanswered or browser launch failed: confirm with the user, retry once, then stop if still failing.                                                                                           |
   | 5 (server)                                                           | Name exists: choose another name, or refresh with the command below. 2 MB cap: add `--auto-fit --keep-domain <host>` without dropping any `--only-domain`. Other server errors: surface them and stop. |

   ```bash
   browserless profile refresh --browser <b> --profile <p> --name <saved-name> --only-domain <host> --only-domain <idp> --accept-terms --json
   ```

   For a name collision, `<saved-name>` is the existing cloud profile name the
   user confirms they want to refresh; never infer it from the target host.
   Retry a corrected upload/refresh once; persistent failure → stop and report
   the error without credentials or captured state. Inspect the JSON result and
   surface any partial-capture/skipped-state warnings; never echo cookie values.
   Remember the successful result's `name` as `<saved-name>` for reuse and later
   refreshes. It may differ from `<host>` after a name collision; keep the target
   URL and domain filters tied to `<host>`, not the saved profile name.

7. **Use it.** Call `browserless_agent`:

   ```json
   {
     "profile": "<saved-name>",
     "keepSessionAlive": true,
     "commands": [
       { "method": "goto", "params": { "url": "https://<host>" } },
       { "method": "snapshot" }
     ]
   }
   ```

   Before any login actions, send `reportProfileAuthentication` as the only
   command of the next batch, with the returned `sessionId`:

   ```json
   {
     "sessionId": "<returned-sessionId>",
     "commands": [
       {
         "method": "reportProfileAuthentication",
         "params": {
           "checkpointId": "<host>:first-page",
           "outcome": "authenticated",
           "newLoginActivity": false
         }
       }
     ]
   }
   ```

   Choose `authenticated` only for a visible signed-in element; a sign-in wall
   means `login_required`, verification/captcha means `challenge`, otherwise
   `unknown`. Follow `auth-profile` for peek/targetId and subsequent reporting.

8. **Dead login.** For `login_required`, ask the user to sign in locally in
   their real browser, then repeat Step 6 with `profile refresh --name <saved-name>`,
   preserving the consented domains and token handling. After a successful
   refresh, close the old kept-alive session:

   ```json
   {
     "sessionId": "<old-sessionId>",
     "commands": [{ "method": "close" }]
   }
   ```

   Repeat Step 7 without `sessionId` to start a fresh session hydrated from the
   refreshed profile, then inspect its snapshot and report authentication again.
   Updating a saved profile does not update the old browser's state. Or load
   `autonomous-login` for the cloud-login fallback. Do not silently perform new
   login activity.

## Never

- No `--accept-terms` without the user's explicit yes after the verbatim notice.
- No whole-profile upload without `--only-domain` unless the user explicitly
  asks for it after the notice; explain the broader scope and obtain consent.
- Never echo the token or cookie values, including in errors or debug output.
- Never run `profile launch`: it needs the user's browser closed.
