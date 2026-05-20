# Shadow DOM & Iframes

The current snapshot contains `deep-ref=` selectors, or you just hit `SELECTOR_NOT_FOUND` on a regular selector. Either way, the page is using shadow DOM or iframes — read this before your next action.

## Deep selectors: the `< ` prefix

Browserless deep selectors start with `< ` (less-than, space). The space is mandatory. The format is:

```
< *url-pattern* css-selector
```

The `*url-pattern*` segment is optional and matches the iframe URL. If omitted, the selector pierces shadow roots in the main frame.

When the snapshot lists `deep-ref=< button#deny`, pass it to `click` / `type` / `hover` exactly as shown — do not strip the `< ` prefix:

```json
{ "method": "click", "params": { "selector": "< button#deny" } }
```

## Constructing deep selectors for iframes the snapshot didn't surface

Snapshots only include accessible content. Iframes (especially captcha and payment widgets) often have nothing meaningful in the accessibility tree. Build the selector by hand:

- `< *google.com/recaptcha* #recaptcha-anchor` — reCAPTCHA checkbox
- `< *hcaptcha.com* #checkbox` — hCaptcha checkbox
- `< *stripe.com/* input[name='cardnumber']` — Stripe payment field
- `< *challenges.cloudflare.com* input[type='checkbox']` — Cloudflare Turnstile

The URL pattern is a glob — `*` matches any substring.

## What works and what doesn't

Coordinate-based actions work through deep selectors: **`click`, `type`, `hover`, `checkbox`**.

DOM-read actions do **not** work and will fail or return null: **`text`, `html`, `waitForSelector`** with deep selectors.

To read content from a shadow root or iframe, use `evaluate` with explicit traversal:

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

## Recovery recipe when a regular selector fails

1. First retry the same selector with the `< ` prefix (the MCP suggests this automatically).
2. If still failing, re-snapshot — the element may have moved, re-rendered, or the page may have navigated.
3. If the element is in an iframe, construct a `< *url-pattern* css` selector by hand from the iframe URL you can see in DevTools or the snapshot.
