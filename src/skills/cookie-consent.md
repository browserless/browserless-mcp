# Cookie Consent Banners

The current snapshot contains a button or link with text matching `accept all`, `reject all`, `consent`, or `cookies`. This is a consent banner — handle it **before** anything else on the page. Banners overlay content, intercept clicks, and break selectors below them.

## Recipe

1. **Find the dismiss button in the current snapshot.** Look for buttons with names like:
   - `Reject all`, `Decline`, `Deny`, `Refuse all`
   - `Accept all`, `Accept`, `Agree` (use only if no reject option exists — you cannot interact with a site that rejected your consent on every load)
   - `Manage preferences`, `Cookie settings` (avoid — opens a sub-flow you'll need to navigate)
2. **Click via its `ref=` or `deep-ref=` selector.** Most modern banners (OneTrust, Cookiebot, Didomi, Quantcast Choice, TrustArc) render in shadow DOM, so expect `deep-ref=`.
3. **Re-snapshot.** The DOM behind the banner changes once it closes; your previous element refs are stale.
4. **Then proceed** with the actual task.

## When the dismiss button is NOT in the snapshot

The banner is rendering inside a shadow root the accessibility tree didn't pierce. Try a deep selector by host:

| Vendor    | Common deep selector                                                 |
| --------- | -------------------------------------------------------------------- |
| OneTrust  | `< #onetrust-reject-all-handler` or `< #onetrust-accept-btn-handler` |
| Cookiebot | `< #CybotCookiebotDialogBodyButtonDecline`                           |
| Didomi    | `< #didomi-notice-disagree-button`                                   |
| Quantcast | `< button.css-47sehv` (reject) — class names rotate, snapshot first  |
| TrustArc  | `< *consent.trustarc.com* #decline_btn_text` (iframe-hosted)         |
| Cookieyes | `< .cky-btn-reject`                                                  |

If none match, fall back to attribute-based deep selectors: `< button[aria-label*="Reject" i]`, `< button[id*="reject" i]`. See the shadow-dom skill for full deep-selector syntax.

## Anti-patterns

- **Do not** click `Accept all` reflexively. Sites then track aggressively and may serve different content. Prefer reject when both are present.
- **Do not** try to dismiss via `evaluate` removing the banner element. The site's consent state is server-side or in cookies; visually hiding the banner doesn't grant access and often leaves event handlers blocking clicks.
- **Do not** continue with the task using selectors from the pre-dismiss snapshot. Always re-snapshot after the banner closes.

## Batching

This is one of the few places batching helps even with a click: combine the dismiss click with a re-snapshot in the next call.

```json
{
  "commands": [
    {
      "method": "click",
      "params": { "selector": "< #onetrust-reject-all-handler" }
    },
    { "method": "snapshot" }
  ]
}
```
