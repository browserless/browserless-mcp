---
name: login-and-view-saved-jobs
title: HiringCafe Log In & Saved Jobs
description: >-
  Log into HiringCafe and open the user's Saved Jobs page (the HiringCafe
  Application Tracker at /myhiringcafe/tracker). Documents the email/password
  and Google/Microsoft/Facebook/GitHub OAuth login surface and the account-gated
  tracker.
website: hiring.cafe
category: job-search
tags:
  - job-search
  - login
  - authentication
  - saved-jobs
  - hiringcafe
  - cloudflare
source: 'browserbase: agent-runtime 2026-06-09'
updated: '2026-06-09'
recommended_method: browser
alternative_methods:
  - method: browser
    rationale: >-
      Saved jobs are tied to a logged-in account; no public/unauthenticated API
      or deep-link returns them. The browser login flow (email/password or
      OAuth) followed by /myhiringcafe/tracker is the only reliable surface.
verified: false
proxies: false
---

# HiringCafe — Log In and Open Saved Jobs

## Purpose

Log a user into HiringCafe and open their **Saved Jobs** page — branded the "HiringCafe Application Tracker" — at `https://hiring.cafe/myhiringcafe/tracker`. The page is account-gated: logged out it shows an empty "Log in to view" state; logged in it lists the jobs the user has saved/tracked. This skill drives the browser login flow and lands on the tracker. It is read-only with respect to job data (it views saved jobs; it does not apply, delete, or modify them) but it does perform an authentication action with user-supplied credentials.

## When to Use

- "Log into HiringCafe and show me my saved jobs / application tracker."
- A job-search agent that needs the user's saved/bookmarked HiringCafe roles before comparing or acting on them.
- Resuming a HiringCafe session to check tracked-application status.
- Any flow that must reach `hiring.cafe/myhiringcafe/tracker` in an authenticated state.

## Workflow

This is a browser task. There is **no public API or unauthenticated shortcut** for saved jobs — the tracker is tied to a logged-in account, so credentials (email/password or a federated OAuth account) must be supplied by the user. The optimal path is to deep-link straight to the tracker URL, then satisfy the login wall.

Because this performs an authentication action, **load the `autonomous-login` skill first** (via `browserless_skill`) and follow its gates: only log in when the user explicitly asked and credentials are in scope. Pull vault credentials with **`loadSecret`** and feed them into the `type` command's value — **never paste raw secrets into the `type` params or the call context**; use plain `type` values only for non-secret inputs. Keep the whole flow (nav → detect → login → nav → snapshot) inside **one `browserless_agent` call's `commands` array** so the session cookies persist across steps — there is no separate session to open or release.

1. **Deep-link to the tracker and snapshot.** Start bare (no proxy — see Gotchas), then read the auth gate:

   ```json
   { "method": "goto", "params": { "url": "https://hiring.cafe/myhiringcafe/tracker", "waitUntil": "load", "timeout": 45000 } }
   { "method": "snapshot" }
   ```

2. **Detect auth state from the snapshot.**
   - If you see the heading **"Your saved jobs will appear here"** and a **"Log in to view"** button → you are **logged out**, proceed to step 3.
   - If you see a list of saved/tracked job cards → already authenticated, skip to step 5.

3. **Open the login surface.** Click **"Log in to view"** (it routes to `https://hiring.cafe/auth`). Equivalent entry points: the yellow **"Sign up"** button in the top bar, or the top-right account menu (hamburger/avatar) → **"Saved jobs"**. You can also navigate directly:

   ```json
   {
     "method": "goto",
     "params": {
       "url": "https://hiring.cafe/auth",
       "waitUntil": "load",
       "timeout": 45000
     }
   }
   ```

4. **Authenticate with the user's chosen method.** The form titled "Welcome to HiringCafe" offers:
   - **Email + password**: `type` the email into the `Email` textbox, `type` the password into the `Password` textbox, then `click` the single pink **"Continue"** button. (One button handles both login and signup — it routes a known email to login.)
     ```json
     { "method": "type", "params": { "selector": "input[type=email]", "text": "<email>" } }
     { "method": "type", "params": { "selector": "input[type=password]", "text": "<password-from-loadSecret>" } }
     { "method": "click", "params": { "selector": "button:has-text('Continue')" } }
     ```
     Prefer discrete `type` + `type` + `click` (populate both fields, _then_ submit) over any single fill-and-submit shortcut, so you never trigger the Continue button before both fields hold a value. Confirm the field/button selectors via `snapshot` if they miss.
   - **OAuth**: "Continue with Google", "Continue with Microsoft", "Continue with Facebook", or "Continue with GitHub". These open the provider's own login (a separate popup/redirect flow with its own credentials/consent).

5. **Land on the tracker.** After authentication, navigate (or return) to the saved-jobs page and snapshot it — still within the same call's `commands`:
   ```json
   { "method": "goto", "params": { "url": "https://hiring.cafe/myhiringcafe/tracker", "waitUntil": "load", "timeout": 45000 } }
   { "method": "waitForTimeout", "params": { "time": 2000 } }
   { "method": "snapshot" }
   ```
   Extract the saved/tracked job entries (title, company, location, status/column) from the rendered tracker. Do not apply to or remove any job.

## Site-Specific Gotchas

- **Saved Jobs == "Application Tracker".** The feature is branded "HiringCafe Application Tracker" and lives at the non-obvious URL `https://hiring.cafe/myhiringcafe/tracker` (note the `myhiringcafe` segment). There is no `/saved` or `/bookmarks` route.
- **Auth is mandatory and there is no API bypass.** Saved jobs are tied to a logged-in account. No public/unauthenticated endpoint returns them. The user must supply credentials.
- **Single combined "Continue" button.** The email/password form has no separate "Log in" vs "Sign up" toggle — one **Continue** button handles both, branching on whether the email already has an account. Submitting an unknown email will start account creation, not error out — make sure you use the correct existing account email.
- **Four OAuth providers.** Google, Microsoft, Facebook, GitHub. OAuth flows redirect/popup to the provider and require that provider's credentials + consent; they are outside HiringCafe's DOM. Prefer email/password when the user provides it.
- **Cloudflare is present but lenient.** The site is a Next.js app fronted by Cloudflare in `DYNAMIC`/non-challenge mode. In testing, a **bare `browserless_agent` session (no `proxy` arg) loaded both the tracker page and the login form without any challenge.** Residential proxies were not required for navigation. (A pre-run probe flagged `likelyNeedsProxies: true`, but that did not bear out for these routes — start bare, and only escalate to `proxy: { proxy: "residential" }` on the call if you actually hit a Cloudflare interstitial or 403. If a Turnstile/Cloudflare challenge does appear, add a `{ "method": "solve", "params": { "type": "cloudflare" } }` command.)
- **Logged-out tracker is a clean empty state, not a redirect.** `/myhiringcafe/tracker` renders the page with a "Log in to view" CTA rather than bouncing you to `/auth`. Don't mistake the empty state for "no saved jobs" — check for the login button first.
- **`/auth` is the dedicated login route.** Clicking "Log in to view" / "Sign up" navigates here; you can also open it directly to skip the empty-state page.
- **AUTHENTICATED VIEW UNVERIFIED.** This skill was built without login credentials, so the post-login tracker layout (column/status structure, per-card fields) was **not directly observed** — only the logged-out gate and the login surface were confirmed. The authenticated `Expected Output` shape below is inferred. Treat field names as best-effort and re-snapshot once logged in.

## Expected Output

```json
// Logged-out gate reached (confirmed shape)
{
  "success": true,
  "saved_jobs_url": "https://hiring.cafe/myhiringcafe/tracker",
  "authenticated": false,
  "auth_required": true,
  "login_url": "https://hiring.cafe/auth",
  "login_methods": [
    "email_password",
    "google",
    "microsoft",
    "facebook",
    "github"
  ],
  "logged_out_state": "Your saved jobs will appear here / Log in to view",
  "saved_jobs": []
}
```

```json
// Authenticated tracker reached (inferred shape — re-verify field names live)
{
  "success": true,
  "saved_jobs_url": "https://hiring.cafe/myhiringcafe/tracker",
  "authenticated": true,
  "auth_required": true,
  "saved_jobs": [
    {
      "title": "Senior Software Engineer",
      "company": "Example Co",
      "location": "Remote · United States",
      "status": "Saved",
      "url": "https://hiring.cafe/..."
    }
  ],
  "count": 1
}
```

```json
// Authenticated but no jobs saved yet
{
  "success": true,
  "saved_jobs_url": "https://hiring.cafe/myhiringcafe/tracker",
  "authenticated": true,
  "auth_required": true,
  "saved_jobs": [],
  "count": 0
}
```
