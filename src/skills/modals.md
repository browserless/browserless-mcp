# Modal Dialogs

Snapshot shows `role: dialog` or `role: alertdialog` — modal is open, traps focus/clicks.

## Strategy

**Want to interact with it?** → Use element refs from current snapshot.  
**Want it gone?** → Close it, then re-snapshot.

## Closing (try in order)

1. **Close button in snapshot** — `Close`, `×`, `Dismiss`, `No thanks`, etc. Click its ref.

2. **Aria-labeled close:**

   ```json
   { "method": "click", "params": { "selector": "[aria-label='Close']" } }
   ```

<!-- compliant-omit -->

3. **Escape key:**

   ```json
   {
     "method": "evaluate",
     "params": {
       "content": "(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()"
     }
   }
   ```

   <!-- /compliant-omit -->

4. **Click backdrop:**

   ```json
   {
     "method": "click",
     "params": {
       "selector": ".modal-backdrop, [class*='overlay']:not([class*='inner'])"
     }
   }
   ```

5. **Re-snapshot** to confirm gone.

## alertdialog

Critical confirmations ("Delete?"). Don't auto-dismiss. Find explicit button (`Confirm`, `Delete`, `Yes`) if task requires it.

## After closing

- Refs behind modal still valid (overlay, not reflow)
- Focus/scroll may have shifted — re-snapshot before type/scroll actions

## Avoid

<!-- compliant-omit -->

- Removing modal DOM via evaluate (SPAs remount it)
<!-- /compliant-omit -->
- Interacting with page behind without closing first (pointer events captured)
