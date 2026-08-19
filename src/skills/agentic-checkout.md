# Agentic checkout with Stripe Link

Use this flow only when an authenticated shopping session has reached the
merchant's payment step. Do not type, request, reveal, or infer full card
numbers, security codes, passwords, or one-time codes.

1. Read the visible merchant name, merchant checkout URL, cart lines,
   quantities, and prices from the page. Keep every amount in integer USD minor
   units (cents) and verify the cart sum exactly matches `amount_minor`.
2. Call `browserless_link_connect` with `action: "status"`. If the wallet is
   not connected, stop and give the user the connection instruction. Do not
   bypass the Browserless account-owner connection flow.
3. Before initiating a purchase, state the merchant, items, and exact total and
   obtain the user's clear approval when it is not already explicit in the
   current request.
4. Call `browserless_link_checkout` exactly once with
   `{ merchant: { name, url }, amount_minor, currency: "usd", cart }`.
5. Treat `approval_url` as a handoff, not a completed purchase. Ask the user to
   open the Stripe-owned URL, follow `instruction` and `_next`, then wait for
   approval. Never claim success until a later checkout response confirms it.
6. Only report the sanitized `last4` returned by the tool. Never expose or ask
   for any other payment credential.

This skill fires once at the payment step. After the browser observes a payment
approval confirmation, it may surface again for the next checkout attempt.
