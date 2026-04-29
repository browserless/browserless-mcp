# Modal Dialogs

The current snapshot contains an element with `role: dialog` or `role: alertdialog`. A modal is open — it almost certainly traps focus and intercepts clicks against the page behind it. Resolve it before continuing.

## Decide: is the modal what you want?

- **Yes** (login form, search overlay, item details) → interact with elements **inside** the dialog. Their refs are in the snapshot you already have.
- **No** (newsletter prompt, "you've got X% off!", interstitial) → close it, then re-snapshot.

## Closing the modal — try in this order

1. **Look for a close button in the snapshot.** Common names: `Close`, `Dismiss`, `×`, `No thanks`, `Maybe later`, `Continue without`. Click its `ref=` / `deep-ref=`.
2. **Look for an `aria-label="Close"` button** that may not have a visible name:

   ```json
   { "method": "click", "params": { "selector": "[aria-label='Close']" } }
   ```

3. **Send the Escape key** via evaluate — works for most well-built dialogs that listen for it:

   ```json
   { "method": "evaluate", "params": {
     "content": "(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()"
   }}
   ```

4. **Click the backdrop.** Many modals close on outside-click. The backdrop is usually a sibling or parent with a class containing `backdrop`, `overlay`, or `modal-mask`:

   ```json
   { "method": "click", "params": { "selector": ".modal-backdrop, [class*='overlay']:not([class*='inner'])" } }
   ```

5. **Re-snapshot** to confirm the dialog is gone before doing anything else.

## `alertdialog` (native-looking confirmations)

`role: alertdialog` is usually a critical confirmation ("Are you sure you want to delete?") — read it carefully. Don't auto-dismiss; the user almost never wants the destructive default. If the task requires confirming, look for the explicit affirmative button (`Confirm`, `Delete`, `Yes`) by its visible name.

## After closing

- The previous snapshot's refs **for elements behind the modal** are still valid — modals overlay rather than reflow the underlying DOM.
- However, any focused element / scroll position may have changed. If your next action is a `type` or `scroll`, it's worth re-snapshotting.

## Don't

- Don't try to remove the dialog via `evaluate` removing the DOM node. Many SPAs re-mount it on the next state change, and you'll have skipped any cleanup logic the close button runs.
- Don't proceed assuming the click landed on the page behind — modals capture pointer events. Always close first, then re-snapshot, then interact.
