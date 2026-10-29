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

The email/identifier comes from the user or the task context — never invent one, never use a disposable inbox unless the user supplied it. Name, phone and address fields only from user-supplied values; leave the rest blank. The password sink is a 1Password integration bound with write access (`saveSecret`): none bound → `NO_CREDENTIAL_SINK` — the password is never typed in the open or printed, so without a vault there is nowhere for it to go. If the integration sees several vaults, the task (or the user, when asked) names the one to use; list order never does. Bar is **extraordinary evidence**, not plausibility. Absent / ambiguous identifier → `MISSING_CONTEXT`.

Gate 1 or 2 fails → stop; the matching `reason_code` is your outcome (see Final response). Continue only when both pass.

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

**Write it to the vault first, then fill from the vault.** Once the form is located and Gates 0-2 pass: `{ method: "saveSecret", params: { title: "<site host>", username: "<email>", password: "<the password>", website: "<origin>" } }` → `{ ok: true, ref }`. Omit `vault`; the server picks the only vault the service account sees. If the task names a vault, pass it as `vault` on the first attempt. `{ ok: false, error: "VaultAmbiguous", vaults: [...] }` with no vault named by the task → **ask the user which of the listed vaults to use and STOP this turn** — plain text, do NOT `close`; this turn is not your final response and the session stays open. Never infer authorization from list order. User replies → retry once with that `vault`; user declines or names none → `VAULT_WRITE_FAILED`, and name the listed vault titles in your reply. `VaultNotFound` or `IntegrationNotWritable` → `VAULT_WRITE_FAILED` (nothing was typed, no account exists). `CredentialNotResolved` → Gate 0. Then fill from the vault: `{ method: "loadSecret", params: { ref: "<ref>", selector: "<password>" } }` and, only when the form has a confirm field, `{ method: "loadSecret", params: { ref: "<ref>", selector: "<confirm>" } }` — the site receives exactly the stored value and you never type it. A site that later rejects the password on policy grounds → generate a compliant one, `saveSecret` again with title `"<site host> (2)"`, fill from the new ref and resubmit **once**; name the stale item in your reply.

## Submit

One batched call: `loadSecret` password → `loadSecret` confirm (when present) → required checkboxes → click submit → `waitForNavigation` (10000ms). The MCP allows navigation and response waits while the capture gate is armed (they return navigation/response metadata, not page content). Completed navigation permits a verification snapshot without `clearSecrets`. Timed out (no full-page navigation — single-page app or asynchronous submit): the gate stays armed and you cannot snapshot yet. `waitForSelector` (secret-safe, 10000ms) for a post-submit marker — the verification code input (`input[autocomplete="one-time-code"], input[name*="code" i]`), a signed-in control (`a[href*="logout" i], a[href*="signout" i]`), or a confirmation element the page promised. Marker found and secret-field removal confirmed below → `{ method: "clearSecrets" }` → re-snapshot → verify. No marker either → **fail closed**: do not `clearSecrets` to peek (the password may still sit in the form), `close`, and report `SUBMIT_NO_FEEDBACK` and give the vault item's title and `op://` reference (the vault item exists; the account may or may not). **Never resubmit blindly** — a second submit can create a duplicate account, trip a rate limit or lock the identifier; resubmit only after a policy rejection with a new password.

Before clearing on an in-place update, also use `waitForSelector` for `body:not(:has(<filled-field-selector>))` for **each** password/confirm/code field that received a secret (10000ms). This tests removal, not visibility: hidden fields still carry values. A marker that existed before submit, including a generic Account link, is not a post-submit marker. Any removal wait times out → fail closed as above; do not clear or read the page.

## Verify success (check the challenge first, then positive evidence)

0. A verification screen ("check your email", "enter the code we sent", a code field, `autocomplete="one-time-code"`) → Verification branch. Check this **before** the signals below: a redirect from the sign-up page to a verify page also leaves the sign-up path and drops the password input, and that is not success yet.
1. Signed-in element matching `/log out|sign out|my account|dashboard|avatar/i`.
2. Explicit account-created confirmation matching `/account (was |has been )?created|registration (is )?(complete|successful)|successfully (registered|signed up)|thank you for (registering|signing up|creating)/i`.

A URL change away from the sign-up path with no password input is **not** success on its own — a bounce to a public or sign-in page looks exactly the same. `waitForTimeout` 2000ms, re-snapshot once; still neither 1 nor 2 → `SUBMIT_NO_FEEDBACK`: say the outcome is unverified and give the vault item's title and `op://` reference so the user can check the account.

None of 0-2 holds and the form is still there:

- Error matching `/already (registered|exists|in use)|taken|exists/i` → `ACCOUNT_EXISTS` (load `autonomous-login` if the task allows signing in).
- Error matching `/password.*(must|least|weak|invalid|requirements)/i` → policy rejection (see Password).
- Captcha → `captchas` skill, re-verify; unsolvable → `CAPTCHA_BLOCKED`.
- No change, no error → `SUBMIT_NO_FEEDBACK`.

A vault item exists from the moment `saveSecret` succeeded: give its title and `op://` reference whatever the outcome, so the item of a failed sign-up can be deleted.

## Verification branch (mirror of login's MFA branch)

Triggered by `autocomplete="one-time-code"`, a numeric input with `maxlength` ∈ {4,6,8}, a label/`name`/`placeholder` matching `/code|verif|otp|confirm/i`, or text like "we sent a code/link to <email>".

**Emailed code.** If the task names a mailbox item in the bound vault, let the site send the code, focus the code input, then send `{ method: "loadSecret", params: { ref: "mail://<vault>/<item>/otp", selector: "<code input>" } }` — the server polls that mailbox for up to ~45 s and types the newest code; you never see it (vault and item segments are URL-encoded; append `?wait=90000` for slow senders). In the same batch click the submit control, then `waitForNavigation` (10000ms) — the MCP allows navigation and response waits while the capture gate is armed and lowers the gate itself when the navigation completes; if it times out, `waitForSelector` (secret-safe) for a signed-in control or confirmation element, then `{ method: "clearSecrets" }` and re-verify; neither appears → treat the code as not accepted and do not `clearSecrets` to peek. `OtpTimeout` → click `Resend` once and retry once. **No mailbox item, or two timeouts → ask the user for the code in plain text and STOP this turn. Do NOT `close` — this turn is not your final response. Leave the session open so the code input and cookies survive the round-trip.** User replies → `type` it, submit, re-verify. **Magic link** (no code field) → ask the user to click it, keep the session open, then re-verify. **Phone/SMS or WebAuthn** → never attempt.

Registration outcomes: user declines or has no code → `EMAIL_CODE_REQUIRED`; two timeouts and no user-supplied code → `EMAIL_CODE_TIMEOUT`; phone/SMS verification demanded → `PHONE_VERIFICATION_REQUIRED`; authenticator (QR) setup → skip when optional, else `MFA_SETUP_REQUIRED`; a second verification prompt after the first cleared → `UNEXPECTED_STATE`. The vault item already exists at this point — give its title and `op://` reference whatever the outcome.

## After a `loadSecret` fill — re-enable captures

Filled a field with `loadSecret` (the password, the confirm field, or the emailed code)? The MCP refuses `snapshot` and captures until `clearSecrets` or a completed top-frame navigation, including `waitForNavigation`. Navigation/response/selector waits are allowed while armed and return no page content. The backend capture gate can remain armed even after navigation: its snapshot omits secret values, while `screenshot`, PDF, `liveURL` and page-content reads (`evaluate`/`html`/`text`/`querySelector`/`cookies`) still fail with `CaptureBlockedError`. Before those captures, confirm every secret-filled field is removed (see Submit), then send `{ method: "clearSecrets" }`. This removal rule also applies to emailed codes; a click or a response alone never suffices. Secret values stay masked in the session replay regardless. Plaintext `type` fills don't arm the gate.

## Final response

Your last message is a reply to the user, in plain language — never a status object. Say whether the account was created and, if not, why. Whenever `saveSecret` succeeded, give the account email and the vault item's title and `op://` reference, so the user can find the credential or delete the item of a failed sign-up. The password itself never appears in the final response. When creating the account was one step of a bigger task, finish that task and answer it.

Before that reply, send `reportOutcome` as the system prompt describes, then `close`. A registration that blocked the task is `success: false` with `reason` `captcha` for `CAPTCHA_BLOCKED`, else `other`.

Only when your instructions or the task ask for a machine-readable final result (a fenced JSON block, a response schema, named fields) produce it exactly as they specify, with the `reason_code` below wherever it asks for a reason or result code; the account email, `credential_ref` (the `op://…` ref, or `null`) and `vault_item_title` (or `null`) go in its own fields when it has them, else in its answer text. Otherwise never end with a JSON block.

`reason_code` ∈ `SUCCESS` | `REGISTRATION_NOT_NEEDED` | `MISSING_CONTEXT` | `NO_CREDENTIAL_SINK` | `ACCOUNT_EXISTS` | `FORM_NOT_FOUND` | `CAPTCHA_BLOCKED` | `POLICY_REJECTED` | `EMAIL_CODE_REQUIRED` | `EMAIL_CODE_TIMEOUT` | `PHONE_VERIFICATION_REQUIRED` | `MFA_SETUP_REQUIRED` | `VAULT_WRITE_FAILED` | `SUBMIT_NO_FEEDBACK` | `UNEXPECTED_STATE`.

Ask-the-user turns aren't final — plain prose, stop, no `close`.

## Don't

- Register because a form is visible — gates first.
- Invent identities, use disposable inboxes the user didn't supply, or fill name/phone/address from guesses.
- Tick marketing or newsletter opt-ins.
- Reuse a password across sites, or put it anywhere but the `saveSecret` call — never in `type`, `rationale`, `_prompt`, `evaluate` code or prose.
- Submit before the password (and confirm field, when present) was filled from the vault, or resubmit after an error that isn't a policy rejection.
- `evaluate` to set input values — use `type` (non-secret fields) or `loadSecret` (the password) so real keystrokes fire.
- Use SSO unless the task names the provider.
- Leak credentials into narration, errors, or non-credential params.
- End your reply with a JSON block or a bare `reason_code` unless your instructions or the task ask for that format.
- `close` while awaiting a user-supplied code — leave the session open so cookies, page state, and the code input survive the round-trip.
