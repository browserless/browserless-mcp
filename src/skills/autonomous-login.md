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

Gate 1 or 2 fails → stop, emit the matching `reason_code`. (Gate 0 isn't a stop — it means fix the call and retry.) Continue only when both pass.

## Reach the form

- Password input in snapshot → continue.
- Sign-in link/button → click, wait, re-snapshot. Take the control that _advances_ sign-in for **this** site (`Sign in`, `Log in`, `Sign in to an existing account`, `Continue`) — not a generic nav link that reloads the page you're on, not `Sign up`/`Create account`.
- **Account / identity chooser** (page offers several ways in — `Sign in with <Site>` next to `Continue with Google`/`Apple`/`Amazon`/`Facebook`/…): take **this site's own** option, matched to `LOGIN_TARGET_URL`'s brand/host. A third-party identity provider only when the credential context names that provider, or it is the _sole_ option. A site's own `Sign in with <Site>` is the native path even beside a third-party one. A chooser is not `FORM_NOT_FOUND`.
- Email-first → type username, click `Continue`/`Next`, `waitForSelector` on `input[type="password"]` (10000ms), re-snapshot.
- Multi-hop is normal (landing → chooser → form): keep taking the native sign-in step and re-snapshotting **while each hop reveals a new sign-in step**. `FORM_NOT_FOUND` only after **two transitions that reveal no new sign-in affordance and no password** — reloading the same URL is not progress.
- **Before typing credentials, check origin.** The form must be on `LOGIN_TARGET_URL`'s host or that site's own auth host (`accounts.`/`login.`/`secure.<site>`, `<site>/ap/signin`, …). If the only form is on an **unrelated third-party origin** the credentials aren't scoped to, go back and take the native option — typing there is refused server-side and wastes the attempt. No native path → `MISSING_CONTEXT`.

## Sanity check

Login, not signup/reset: submit reads `Sign in`/`Log in`/`Continue` (not `Sign up`/`Register`/`Reset`) and exactly **one** password field. Else `FORM_NOT_FOUND`.

## Field selection (anchor off password)

- **Password**: `input[type="password"]`; with multiples, matches `/password/i` and not `confirm|new password`.
- **Username** (first hit): same-form `input[type="email"]` → `/email|username|user|login|account/i` → visible text/email/tel input immediately preceding the password in `ref` order.
- **Submit** (first hit): same-form button `/^(sign in|log in|login|continue|submit)$/i` → `button[type="submit"]` in form → the only non-SSO visible button (skip `Continue with Google` etc. unless context names that provider).

Anything missing → `FORM_NOT_FOUND` (say what's missing).

## Submit

One batched call (type username, type password, click submit) with Gate-2 values → `waitForNavigation` (10000ms) or `waitForResponse` on `*`. Both time out → verify anyway (page may update in place). Re-snapshot. **Never retype the same credentials to retry** — caller's call.

## Verify success (any one, priority order)

1. URL no longer matches `/login|signin|sign-in|log-in|auth|sso|account\/sign/i`.
2. Password input absent from new snapshot.
3. Authed element matching `/log out|sign out|my account|profile|dashboard|avatar/i`.

The visible account/display name will usually NOT equal the email or username you typed (it's the profile's display name, often a real name) — that's expected, NOT a mismatch. Never mark a login failed because the shown identity differs from the credential; judge only by the three signals above.

None holds:

- Error matching `/invalid|incorrect|wrong|doesn'?t match|not recognized|please try again/i` → `INVALID_CREDENTIALS`.
- Captcha → invoke `captchas` skill, re-verify; unsolvable → `CAPTCHA_BLOCKED`.
- MFA prompt → MFA branch.
- No change, no error → `SUBMIT_NO_FEEDBACK`.

## MFA branch

Triggered by `autocomplete="one-time-code"`, numeric input with `maxlength` ∈ {4,6,8}, or label/`name`/`placeholder` matching `/code|verification|otp|2fa|two[- ]?factor|authenticator/i`.

- Contextually-matched TOTP (Gate-2 rule) → type, submit, re-verify.
- **No matching TOTP → ask the user for the code in plain text and STOP this turn. Do NOT `close`, do NOT emit the final JSON. Leave the session open so the OTP input and cookies/state survive to next turn.** User replies → treat as the TOTP, type + submit + re-verify. User declines / has none → `MFA_INPUT_MISSING`. Never attempt SMS/email/WebAuthn.
- TOTP rejected (`/invalid|expired|incorrect/i`) → ask for a fresh code (same don't-close rule); one fresh-code rejection → `MFA_FAILED`.
- Second MFA prompt after the first cleared → `UNEXPECTED_STATE`.

## Final response

`close`, then emit **exactly one** fenced JSON block — nothing before or after, no prose. Fields: `success`, `reason_code`, `final_url`, `evidence`, `steps_taken` (JSON-RPC call count; batched call = 1). On failure: `success: false`, `final_url` = current URL.

`reason_code` ∈ `SUCCESS` | `LOGIN_NOT_NEEDED` | `MISSING_CONTEXT` | `INVALID_CREDENTIALS` | `MFA_INPUT_MISSING` | `MFA_FAILED` | `CAPTCHA_BLOCKED` | `FORM_NOT_FOUND` | `SUBMIT_NO_FEEDBACK` | `FIELD_TYPE_MISMATCH` | `UNEXPECTED_STATE`.

## Don't

- Log in just because a form is visible — gates first.
- Re-authenticate to fix an apparent logout before confirming you passed `profile`/`proxy` (Gate 0).
- Use credentials whose names don't unambiguously belong to this site; guess among plausible pairs (→ `MISSING_CONTEXT`); or retry the same credentials after failure.
- Try SSO buttons unless the task names that provider.
- `evaluate` to set input `value` — use `type` so real keystrokes fire.
- Leak credentials into narration, errors, or non-`type.params.text` fields.
- Emit anything but the final JSON in your last _terminal_ message (ask-the-user turns aren't terminal — plain prose, stop, no `close`).
- `close` while awaiting a user-supplied OTP — leave the session open so cookies, page state, and the OTP input survive the round-trip.
