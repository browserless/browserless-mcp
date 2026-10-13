# Autonomous Registration

Task needs a new account. **Default: don't.** Registering creates state on someone else's system and can violate its terms. Proceed only when the gates below pass.

## Gate 0 — Did you drop your session binding?

`profile`, `proxy`, `integrationId` (its `op_int_…` id or its label) and `allowedDomains` bind **each** call to its session, and the vault binding is read once at browser launch. If `saveSecret` returns `CredentialNotResolved`, or an earlier call this flow was bound and this one is not, the cause is almost certainly a missing `integrationId` on **this** call — not a broken vault. Re-issue the call **with** the binding. A session opened without `integrationId` can never write to the vault: `close` it and reopen with `integrationId` on the first call before touching the form — adding it later silently opens a different browser. Gate 0 isn't a stop — fix the call and retry.

## Gate 1 — Registration required to continue _this_ task?

Task is literally "register / create an account / sign up for X" → pass. Otherwise, check the wall actually needs an account:

- Goal reachable as a guest or on a public path (guest checkout, public listing, read-only page) → do that instead → `REGISTRATION_NOT_NEEDED`.
- The page says this identifier already has an account → `ACCOUNT_EXISTS`, load `autonomous-login` instead.
- A login wall you were not asked to cross is never a reason to create an account.

## Gate 2 — Identity and credential sink unambiguously for _this_ registration?

The email/identifier comes from the user or the task context — never invent one, never use a disposable inbox unless the user supplied it. Name, phone and address fields only from user-supplied values; leave the rest blank. The password sink is a 1Password integration bound with write access (`saveSecret`): none bound → `NO_CREDENTIAL_SINK` — the password is never typed in the open or printed, so without a vault there is nowhere for it to go. Bar is **extraordinary evidence**, not plausibility. Absent / ambiguous identifier → `MISSING_CONTEXT`.

Gate 1 or 2 fails → stop, emit the matching `reason_code`. Continue only when both pass.

## Reach the form

- Password input next to a `Create account`/`Sign up`/`Register` control in snapshot → continue.
- Take the control that _advances account creation_ (`Create account`, `Sign up`, `Register`, `Join`, `Continue`) — not `Sign in`, not a generic nav link that reloads the page you're on.
- An `Account` / user-menu toggle (`[202] div button "Account"`) usually hides both `Sign in` and `Register` — click it and re-snapshot before guessing URLs.
- **Account / identity chooser**: take **this site's own** option. A third-party identity provider only when the task names that provider.
- Email-first → type the email, click `Continue`/`Next`, `waitForSelector` on `input[type="password"]` (10000ms), re-snapshot.
- A Cloudflare interstitial that never resolves on the first `goto` is IP reputation — `close`, reopen with `proxy: { proxy: "residential" }` (and `os`) on the first call, keeping `integrationId`.
- Captcha → invoke the `captchas` skill; after `solved: true` re-snapshot and confirm the **form** accepted it (a multi-form page can receive the token in the wrong widget).
- Multi-hop is normal (landing → menu → chooser → form). `FORM_NOT_FOUND` only after **two transitions that reveal no new sign-up affordance and no password field** — reloading the same URL is not progress.
- **Before typing anything, check origin.** The form must be on the task's host or that site's own auth host (`accounts.`/`login.`/`secure.<site>`, …). A form on an unrelated third-party origin → go back and take the native option; no native path → `MISSING_CONTEXT`.

## Sanity check

Registration, not login/reset: submit reads `Create account`/`Sign up`/`Register`/`Join`/`Continue` (not `Sign in`/`Log in`/`Reset`) and the form has **one or two** password fields (the second is confirm). Exactly one password field beside `Forgot password?` is a login form → wrong form; a login form when the task is registration → keep looking, do not log in.

## Field selection (anchor off password)

- **Password**: `input[type="password"]` not matching `/confirm|repeat|again|re-?enter|verify/i`.
- **Confirm**: the other `input[type="password"]`, if any.
- **Email / username** (first hit): same-form `input[type="email"]` → `/email|e-?mail|username|user|login/i` → the visible text input immediately preceding the password in `ref` order.
- **Required checkboxes**: check only terms / age / privacy boxes that are `required` or block submit; leave marketing and newsletter opt-ins unchecked.
- **Policy**: read any password-rule text near the field before generating.
- **Submit** (first hit): same-form button `/^(create (an |your )?account|sign up|register|join|continue|submit)$/i` → `button[type="submit"]` in form → the only non-SSO visible button.

Anything missing → `FORM_NOT_FOUND` (say what's missing).

## Password and vault write (registration-only)

Generate a password that satisfies the visible policy — default 20+ characters with upper, lower, digit and symbol, no quotes or spaces. It goes into exactly one tool call: `saveSecret`. Never put it in `type`, `rationale`, `_prompt`, `evaluate` code, narration, errors or the final response, and never reuse one across sites.

**Write it to the vault first, then fill from the vault.** Once the form is located and Gates 0-2 pass: `{ method: "saveSecret", params: { title: "<site host>", username: "<email>", password: "<the password>", website: "<origin>" } }` → `{ ok: true, ref }`. Omit `vault`; the server picks the only vault the service account sees. `{ ok: false, error: "VaultAmbiguous", vaults: [...] }` → retry once with `vault` set to the matching title (prefer one named after the site or the user, else the first). `VaultNotFound` or `IntegrationNotWritable` → `VAULT_WRITE_FAILED` (nothing was typed, no account exists). `CredentialNotResolved` → Gate 0. Then fill both fields from the vault: `{ method: "loadSecret", params: { ref: "<ref>", selector: "<password>" } }` and `{ method: "loadSecret", params: { ref: "<ref>", selector: "<confirm>" } }` — the site receives exactly the stored value and you never type it. A site that later rejects the password on policy grounds → generate a compliant one, `saveSecret` again with title `"<site host> (2)"`, fill from the new ref and resubmit **once**; name the stale item in `evidence`.

## Submit

One batched call: `loadSecret` password → `loadSecret` confirm → required checkboxes → click submit → `{ method: "clearSecrets" }` → `waitForNavigation` (10000ms) or `waitForResponse` on `*`. The `clearSecrets` goes **before** the wait: the preflight rejects waits, snapshots and captures after a `loadSecret` until `clearSecrets` or a top-frame `goto`, and the value being cleared is a password you generated, so clearing right after the click discloses nothing (the replay stays masked). Both time out → verify anyway (page may update in place). Re-snapshot. **Never resubmit blindly** — a second submit can create a duplicate account, trip a rate limit or lock the identifier; resubmit only after a policy rejection with a new password.

## Verify success (any one, priority order)

1. URL left the sign-up path and no password input remains.
2. Authed element matching `/log out|sign out|my account|welcome|dashboard|avatar/i`.
3. A verification screen ("check your email", "enter the code we sent", a code field) → Verification branch.

None holds:

- Error matching `/already (registered|exists|in use)|taken|exists/i` → `ACCOUNT_EXISTS` (load `autonomous-login` if the task allows signing in).
- Error matching `/password.*(must|least|weak|invalid|requirements)/i` → policy rejection (see Password).
- Captcha → `captchas` skill, re-verify; unsolvable → `CAPTCHA_BLOCKED`.
- No change, no error → `SUBMIT_NO_FEEDBACK`.

A vault item exists from the moment `saveSecret` succeeded: report it in `credential_ref` and `vault_item_title` whatever the outcome, so the item of a failed sign-up can be deleted.

## Verification branch (mirror of login's MFA branch)

Triggered by `autocomplete="one-time-code"`, a numeric input with `maxlength` ∈ {4,6,8}, a label/`name`/`placeholder` matching `/code|verif|otp|confirm/i`, or text like "we sent a code/link to <email>".

**Emailed code.** If the task names a mailbox item in the bound vault, let the site send the code, focus the code input, then send `{ method: "loadSecret", params: { ref: "mail://<vault>/<item>/otp", selector: "<code input>" } }` — the server polls that mailbox for up to ~45 s and types the newest code; you never see it (vault and item segments are URL-encoded; append `?wait=90000` for slow senders). In the same batch click the submit control, then send `{ method: "clearSecrets" }`, and only then `waitForNavigation` — the preflight rejects waits, snapshots and captures after a `loadSecret` until `clearSecrets` or a top-frame `goto`. `OtpTimeout` → click `Resend` once and retry once. **No mailbox item, or two timeouts → ask the user for the code in plain text and STOP this turn. Do NOT `close`, do NOT emit the final JSON. Leave the session open so the code input and cookies survive the round-trip.** User replies → `type` it, submit, re-verify. **Magic link** (no code field) → ask the user to click it, keep the session open, then re-verify. **Phone/SMS or WebAuthn** → never attempt.

Registration outcomes: user declines or has no code → `EMAIL_CODE_REQUIRED`; two timeouts and no user-supplied code → `EMAIL_CODE_TIMEOUT`; phone/SMS verification demanded → `PHONE_VERIFICATION_REQUIRED`; authenticator (QR) setup → skip when optional, else `MFA_SETUP_REQUIRED`; a second verification prompt after the first cleared → `UNEXPECTED_STATE`. The vault item already exists at this point — report it in `credential_ref` whatever the outcome.

## After a `loadSecret` fill — re-enable captures

Filled a field with `loadSecret` (the password, the confirm field, or the emailed code)? The session's capture gate is now armed: `screenshot`, PDF, `liveURL`, and page-content reads (`evaluate`/`html`/`text`/`querySelector`/`cookies`) all fail with `CaptureBlockedError` until cleared, and the MCP refuses `waitForNavigation`/`waitForResponse`/`snapshot` until you send `{ method: "clearSecrets" }` or a top-frame `goto`/`back`/`forward`/`reload`. A full-page navigation clears the server-side gate automatically — a single-page app that verifies without navigating does **not**. Secret values stay masked in the session replay regardless. Plaintext `type` fills (the email and other non-secret fields) don't arm the gate.

## Final response

`close`, then emit **exactly one** fenced JSON block — nothing before or after, no prose. Fields: `success`, `reason_code`, `final_url`, `evidence`, `steps_taken` (JSON-RPC call count; batched call = 1), `account_identifier` (the email), `credential_ref` (the `op://…` ref, or `null`), `vault_item_title` (or `null`). The password itself never appears in the final response. On failure: `success: false`, `final_url` = current URL.

`reason_code` ∈ `SUCCESS` | `REGISTRATION_NOT_NEEDED` | `MISSING_CONTEXT` | `NO_CREDENTIAL_SINK` | `ACCOUNT_EXISTS` | `FORM_NOT_FOUND` | `CAPTCHA_BLOCKED` | `POLICY_REJECTED` | `EMAIL_CODE_REQUIRED` | `EMAIL_CODE_TIMEOUT` | `PHONE_VERIFICATION_REQUIRED` | `MFA_SETUP_REQUIRED` | `VAULT_WRITE_FAILED` | `SUBMIT_NO_FEEDBACK` | `UNEXPECTED_STATE`.

Ask-the-user turns aren't terminal — plain prose, stop, no `close`.

## Don't

- Register because a form is visible — gates first.
- Invent identities, use disposable inboxes the user didn't supply, or fill name/phone/address from guesses.
- Tick marketing or newsletter opt-ins.
- Reuse a password across sites, or put it anywhere but the `saveSecret` call — never in `type`, `rationale`, `_prompt`, `evaluate` code or prose.
- Submit before both password fields were filled from the vault, or resubmit after an error that isn't a policy rejection.
- `evaluate` to set input values — use `type` (non-secret fields) or `loadSecret` (the password) so real keystrokes fire.
- Use SSO unless the task names the provider.
- Leak credentials into narration, errors, or non-credential params.
- Emit anything but the final JSON in your last _terminal_ message.
- `close` while awaiting a user-supplied code — leave the session open so cookies, page state, and the code input survive the round-trip.
