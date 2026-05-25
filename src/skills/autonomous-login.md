# Autonomous Login

Page wants auth. **Default: don't.** Logins are intrusive and can damage account state. Proceed only when both gates pass.

## Gate 1 — Login required for continuing _this_ task?

If the user's task is literally "log in / post / DM", or needs login to continue, gate passed. For extract/read/observe tasks, check whether the wall actually blocks the goal:

- Target content already in DOM beneath the wall? Read it directly.
- Dismiss available (`Maybe later`, `Skip`, modal `×`)? Click it.
- Alternative path — public mirror, archive.org, RSS, JSON endpoint, deep link?

If the rest of the task completes without auth → `LOGIN_NOT_NEEDED`. Wikipedia, public docs/news, public read-only profiles.

## Gate 2 — Credentials unambiguously for _this_ site?

**Password is not required to pass Gate 2.** Many sites use magic-link / email-only / passkey auth — an email alone (or any contextually-matched identifier) can be sufficient. Don't preemptively fail Gate 2 because no password is in context; let the form tell you at runtime. Only fail Gate 2 if the form actually demands a credential type you don't have.

Identified **contextually** by name-to-domain correspondence — fixed names not required. Bar is **extraordinary evidence**, not plausibility.

- ✅ `instagram.com` + `instagramHandle` / `instagramPassword`
- ✅ `LOGIN_USERNAME` / `LOGIN_PASSWORD` paired with `LOGIN_TARGET_URL` whose host matches
- ❌ `wikipedia.org` + `instagramHandle` (names belong to a different service)
- ❌ Bare `username` / `password` with no domain qualifier (ambiguous)

Absent / ambiguous / multiple plausible pairs → `MISSING_CONTEXT`. TOTP follows the same rule.

---

If either gate fails, stop and emit the matching `reason_code`. Rest runs only when both pass.

## Reach the form

- Password input in snapshot → continue.
- Sign-in link/button visible → click, wait, re-snapshot.
- Email-first (username only): type username, click `Continue` / `Next`, `waitForSelector` on `input[type="password"]` (10000ms), re-snapshot.
- After two transitions with no password input → `FORM_NOT_FOUND`.

## Sanity check

Confirm login (not signup/reset): submit name is `Sign in` / `Log in` / `Continue` (not `Sign up` / `Register` / `Reset`), and exactly **one** password field present. Else `FORM_NOT_FOUND`.

## Field selection (anchor off password)

- **Password**: `input[type="password"]`. With multiples: matches `/password/i` and **not** `confirm|new password`.
- **Username** (first match): same-form `input[type="email"]` → input matching `/email|username|user|login|account/i` → visible text/email/tel input immediately preceding the password in `ref` order.
- **Submit** (first match): same-form button matching `/^(sign in|log in|login|continue|submit)$/i` → `button[type="submit"]` in form → the only non-SSO visible button (skip `Continue with Google` etc. unless context names that provider).

Any missing → `FORM_NOT_FOUND` with what's missing.

## Submit

Single batched call (type username, type password, click submit) with Gate-2 values. Then `waitForNavigation` (10000ms) or `waitForResponse` on `*`. If both time out, verify anyway — page may have updated in place. Re-snapshot.

## Verify success (any one, priority order)

1. URL no longer matches `/login|signin|sign-in|log-in|auth|sso|account\/sign/i`.
2. Password input absent from new snapshot.
3. Authed-state element matching `/log out|sign out|my account|profile|dashboard|avatar/i`.

If none holds:

- Form error matching `/invalid|incorrect|wrong|doesn'?t match|not recognized|please try again/i` → `INVALID_CREDENTIALS`.
- Captcha indicator → invoke `captchas` skill, re-verify. Unsolvable → `CAPTCHA_BLOCKED`.
- MFA prompt → MFA branch.
- No change, no error → `SUBMIT_NO_FEEDBACK`.

**Never retype the same credentials to retry.** Caller's call.

## MFA branch

Required when snapshot has `autocomplete="one-time-code"`, numeric input with `maxlength` ∈ {4, 6, 8}, or label/`name`/`placeholder` matching `/code|verification|otp|2fa|two[- ]?factor|authenticator/i`.

- Contextually-matched TOTP available (same Gate-2 rule) → type, click submit, re-verify.
- **No matching TOTP in context → ask the user for the code in plain text and STOP this turn. Do not call `close`. Do not emit the final JSON block. Leave the agent session open so the next turn can resume — the OTP input is still on the page and the cookies/state are intact.** When the user replies with a code, treat it as the TOTP value, type + click submit + re-verify. If the user declines or says they don't have one → `MFA_INPUT_MISSING`. Never attempt SMS/email/WebAuthn flows.
- TOTP rejected (`/invalid|expired|incorrect/i`) → ask user for a fresh code (same don't-close rule); after one fresh-code rejection → `MFA_FAILED`.
- Second MFA prompt after first cleared → `UNEXPECTED_STATE`.

## Final response

Call `close`, then emit **exactly one** fenced JSON block — nothing before or after, no prose. Fields: `success`, `reason_code`, `final_url`, `evidence`, `steps_taken` (JSON-RPC call count; batched call = 1). On failure, `success: false` and `final_url` = current URL.

`reason_code` ∈ `SUCCESS` | `LOGIN_NOT_NEEDED` | `MISSING_CONTEXT` | `INVALID_CREDENTIALS` | `MFA_INPUT_MISSING` | `MFA_FAILED` | `CAPTCHA_BLOCKED` | `FORM_NOT_FOUND` | `SUBMIT_NO_FEEDBACK` | `FIELD_TYPE_MISMATCH` | `UNEXPECTED_STATE`.

## Don't

- Log in just because a form is visible — gates first.
- Use credentials whose names don't unambiguously belong to this site.
- Guess among multiple plausible pairs — `MISSING_CONTEXT`.
- Retry with the same credentials after failure.
- Try SSO buttons unless the task names that provider.
- `evaluate` to set input `value` — use `type` so real keystrokes fire.
- Leak credentials into narration, errors, or non-`type.params.text` fields.
- Emit anything other than the final JSON block in your last *terminal* message (ask-the-user turns are not terminal — emit plain prose and stop without `close`).
- Close the session while waiting for a user-supplied OTP — leave it open so cookies, page state, and the OTP input survive the round-trip.
