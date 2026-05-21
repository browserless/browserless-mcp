# Captchas & Bot Challenges

The page is showing a captcha widget (reCAPTCHA, hCaptcha, Cloudflare Turnstile, DataDome) **or** a navigation just returned a 403/429 with bot-challenge headers. You cannot click through these like a normal element — use the dedicated `solve` command.

> **EXPERIMENTAL — Cloud-only.** The `solve` command is available on Browserless Cloud (`production.browserless.io`) only. Self-hosted Enterprise images do not include the solver backend; on those, fall back to `smartscraper` or human-in-the-loop via `liveURL`.

## The `solve` command

```json
{
  "method": "solve",
  "params": { "type": "recaptcha", "wait": true, "timeout": 30000 }
}
```

All params are optional:

- **`type`** — if omitted, the solver auto-detects. Specify only when auto-detection fails or you know the type up front. Valid values:
  `cloudflare`, `hcaptcha`, `recaptcha`, `recaptchaV3`, `geetest`, `normal`, `friendlyCaptcha`, `capy`, `textCaptcha`, `amazonWaf`, `dataDome`, `akamai`, `lemin`, `mtcaptcha`, `slider`
- **`wait`** (default `true`) — wait for the captcha to appear before solving. Set to `false` if you've already verified it's on screen.
- **`timeout`** (default 30000ms) — how long to wait for the captcha to appear. The solver itself is not bounded by this once a captcha is found.

## Response shape

```json
{
  "found": true,
  "solved": true,
  "time": 18342,
  "token": "03AGdBq25..."
}
```

- `found: false` → no captcha was detected within `timeout`. The page may have already passed the challenge, or the heuristic was wrong.
- `found: true, solved: false` → captcha was found but the solver failed (rate-limited, unsupported variant, page navigated mid-solve). Re-snapshot and reassess; do not retry blindly.
- `solved: true` → token was injected into the page. The site's own JS still needs to submit it. **Re-snapshot and look for a "Continue" / "Submit" button**, or wait for the navigation the site triggers automatically.

## Recipe

1. **Run `solve` with no `type`** — let auto-detection do its job:

   ```json
   { "method": "solve", "params": {} }
   ```

2. **Check `found`/`solved`.**
3. **Re-snapshot** — the page state changes after a successful solve.
4. If a continue/submit button appears, click it. If the page navigates on its own, follow with `waitForNavigation`.

## Escalation when `solve` fails

1. If `found: false` but you can clearly see a widget, **specify the `type` explicitly** and retry once.
2. If `solved: false`, do **not** retry `solve` immediately — it costs and is rate-limited. Re-snapshot first.
3. If repeated solves fail on the same page, fall back to `smartscraper` (different code path with separate evasion tactics) or surface a `liveURL` so a human can complete the challenge.

## Don't

- Don't click on captcha checkboxes via `click` with a deep selector. It opens the challenge UI but doesn't solve it; you'll be stuck staring at images of crosswalks.
- Don't `evaluate` JS to set `g-recaptcha-response` directly. Tokens are bound to a session and signed by the solver; a hand-written value is rejected.
