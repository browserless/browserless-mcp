# Autonomous Login

Page wants auth. **Default: don't.** Logins are intrusive and can damage account state. Proceed only when the gates below pass.

## Gate 0 — Did you drop your session binding?

`profile` (and `proxy`) bind **each** call to its hydrated session. If an earlier call this flow was logged in but this one looks logged out, the cause is almost certainly a missing `profile`/`proxy` param on **this** call — not stale cookies. Re-issue the call **with** the binding before treating the wall as real. Never re-authenticate to repair a parameter you forgot to pass.

## Gate 1 — Login required to continue _this_ task?

Task is literally "log in / post / DM" or needs login to proceed → pass. For read/extract tasks, check the wall actually blocks the goal:

- Content already in DOM beneath the wall → read it.
- Dismiss available (`Maybe later`, `Skip`, `×`) → click it.
- Alt path (public mirror, archive.org, RSS, JSON endpoint, deep link) → use it.

Task completes without auth → `LOGIN_NOT_NEEDED` (Wikipedia, public docs/news, public read-only profiles).

## Gate 2 — Credentials unambiguously for _this_ site?

**Password not required** — magic-link / email-only / passkey sites accept an email (or any contextually-matched identifier) alone. Don't fail early for a missing password; let the form demand it at runtime. Fail only if the form requires a credential type you lack.

Match **contextually** by name-to-domain correspondence (fixed names not required). Bar is **extraordinary evidence**, not plausibility.

- ✅ `instagram.com` + `instagramHandle`/`instagramPassword`
- ✅ `LOGIN_USERNAME`/`LOGIN_PASSWORD` + `LOGIN_TARGET_URL` host matches
- ❌ `wikipedia.org` + `instagramHandle` (different service)
- ❌ bare `username`/`password`, no domain qualifier (ambiguous)

Absent / ambiguous / multiple plausible pairs → `MISSING_CONTEXT`. TOTP same rule.

Gate 1 or 2 fails → stop; the matching `reason_code` is your outcome (see Final response). (Gate 0 isn't a stop — it means fix the call and retry.) Continue only when both pass.

## Reach the form

- Password input in snapshot → continue.
- An `Account` / user-menu toggle (`[202] div button "Account"`) often hides both `Sign in` and `Register` — click it and re-snapshot before guessing URLs.
- Sign-in link/button → click, wait, re-snapshot. Take the control that _advances_ sign-in for **this** site (`Sign in`, `Log in`, `Sign in to an existing account`, `Continue`) — not a generic nav link that reloads the page you're on, not `Sign up`/`Create account`.
- **Account / identity chooser** (page offers several ways in — `Sign in with <Site>` next to `Continue with Google`/`Apple`/`Amazon`/`Facebook`/…): take **this site's own** option, matched to `LOGIN_TARGET_URL`'s brand/host. A third-party identity provider only when the credential context names that provider, or it is the _sole_ option. A site's own `Sign in with <Site>` is the native path even beside a third-party one. A chooser is not `FORM_NOT_FOUND`.
- Email-first → type username, click `Continue`/`Next`, `waitForSelector` on `input[type="password"]` (10000ms), re-snapshot.
- Multi-hop is normal (landing → chooser → form): keep taking the native sign-in step and re-snapshotting **while each hop reveals a new sign-in step**. `FORM_NOT_FOUND` only after **two transitions that reveal no new sign-in affordance and no password** — reloading the same URL is not progress.
- **Before typing credentials, check origin.** The form must be on `LOGIN_TARGET_URL`'s host or that site's own auth host (`accounts.`/`login.`/`secure.<site>`, `<site>/ap/signin`, …). If the only form is on an **unrelated third-party origin** the credentials aren't scoped to, go back and take the native option — typing there is refused server-side and wastes the attempt. No native path → `MISSING_CONTEXT`.

## Sanity check

Login, not signup/reset: submit reads `Sign in`/`Log in`/`Continue` (not `Sign up`/`Register`/`Reset`) and exactly **one** password field. Else `FORM_NOT_FOUND`. A sign-up form when the task is to create an account → load `autonomous-registration` instead of `FORM_NOT_FOUND`.

## Field selection (anchor off password)

- **Password**: `input[type="password"]`; with multiples, matches `/password/i` and not `confirm|new password`.
- **Username** (first hit): same-form `input[type="email"]` → `/email|username|user|login|account/i` → visible text/email/tel input immediately preceding the password in `ref` order.
- **Submit** (first hit): same-form button `/^(sign in|log in|login|continue|submit)$/i` → `button[type="submit"]` in form → the only non-SSO visible button (skip `Continue with Google` etc. unless context names that provider).

Anything missing → `FORM_NOT_FOUND` (say what's missing).

## Submit

One batched call (type username, type password, click submit) with Gate-2 values → `waitForNavigation` (10000ms) or `waitForResponse` on `*`. Both time out → verify anyway (page may update in place). Re-snapshot. **Never retype the same credentials to retry** — caller's call. If `loadSecret` filled a field, keep the batch as fill → click submit → `waitForNavigation`: the MCP allows navigation and response waits while the capture gate is armed and lowers the gate itself when the navigation completes; it still refuses `snapshot` and captures until then, so on a timeout (no navigation) `waitForSelector` for a signed-in element first, then send `{ method: "clearSecrets" }` before the first snapshot.

Before clearing after a timeout, require both a newly appeared post-submit marker and removal of every secret-filled field. Use secret-safe `waitForSelector` for `body:not(:has(<filled-field-selector>))` per field (10000ms); hidden fields still carry values, and a pre-existing Account link proves nothing. Any wait fails → do not clear or snapshot; send the applicable reports (`reportSkillOutcome` if you loaded a site recipe, then `reportOutcome` with `success: false`, `reason` `other`), then `close`; the outcome is `SUBMIT_NO_FEEDBACK`. This rule also applies to TOTP and emailed-code submissions below.

## Verify success (any one, priority order)

1. URL no longer matches `/login|signin|sign-in|log-in|auth|sso|account\/sign/i`.
2. Password input absent from new snapshot.
3. Authed element matching `/log out|sign out|my account|profile|dashboard|avatar/i`.

The visible account/display name will usually NOT equal the email or username you typed (it's the profile's display name, often a real name) — that's expected, NOT a mismatch. Never mark a login failed because the shown identity differs from the credential; judge only by the three signals above.

**If this session was opened with** `profile`, end the verifying batch with
`snapshot`, then report the result as the last command of the next batch:
`reportProfileAuthentication` with `checkpointId` = `"<host>:after-login"`,
`outcome: "authenticated"` only for a visible signed-in element, `"login_required"`
for a sign-in form or wall, `"challenge"` for MFA, captcha or verification walls,
and `"unknown"` otherwise. A changed URL or missing password input alone is not
signed-in evidence. Always set `"newLoginActivity": true` (you attempted login,
so the restored profile gets no credit). It defaults to the last active-tab
snapshot; if you used `snapshot { targetId }` to peek at another tab, repeat
that `targetId` in the report. Send it before any `close`; it is secret-safe,
so it may follow `clearSecrets` — after a `loadSecret` fill the verifying
`snapshot` itself can only run after `clearSecrets` or completed navigation (see Submit).
Pass `sessionId` on every follow-up call, including reports and `close`;
the session handle retains the profile, so repeating `profile` is optional.

None holds:

- Error matching `/invalid|incorrect|wrong|doesn'?t match|not recognized|please try again/i` → `INVALID_CREDENTIALS`.
- Captcha → invoke `captchas` skill, re-verify; unsolvable → `CAPTCHA_BLOCKED`.
- MFA prompt → MFA branch.
- No change, no error → `SUBMIT_NO_FEEDBACK`.

## MFA branch

Triggered by `autocomplete="one-time-code"`, numeric input with `maxlength` ∈ {4,6,8}, or label/`name`/`placeholder` matching `/code|verification|otp|2fa|two[- ]?factor|authenticator/i`.

- Contextually-matched TOTP (Gate-2 rule; an `op://…?attribute=otp` ref via `loadSecret`, or a user-supplied code via `type`) → fill, submit, re-verify.

**Emailed code.** If the task names a mailbox item in the bound vault, let the site send the code, focus the code input, then send `{ method: "loadSecret", params: { ref: "mail://<vault>/<item>/otp", selector: "<code input>" } }` — the server polls that mailbox for up to ~45 s and types the newest code; you never see it (vault and item segments are URL-encoded; append `?wait=90000` for slow senders). In the same batch click the submit control, then `waitForNavigation` (10000ms) — the MCP allows navigation and response waits while the capture gate is armed and lowers the gate itself when the navigation completes; if it times out, `waitForSelector` (secret-safe) for a signed-in control or confirmation element, then `{ method: "clearSecrets" }` and re-verify; neither appears → treat the code as not accepted and do not `clearSecrets` to peek. `OtpTimeout` → click `Resend` once and retry once. **No mailbox item, or two timeouts → ask the user for the code in plain text and STOP this turn. Do NOT `close` — this turn is not your final response. Leave the session open so the code input and cookies survive the round-trip.** User replies → `type` it, submit, re-verify. **Magic link** (no code field) → ask the user to click it, keep the session open, then re-verify. **Phone/SMS or WebAuthn** → never attempt.

- No matching TOTP and no mailbox item → ask the user (the rule above). User declines / has none, or the prompt demands phone/SMS or WebAuthn → `MFA_INPUT_MISSING`.
- Code rejected (`/invalid|expired|incorrect/i`) → ask for a fresh code (same don't-close rule); one fresh-code rejection → `MFA_FAILED`.
- Second MFA prompt after the first cleared → `UNEXPECTED_STATE`.

## After a `loadSecret` login — re-enable captures

Filled a field with `loadSecret` (1Password `op://` ref or emailed code)? The backend capture gate can remain armed even after navigation: `screenshot`, PDF, `liveURL` and page-content reads (`evaluate`/`html`/`text`/`querySelector`/`cookies`) fail with `CaptureBlockedError`. A completed navigation lets the MCP request a snapshot, whose secret values remain omitted while the backend gate is armed. Confirm every secret-filled field is removed (see Submit), then send `{ method: "clearSecrets" }` before the first capture. Secret values stay masked in the session replay regardless. Plaintext `type` logins don't arm the gate — this step applies only when `loadSecret` filled a field.

## Final response

Your last message is a reply to the user, in plain language — never a status object. It answers the task they gave you: when logging in was one step of a bigger task, finish that task and answer it; the login gets a sentence only where it matters. When the login failed or was not needed, say so and why (e.g. "the site rejected the credentials", "no credentials for this site were provided") and name the page you ended on.

Before that reply, send `reportOutcome` as the system prompt describes, then `close`. A login that blocked the task is `success: false` with `reason` `captcha` for `CAPTCHA_BLOCKED`, `login_required` for `MISSING_CONTEXT` / `INVALID_CREDENTIALS` / `MFA_INPUT_MISSING` / `MFA_FAILED`, else `other`.

Only when your instructions or the task ask for a machine-readable final result (a fenced JSON block, a response schema, named fields) produce it exactly as they specify. Where that format lists its own allowed values for a field, use those values; use the `reason_code` below only where it asks for a reason or result code without listing values. Otherwise never end with a JSON block.

`reason_code` ∈ `SUCCESS` | `LOGIN_NOT_NEEDED` | `MISSING_CONTEXT` | `INVALID_CREDENTIALS` | `MFA_INPUT_MISSING` | `MFA_FAILED` | `CAPTCHA_BLOCKED` | `FORM_NOT_FOUND` | `SUBMIT_NO_FEEDBACK` | `FIELD_TYPE_MISMATCH` | `UNEXPECTED_STATE`.

## Don't

- Log in just because a form is visible — gates first.
- Re-authenticate to fix an apparent logout before confirming you passed `profile`/`proxy` (Gate 0).
- Use credentials whose names don't unambiguously belong to this site; guess among plausible pairs (→ `MISSING_CONTEXT`); or retry the same credentials after failure.
- Try SSO buttons unless the task names that provider.
- `evaluate` to set input `value` — use `type` so real keystrokes fire.
- Leak credentials into narration, errors, or non-`type.params.text` fields.
- End your reply with a JSON block or a bare `reason_code` unless your instructions or the task ask for that format.
- `close` while awaiting a user-supplied OTP — leave the session open so cookies, page state, and the OTP input survive the round-trip.
