# Cookie Consent Banners

Snapshot contains button/link matching `accept all`, `reject all`, `consent`, or `cookies`. Handle consent banner **before** anything else. Banners overlay content, intercept clicks, break selectors.

## Recipe

1. **Find dismiss button in snapshot.** Look for:
   - `Reject all`, `Decline`, `Deny`, `Refuse all`
   - `Accept all`, `Accept`, `Agree` (only if no reject — can't interact with site rejecting consent every load)
   - `Manage preferences`, `Cookie settings` (avoid — opens sub-flow)
2. **Click via `ref=` or `deep-ref=`.** Modern banners (OneTrust, Cookiebot, Didomi, Quantcast Choice, TrustArc) render in shadow DOM; expect `deep-ref=`
3. **Re-snapshot.** DOM behind banner changes on close; previous refs stale
4. **Proceed** with actual task

## Dismiss button NOT in snapshot

Banner rendering inside shadow root accessibility tree didn't pierce. Try deep selector by host:

| Vendor    | Common deep selector                                                 |
| --------- | -------------------------------------------------------------------- |
| OneTrust  | `< #onetrust-reject-all-handler` or `< #onetrust-accept-btn-handler` |
| Cookiebot | `< #CybotCookiebotDialogBodyButtonDecline`                           |
| Didomi    | `< #didomi-notice-disagree-button`                                   |
| Quantcast | `< button.css-47sehv` (reject) — class names rotate, snapshot first  |
| TrustArc  | `< *consent.trustarc.com* #decline_btn_text` (iframe-hosted)         |
| Cookieyes | `< .cky-btn-reject`                                                  |

No match → fallback to attribute-based deep selectors: `< button[aria-label*="Reject" i]`, `< button[id*="reject" i]`. See shadow-dom skill for full syntax.

## Don't

- Click `Accept all` reflexively. Sites track aggressively and may serve different content. Prefer reject when both present
- Dismiss via `evaluate` removing banner element. Consent state server-side/cookies; hiding banner doesn't grant access, leaves event handlers blocking clicks
- Continue with selectors from pre-dismiss snapshot. Always re-snapshot after close

## Batching

Combine dismiss click with re-snapshot:

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
