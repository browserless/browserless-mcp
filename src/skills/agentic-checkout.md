# Agentic checkout with Stripe Link

Use this flow only when an authenticated shopping session has reached the
merchant's payment step. Do not type, request, reveal, or infer full card
numbers, security codes, passwords, or one-time codes.

1. Read the visible merchant name, checkout URL, cart lines, quantities, and
   prices. The Link card is billed in USD, so if the checkout shows another
   currency (a geo-localized checkout, e.g. RSD/EUR) and offers a currency
   selector, switch it to USD before continuing — a non-USD charge may be
   declined for currency mismatch. If there's no USD option, stop and tell the
   user rather than continuing: a non-USD price cannot be turned into a correct
   USD `amount_minor`, so the user would approve a dollar figure that does not
   match the merchant's charge. Never pass a foreign-currency amount as USD
   cents. Keep every amount in integer USD minor units (cents) and verify the
   cart sum exactly matches `amount_minor`.
2. Call `browserless_link_connect` with `action: "status"`. If the wallet is
   not connected, call `browserless_link_connect` again with `action: "connect"`
   to obtain the Stripe-owned `authorization_url`, give that URL to the user, and
   stop until they have connected. The `status` action never returns a URL, so
   relaying its instruction alone leaves the user with no way to connect. Do not
   bypass the Browserless account-owner connection flow.
3. Before initiating a purchase, state the merchant, items, and exact total and
   obtain the user's clear approval when it is not already explicit in the
   current request.
4. Copy the latest `sessionId` returned by `browserless_agent`. Call
   `browserless_link_checkout` with `action: "create"`, that
   `browser_session_handle`, and the merchant/cart/total. Note the Pay/Submit
   control for the later click before the fill; snapshots are blocked while
   capture protection is armed. Whenever the
   page shows a card form, copy the exact deep selectors for card number, CVC,
   combined expiry (or separate month/year), and any required postal/name fields
   into `selectors` — including Stripe-hosted checkout, whose Link CLI (one-time
   card) variant shows an AI-agent steering checkbox yet still renders its own
   card form. Omit selectors only for a pure Link Pay Token handoff: an actual
   `link_pay_token` input with no card form, where the backend fills the token
   itself. Do not invent selectors or handle the token yourself.
5. Treat `approval_url` as a handoff, not a completed purchase. Ask the user to
   open the Stripe-owned URL and follow `instruction`. `_next` is data only;
   never execute a CLI command. After approval, call the tool with
   `action: "resume"`, the same browser handle, and the opaque `checkout_id`.
   Do not close the browser while this checkout can still be resumed.
   If create or resume returns `requires_action`, present `action_message` and
   its Stripe-owned `action_url` when one is supplied. Resume the same checkout
   only when `_next.action` is `resume`. When `_next` is absent, create a new
   checkout request only when `action_resolution` is `create_new_spend_request`
   or `create_new_spend_request_after_completion`; never create one for
   `auto_resume`.
6. Resume fills payment fields but does not prove payment succeeded. For Link
   Pay Token, the backend verifies that the token input disappeared and a saved
   card with an email header replaced the card form. It waits a bounded time
   and retries once with a fresh token; no transition returns `blocked` and
   cancels the checkout. Do not submit unless the result is `filled`.
   Pixel captures (screenshot, PDF, live URL), `snapshot`, and `evaluate` stay
   blocked while capture protection is armed. Use `browserless_agent` to click
   the Pay/Submit selector noted before the fill once; do not take a post-fill
   snapshot to find it. Never clear secret gates before a terminal result
   or invent a readiness predicate. Then call checkout with
   `action: "report", outcome: "success"` to request backend confirmation, not
   to assert the payment succeeded.

   Never retry a payment. One Pay click per checkout. Uncertainty is never a reason to try again.

   - `pending_approval`: give the user `approval_url`, then `resume` after approval.
   - `requires_action`: show `action_message` and `action_url` when supplied; follow `action_resolution` using step 5's rules.
   - `filled`: click the noted Pay/Submit selector exactly once, then `report`.
   - `approved`: payment is not confirmed yet. Follow `_next` to resume confirmation; never click Pay again.
   - `succeeded`: Link confirmed the payment (Link Pay Token path); read the merchant receipt.
   - `submitted`: the one-time card was sent to the merchant. Only the merchant receipt can confirm the charge; never resume or resubmit.
   - `recovery_required`: stop. Do not click Pay, resume, or create another checkout — in this or any new browser session. Tell the user the outcome is unknown and ask them to check Link payment history or the merchant receipt. Continue only if the user confirms no payment was taken.
   - `expired`, `denied`, `failed`, `canceled`, `blocked`, `abandoned`: report the result to the user. A new checkout requires fresh user approval.

   After a terminal result, confirm the
   fill has completed and secret-bearing content is gone from every tab,
   including hidden fields, before calling `clearSecrets`. If that cannot be
   confirmed, do not clear or capture. Otherwise request a fresh `snapshot` of
   the merchant's confirmation or receipt page and tell the user what it shows.
   If blocked or abandoned, report that
   outcome instead. Use `action: "cancel"` if the user abandons before fill.

7. Only report the sanitized `last4` returned by the tool. Never expose or ask
   for any other payment credential.

This skill fires once at the payment step. A terminal checkout result rearms it
for a future purchase; it is not permission to retry a payment.
