# Authenticated Profiles

A **profile** is a server-side bundle of cookies, localStorage, and IndexedDB
captured from a live agent session and replayed on future sessions that connect
with `profile=<name>`. Use it whenever a task needs the browser to start
already signed in.

## Recipe — reusing an existing profile

Before creating a new profile, call `browserless_profiles` to list the profiles
already saved for this token. If one matches the site you need, reuse it by
passing its `name` as `profile` to the tool you're running — no new login
needed. Only fall through to the creation recipe below when no suitable profile
exists.

After the batch that ends with your first `snapshot` on the site, send
`reportProfileAuthentication` as the last command of the next batch (params:
`checkpointId` = `"<host>:first-page"`, `outcome`, `newLoginActivity: false`; it
applies to the tab of that snapshot — pass `targetId` only for another tab).
`authenticated` only if a signed-in element is visible; `login_required` if you
see a sign-in form or wall; `challenge` for a captcha or verification wall;
otherwise `unknown`. If the saved login turns out to be dead and you log in
again, load `autonomous-login` and let it report with `newLoginActivity: true`.
Repeat the same `profile` together with `sessionId` on every follow-up call,
including reports and `close`.

## Recipe — creating a profile

1. **Open a creation session.** Call `browserless_agent` with a top-level
   `createProfile` object — do NOT pass `profile` (the two are mutually
   exclusive). The MCP tool calls `POST /profile` for you, attaches the WS
   to the creation session, and gives you a non-headless browser with a
   10-minute keepalive:
   ```json
   {
     "createProfile": { "name": "github" },
     "commands": [
       { "method": "goto", "params": { "url": "https://github.com/login" } }
     ]
   }
   ```
2. **Drive the auth flow like a normal task.** Type credentials (use values
   the user supplied — never invent them), submit, and handle any
   MFA/CAPTCHA step. If a CAPTCHA appears, load the `captchas` skill and
   run `solve`.
3. **Verify you are actually signed in before saving.** Re-snapshot and
   confirm at least one of:
   - an authenticated-only element (account menu, "Sign out" link, avatar)
   - the URL is the post-login destination (not `/login`, `/signin`, or an
     error path)
   - a known auth cookie name appears in `document.cookie`
     If none of these hold, do NOT save — a logged-out profile is worse than
     no profile.
4. **Call `saveProfile`** as the next command (JSON-RPC, no `Browserless.`
   prefix):
   ```json
   { "method": "saveProfile", "params": { "name": "github" } }
   ```
   Pass the same `name` you opened the session with. If a profile with that
   name already exists for this token, the call returns `ok: false` with an
   `error` saying the profile already exists. Don't retry `saveProfile` with the
   same name — choose a different name, or tell the user a profile by that name
   already exists.
5. **Inspect the result.** A successful save returns:

   ```json
   {
     "ok": true,
     "profileId": "...",
     "name": "github",
     "cookieCount": 12,
     "originCount": 3,
     "skippedOriginsCount": 0,
     "skippedIdbDatabasesCount": 0,
     "skippedIdbStoresCount": 0
   }
   ```

   - `cookieCount === 0` is a red flag — the site likely uses session-only
     cookies or storage you can't capture. Tell the user.
   - Any non-zero `skipped*` count means partial capture — surface it.

6. **Close** the session. Tell the user the profile name and how to use it
   ("future calls can pass `profile: \"github\"`"). Do not echo cookie
   values or any captured state.
