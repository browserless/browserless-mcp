# Authenticated Profiles

A **profile** is a server-side bundle of cookies, localStorage, and IndexedDB
captured from a live agent session and replayed on future sessions that connect
with `profile=<name>`. Use it whenever a task needs the browser to start
already signed in.

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
   Pass the same `name` you opened the session with. If the same
   `(token, name)` pair already exists, the server returns a `BAD_PARAMS`
   error telling you to use `refreshProfile` — switch and retry once. Do
   not retry `saveProfile` with the same name.
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
