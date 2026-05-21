# Captchas & Bot Challenges

Page shows captcha widget (reCAPTCHA, hCaptcha, Cloudflare Turnstile, DataDome) **or** navigation returned 403/429 with bot-challenge headers. Use `solve` command, not click.

> **EXPERIMENTAL — Cloud-only.** `solve` works on `production.browserless.io` only. Self-hosted Enterprise lacks solver backend; use `smartscraper` or `liveURL` instead.

## `solve` command

```json
{
  "method": "solve",
  "params": { "type": "recaptcha", "wait": true, "timeout": 30000 }
}
```

**Params (all optional):**

- `type` — auto-detects if omitted. Specify only when needed: `cloudflare`, `hcaptcha`, `recaptcha`, `recaptchaV3`, `geetest`, `normal`, `friendlyCaptcha`, `capy`, `textCaptcha`, `amazonWaf`, `dataDome`, `akamai`, `lemin`, `mtcaptcha`, `slider`
- `wait` (default `true`) — wait for captcha appearance. `false` if already visible
- `timeout` (default 30000ms) — wait duration for detection

## Response

```json
{ "found": true, "solved": true, "time": 18342, "token": "03AGdBq25..." }
```

- `found: false` → no captcha within timeout. May be passed or wrong heuristic
- `found: true, solved: false` → detected but failed (rate-limited/unsupported variant/nav mid-solve). Re-snapshot; don't retry blindly
- `solved: true` → token injected. **Re-snapshot for Continue/Submit button** or await auto-navigation

## Recipe

1. Run `solve` with no `type`: `{ "method": "solve", "params": {} }`
2. Check `found`/`solved`
3. Re-snapshot (page state changed)
4. Click continue button if present, or `waitForNavigation`

## Escalation on failure

1. `found: false` but widget visible → specify `type`, retry once
2. `solved: false` → re-snapshot first (don't retry immediately; costs & rate-limited)
3. Repeated failures → use `smartscraper` or surface `liveURL` for human

## Don't

- Click checkboxes via `click` — opens challenge UI but doesn't solve
- `evaluate` JS to set `g-recaptcha-response` — tokens session-bound; hand-written values rejected
