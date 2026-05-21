# Shadow DOM & Iframes

Snapshot contains `deep-ref=` selectors, or you hit `SELECTOR_NOT_FOUND` on regular selector. Page using shadow DOM or iframes — read before next action.

## Deep selectors: `< ` prefix

Browserless deep selectors start with `< ` (less-than, space). Space mandatory. Format:

```
< *url-pattern* css-selector
```

`*url-pattern*` optional, matches iframe URL. If omitted, selector pierces shadow roots in main frame.

When snapshot lists `deep-ref=< button#deny`, pass to `click` / `type` / `hover` exactly as shown — don't strip `< ` prefix:

```json
{ "method": "click", "params": { "selector": "< button#deny" } }
```

## Constructing deep selectors for iframes snapshot didn't surface

Snapshots only include accessible content. Iframes (captcha/payment widgets) often have nothing meaningful in accessibility tree. Build selector by hand:

- `< *google.com/recaptcha* #recaptcha-anchor` — reCAPTCHA checkbox
- `< *hcaptcha.com* #checkbox` — hCaptcha checkbox
- `< *stripe.com/* input[name='cardnumber']` — Stripe payment field
- `< *challenges.cloudflare.com* input[type='checkbox']` — Cloudflare Turnstile

URL pattern is glob — `*` matches any substring.

## What works and what doesn't

Coordinate-based actions work through deep selectors: **`click`, `type`, `hover`, `checkbox`**.

DOM-read actions **don't** work, fail or return null: **`text`, `html`, `waitForSelector`** with deep selectors.

To read content from shadow root or iframe, use `evaluate` with explicit traversal:

```json
{
  "method": "evaluate",
  "params": {
    "content": "(() => { const f = document.querySelector('iframe#myFrame'); return f?.contentDocument?.body?.textContent; })()"
  }
}
```

For shadow DOM:

```json
{
  "method": "evaluate",
  "params": {
    "content": "(() => document.querySelector('my-component')?.shadowRoot?.querySelector('button')?.textContent)()"
  }
}
```

## Recovery when regular selector fails

1. Retry same selector with `< ` prefix (MCP suggests automatically)
2. Still failing → re-snapshot (element moved/re-rendered or page navigated)
3. Element in iframe → construct `< *url-pattern* css` selector by hand from iframe URL in DevTools or snapshot
