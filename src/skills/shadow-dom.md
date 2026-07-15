# Shadow DOM & Iframes

Snapshot contains `deep-ref=` selectors, or you hit `SELECTOR_NOT_FOUND` on regular selector. Page using shadow DOM or iframes — read before next action.

## Iframes in the snapshot

Iframes (same-origin and cross-origin) are now snapshotted too. When present:

- Snapshot shows a `Frames (N iframes):` block listing each frame's label, URL, and origin.
- Elements inside a frame are tagged `[frame#N]` and carry a ready `deep-ref=` selector — cross-origin uses `< *url* css`, same-origin uses `< css`. Pass it as-is to `click`/`type`/`hover`/`checkbox` — no frame switching, no hand-construction.

Only build a deep selector by hand (below) when a frame element wasn't surfaced (a11y-empty widget, capped snapshot).

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

<!-- compliant-omit -->

## Constructing deep selectors for iframes snapshot didn't surface

Fallback only — most cross-origin iframes are now in the snapshot (see above). Some widgets still have nothing meaningful in the accessibility tree. Build selector by hand:

- `< *google.com/recaptcha* #recaptcha-anchor` — reCAPTCHA checkbox
- `< *hcaptcha.com* #checkbox` — hCaptcha checkbox
- `< *stripe.com/* input[name='cardnumber']` — Stripe payment field
- `< *challenges.cloudflare.com* input[type='checkbox']` — Cloudflare Turnstile

URL pattern is glob — `*` matches any substring.

<!-- /compliant-omit -->

## What works and what doesn't

Coordinate-based actions work through deep selectors: **`click`, `type`, `hover`, `checkbox`**.

DOM-read actions **don't** work, fail or return null: **`text`, `html`, `waitForSelector`** with deep selectors.

<!-- compliant-only -->

To read content inside a frame or shadow root, use the snapshot — iframes are surfaced above with ready `deep-ref=` selectors — or `screenshot` the page and read it visually. Deep selectors are for interaction, not reading.

<!-- /compliant-only -->

<!-- compliant-omit -->

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

<!-- /compliant-omit -->

## Recovery when regular selector fails

1. Retry same selector with `< ` prefix (MCP suggests automatically)
2. Still failing → re-snapshot (element moved/re-rendered or page navigated)
3. Element in iframe → construct `< *url-pattern* css` selector by hand from iframe URL in DevTools or snapshot
