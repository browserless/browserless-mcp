# Autonomous Login

A page is asking you to authenticate. **Default posture: don't.** Logins are intrusive and can damage account state. Proceed only when all three gates clear.

## Gate 1 — Is login required for _this_ task?

"Required" is contextual. If the user's task is "log in to X" / "post to X", login is required by definition — gate passed. Otherwise (extract / read / observe tasks), check whether the wall actually blocks the goal:

- Is the target content already in the DOM beneath the wall? Read it directly from the snapshot.
- Is there a dismiss (`Maybe later`, `Skip`, modal `×`)? Click it.
- Is there an alternative path — public mirror, archive.org, RSS, JSON endpoint, deep link?

If you can complete the task without authenticating, return `LOGIN_NOT_NEEDED`. Wikipedia, public docs/news, public profiles read-only — don't log in unless the user explicitly asked.

## Gate 2 — Are you authorized?

Either the user directed it, or the action is functionally blocked (401, fully gated content with Gate 1 alternatives exhausted). Convenience is not enough.

## Gate 3 — Are there credentials that unambiguously belong to _this_ site?

Credentials are identified **contextually** by name-to-domain correspondence — they don't need fixed names. The bar is **extraordinary evidence**, not plausibility.

- ✅ `instagram.com` + `instagramHandle` / `instagramPassword`
- ✅ `LOGIN_USERNAME` / `LOGIN_PASSWORD` paired with a `LOGIN_TARGET_URL` whose host matches
- ❌ `wikipedia.org` + `instagramHandle` / `instagramPassword` (names belong to a different service)
- ❌ Bare `username` / `password` with no domain qualifier (ambiguous)

If absent / ambiguous / incomplete: return `MISSING_CONTEXT`. A TOTP value follows the same contextual rule.

---

If any gate fails, stop and emit the matching `reason_code`. The rest only runs when all three pass.

## Reach the form

- Password input already in snapshot → continue.
- Sign-in link/button visible → click it, wait, re-snapshot.
- Email-first (username, no password): type username, click `Continue` / `Next`, `waitForSelector` on `input[type="password"]` (10000ms), re-snapshot.
- After two transition attempts with no password input: `FORM_NOT_FOUND` ("could not reach login form").

## Sanity check

Confirm login (not signup/reset): submit button name is `Sign in` / `Log in` / `Continue` (not `Sign up` / `Register` / `Reset`), and exactly **one** password field is present. Otherwise `FORM_NOT_FOUND`.

## Field selection (anchor off password)

- **Password**: the `input[type="password"]`. With multiples, pick the one matching `/password/i` and **not** `confirm|new password`.
- **Username**, first match: same-form `input[type="email"]` → input matching `/email|username|user|login|account/i` → the visible text/email/tel input immediately preceding the password in `ref` order.
- **Submit**, first match: same-form button matching `/^(sign in|log in|login|continue|submit)$/i` → `button[type="submit"]` in form → the only non-SSO visible button (skip `Continue with Google` etc. unless context names that provider).

Any of the three missing: `FORM_NOT_FOUND` with what's missing.

## Submit

Single batched call with the Gate-3 values:

```json
{
  "commands": [
    {
      "method": "type",
      "params": { "selector": "<username-ref>", "text": "<username-value>" }
    },
    {
      "method": "type",
      "params": { "selector": "<password-ref>", "text": "<password-value>" }
    },
    { "method": "click", "params": { "selector": "<submit-ref>" } }
  ]
}
```

Then `waitForNavigation` (10000ms) or `waitForResponse` on `*`. If both time out, verify anyway — the page may have updated in place. Re-snapshot.

## Verify success (any one, in priority order)

1. URL no longer matches `/login|signin|sign-in|log-in|auth|sso|account\/sign/i`.
2. Password input absent in new snapshot.
3. Authed-state element matching `/log out|sign out|my account|profile|dashboard|avatar/i`.

If none holds, classify the failure:

- Form error matching `/invalid|incorrect|wrong|doesn'?t match|not recognized|please try again/i` → `INVALID_CREDENTIALS`.
- Captcha indicator → **invoke the `captchas` skill**, then re-verify. If unsolvable: `CAPTCHA_BLOCKED`.
- MFA prompt → MFA branch below.
- No change, no error: `SUBMIT_NO_FEEDBACK`.

**Never retype the same credentials to retry.** Caller's call.

## MFA branch

MFA is required when the snapshot has `autocomplete="one-time-code"`, a numeric input with `maxlength` ∈ {4, 6, 8}, or a label/`name`/`placeholder` matching `/code|verification|otp|2fa|two[- ]?factor|authenticator/i`.

- Contextually-matched TOTP in context (same Gate-3 rule): type it, click submit, re-verify.
- No matching TOTP: `MFA_INPUT_MISSING`. Don't attempt SMS/email/WebAuthn.
- TOTP rejected (`/invalid|expired|incorrect/i`): `MFA_FAILED`.
- Second MFA prompt after the first cleared: `UNEXPECTED_STATE`.

## Final response

Call `close`, then emit **exactly one** fenced JSON block — nothing before or after, no prose:

````
```json
{
  "success": true,
  "reason_code": "SUCCESS",
  "final_url": "https://example.com/dashboard",
  "evidence": "URL changed from /login to /dashboard; logout button present",
  "steps_taken": 4
}
```
````

`reason_code` is one of: `SUCCESS`, `LOGIN_NOT_NEEDED`, `MISSING_CONTEXT`, `INVALID_CREDENTIALS`, `MFA_INPUT_MISSING`, `MFA_FAILED`, `CAPTCHA_BLOCKED`, `FORM_NOT_FOUND`, `SUBMIT_NO_FEEDBACK`, `FIELD_TYPE_MISMATCH`, `UNEXPECTED_STATE`. On failure, set `success: false` and `final_url` to the current URL. `steps_taken` counts your JSON-RPC calls (batched calls = 1).

## Don't

- Don't log in just because a form is visible — gates first.
- Don't use credentials whose names don't unambiguously belong to this site.
- Don't guess among multiple plausible pairs — `MISSING_CONTEXT`.
- Don't retry with the same credentials after failure.
- Don't try SSO buttons unless the task names that provider.
- Don't `evaluate` to set input `value` — use `type` so real keystrokes fire.
- Don't leak credentials into narration, errors, or non-`type.params.text` fields.
- Don't emit anything other than the final JSON block in your last message.
