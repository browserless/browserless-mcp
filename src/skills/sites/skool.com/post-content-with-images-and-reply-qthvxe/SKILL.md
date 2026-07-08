---
name: post-content-with-images-and-reply
title: Skool Post Content with Images and Reply to Comments
description: >-
  Create a new post (with text + image attachments) in a Skool community feed,
  and reply to comments on existing posts. Authoring skill — requires the agent
  to be logged in AND a member of the target community.
website: skool.com
category: community
tags:
  - community
  - social
  - skool
  - posting
  - comments
  - authoring
source: 'browserbase: agent-runtime 2026-05-27'
updated: '2026-05-27'
recommended_method: browser
alternative_methods:
  - method: browser
    rationale: >-
      Only reliable surface. Skool exposes no public REST/GraphQL —
      api.skool.com returns 404 on every unauthenticated path and the real
      authoring endpoints rotate behind authenticated session cookies + CSRF
      tokens. Confirmed browser-only via CSP inspection (wss://*.skool.com for
      realtime, *.b-cdn.net/bunnycdn for media uploads).
verified: true
proxies: true
---

# Skool — Post Content with Images and Reply to Comments

## Purpose

Create a new post (with optional image/file attachments) in a Skool community feed, and reply to comments on existing posts. **Write-action skill** — by design this submits content. The agent driving this skill MUST already be authenticated and a member of the target community; without both, the composer modal and the reply textbox never render. Returns the URL of the newly published post and/or the new reply's parent comment context.

## When to Use

- "Publish an update with a screenshot to my Skool community."
- "Share an announcement with attached images in the {community-slug} community on Skool."
- "Reply to the comment by {user} on the {post-slug} post in {community-slug}."
- "Drop a comment on Sam Ovens' latest post in Skoolers."
- Any flow that authors text + image content inside a Skool group, OR participates in a comment thread under an existing Skool post.

Not for:

- Reading posts/comments only — Skool's post pages are publicly readable without auth (see Site-Specific Gotchas), so a read-only "fetch post" skill should not invoke this one.
- DMs / Skool Chat — that uses a separate Stream.io-backed surface, not the post composer.
- Classroom lessons, calendar events, courses — different composers, different skill.

## Workflow

Skool has no public REST/GraphQL surface for authoring (probed: `https://api.skool.com` → 404 on every unauthenticated path; the live app calls authenticated internal endpoints over `wss://*.skool.com` + REST under the same origin behind the user's session cookie, but those endpoints rotate, are not documented, and require a long-lived `PLAY_SESSION`/CSRF pair). **Browser-driven flow is the only reliable method.** Do not waste turns hunting for an unofficial API.

### 1. Run one authenticated session, end to end

Everything below runs inside a **single `browserless_agent` call** — pass the whole login → navigate → compose → publish (or → reply) flow as one `commands` array so cookies/session stay together across the steps and you never risk dropping the session config mid-flow. The session persists across calls (keyed by the call's `proxy`/`profile` config, so repeat the same config to reconnect to it); there is no session-release step to run afterward. Set `proxy: { proxy: "residential" }` (optionally `proxyCountry: "us"`) as a top-level arg on the call — Skool fronts pages with CloudFront + AWS WAF and bare datacenter IPs occasionally see `awswaf.com` interstitials referenced in the page CSP. The anti-bot posture is mild, so residential proxy is enough; no captcha solver is normally needed.

The session must carry the user's Skool cookies before it hits a community URL — a bare session lands every community URL on `/<community>/about` (the join paywall) and the composer never appears. Handle login inline as the first steps of the `commands` array:

- Load the `autonomous-login` skill first via `browserless_skill` and follow its gates — it drives the standard email/password flow for you.
- Navigate to `https://www.skool.com/login`, then `type` into the `Email` and `Password` textboxes and `click` `button: LOG IN`. Pull the credentials with `loadSecret` (never inline secrets into a `type` value or the agent context). Skool also exposes `button: Sign up for free` on the same page; do not click it for this skill.

Only log in if the user asked for an authoring action and Skool credentials are in scope.

### 2. Navigate to the target community feed

```json
{ "method": "goto", "params": { "url": "https://www.skool.com/<community-slug>", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 2500 } }
```

The `waitForTimeout` covers feed cards rendering progressively (never use `networkidle` on this SPA — it hangs).

URL shape: `https://www.skool.com/<community-slug>` — no trailing `/`. **If the page lands on `/<community-slug>/about` instead of staying on `/<community-slug>`, the user is not a member of that community.** Bail out with `reason: "not_a_member"` — the composer is structurally absent on the about page.

Verify the landing URL with an `{ "method": "evaluate", "params": { "content": "(()=>JSON.stringify({url:location.href}))()" } }`. The community sidebar tabs are: Community, Classroom, Calendar, Members, Map, Leaderboards, About. You want the default (Community) tab.

### 3. Open the composer modal — for posting a new post

Take a `{ "method": "snapshot" }` (a11y tree) and locate the `StaticText: Write something` placeholder. The parent `div` is the composer-trigger card; clicking it opens a centered modal dialog. Click the card, not the text node (confirm the selector via `snapshot` if the click misses).

```json
{ "method": "click", "params": { "selector": "<composer-trigger card, not the StaticText>" } },
{ "method": "waitForTimeout", "params": { "time": 1500 } },
{ "method": "snapshot" }
```

Inside the modal (verified against Skool's own how-to documentation):

| Field               | Selector hint                                                                                               | Required?                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Title               | First `textbox` in the dialog                                                                               | Yes                                                                             |
| Content (body)      | Larger `textbox` below title — rich-text editor                                                             | Yes (at least one of title/body must be non-empty in practice; both is safer)   |
| Media row buttons   | `button: Attachment` / `button: Link` / `button: Video` / `button: Poll` / `button: Emoji` / `button: GIF`  | No                                                                              |
| Category dropdown   | `combobox` near footer, label varies per community (e.g. "General Discussion", "Wins", "Questions", "Chat") | **Yes — post WILL NOT publish without one**                                     |
| Email-notify toggle | `switch: Send to all members`                                                                               | Optional, **OFF by default**, leave OFF unless explicitly told to email members |
| Submit              | `button: Post` (bottom-right of the modal)                                                                  | —                                                                               |

Fill order:

```json
{ "method": "type", "params": { "selector": "<title textbox>", "text": "<post title>" } },
{ "method": "press", "params": { "key": "Tab" } },
{ "method": "type", "params": { "selector": "<body contenteditable>", "text": "<post body text>" } }
```

Always drive the body with `type` — it's a contenteditable rich-text field, not a plain `<input>`. Typing directly into it is safe; avoid any fill-then-Enter shortcut, which can auto-submit fields it shouldn't. If the body selector is unstable, `press` `Tab` to move focus from the title into the body, then `type` with no explicit selector.

### 4. Attach images

The documented affordances under the composer are **Attachment / Link / Video / Poll / Emoji / GIF** — Skool does not have a separate "Image" button. Images go through the **Attachment** button as a file upload, OR you can drag-and-drop image files directly onto the composer body.

```json
{ "method": "click", "params": { "selector": "button: Attachment" } },
{ "method": "upload", "params": { "selector": "input[type=file]", "filePath": "/local/path/to/image.png" } },
{ "method": "waitForTimeout", "params": { "time": 3000 } }
```

Clicking Attachment opens the OS file picker, which the browser intercepts — target the file `input` with the `upload` command. The `waitForTimeout` covers thumbnail render + CDN upload to bunnycdn.

Images upload to Bunny CDN (the page CSP whitelists `*.b-cdn.net`/`*.bunnycdn.com`) — wait until the in-modal thumbnail finishes rendering before clicking Post, otherwise the post will publish without the image attached.

For multiple images: click Attachment again and upload more, or drag a multi-select onto the composer body in one drop.

### 5. Select a category and publish

```json
{ "method": "click", "params": { "selector": "<category combobox>" } },
{ "method": "waitForTimeout", "params": { "time": 800 } },
{ "method": "click", "params": { "selector": "menuitem: General Discussion (or your target category)" } },
{ "method": "click", "params": { "selector": "button: Post" } },
{ "method": "waitForTimeout", "params": { "time": 4000 } },
{ "method": "evaluate", "params": { "content": "(()=>JSON.stringify({url:location.href}))()" } }
```

The final `evaluate` reads `location.href` — it should be `https://www.skool.com/<community>/<auto-generated-slug>`.

The success signal: the URL changes from `/<community>` to `/<community>/<post-slug>`. If you stay on `/<community>` and the modal is still open, look for an inline validation message (typically "Please select a category" or "Title can't be empty").

### 6. Reply to a comment on an existing post

```json
{ "method": "goto", "params": { "url": "https://www.skool.com/<community-slug>/<post-slug>", "waitUntil": "load", "timeout": 45000 } },
{ "method": "waitForTimeout", "params": { "time": 2500 } },
{ "method": "snapshot" }
```

Each comment renders as a card with: author link, timestamp, comment body StaticText, a small icon row, and a `button: Reply` at the end. Nested replies appear indented under the parent comment with their own `button: Reply`.

Two reply patterns:

**(a) Top-level comment on the post:**

Locate `StaticText: Your comment` at the bottom of the comments section. Click its parent `div` (or the placeholder textbox directly), type, then either press Enter or click the submit affordance that appears once the textbox is non-empty.

```json
{ "method": "click", "params": { "selector": "<Your comment textbox / its parent div>" } },
{ "method": "waitForTimeout", "params": { "time": 500 } },
{ "method": "type", "params": { "selector": "<Your comment textbox>", "text": "<reply text>" } },
{ "method": "press", "params": { "key": "Enter" } },
{ "method": "waitForTimeout", "params": { "time": 2000 } }
```

If Enter doesn't submit, `click` the send button that materializes once the textbox is non-empty instead.

**(b) Reply nested under a specific comment:**

Find the target comment by author name + body snippet in the snapshot, then click that comment's `button: Reply`. An inline composer appears directly beneath it.

```json
{ "method": "click", "params": { "selector": "button: Reply (for that specific comment)" } },
{ "method": "waitForTimeout", "params": { "time": 500 } },
{ "method": "type", "params": { "selector": "<inline reply composer>", "text": "<reply text>" } },
{ "method": "press", "params": { "key": "Enter" } },
{ "method": "waitForTimeout", "params": { "time": 2000 } }
```

Verify with another `{ "method": "snapshot" }` — your new reply should be visible as a new comment card under the parent.

> **Session continuity:** There is no session-release step — nothing to release. Keep the entire login → navigate → compose → publish (or → reply) flow inside a single call's `commands` array to preserve cookies and session state across the steps and avoid dropping the session config. Across separate calls the session persists as long as you repeat the same `proxy`/`profile` config; a call that drops or changes it lands in a different, logged-out session.

## Site-Specific Gotchas

- **Authentication AND membership are both required to author.** `https://www.skool.com/<community>` redirects to `https://www.skool.com/<community>/about` when the viewing user is not a member of that community. On the `/about` page the "Write something" composer is structurally absent — no amount of clicking will surface it. Detect membership before attempting: read `location.href` via an `evaluate` after step 2; if it ends in `/about`, abort with `reason: "not_a_member"`.
- **Public posts are readable without auth.** Direct navigation to `https://www.skool.com/<community>/<post-slug>` renders the full post body and all comments to anonymous viewers (verified on `skool-monetization-strategies-2218/how-to-create-posts-in-your-skool-community-step-by-step` and `skool-scale-camp/commenting-vs-posting`). However the "Your comment" textbox at the bottom and the per-comment `Reply` buttons are no-ops for anonymous viewers — clicking them does nothing visible (no login modal pops). You MUST be logged in AND a member to interact.
- **Category is mandatory.** Skool will silently refuse to publish if no category is selected — there is no "default" category. Communities each define their own category list (e.g. joinskool has: All / 💬 Chat / ⭐ Groups / 💥 Skool News / 📖 SkoolMagazine / ▶️ The Skool Morning Show). Either let the caller pass `category: "General Discussion"` or surface the available options from the filter button row at the top of the feed BEFORE opening the composer, so you know which strings are valid.
- **Skool does not have a dedicated "Image" button on the composer.** The documented row is exactly `Attachment / Link / Video / Poll / Emoji / GIF` (sourced from a Skool user's how-to post on the platform). Image uploads go through **Attachment** (file picker) or drag-and-drop onto the composer body. The `Video` button is for video links (YouTube/Loom/Vimeo) and direct video uploads — don't use it for stills.
- **Image upload is asynchronous to Bunny CDN.** After picking files, wait at least 3 seconds for the thumbnail to render in the composer before clicking Post. If you submit too fast the post may publish with `imagePreview: ""` and the attachment lost. Confirm the thumbnail appears in the modal before submission.
- **"Send to all members" defaults OFF and should usually stay OFF.** Toggling it ON emails every community member about the new post. Per Skool's own community guidance: "Use email notifications strategically (1-2 times per week maximum, not for every post)." Only flip it when the caller explicitly asks for an email blast.
- **Use `type`, not a fill-and-submit shortcut, for the body.** The body is a contenteditable rich-text field, not a plain `<textarea>`. A fill-then-Enter approach may submit the form prematurely. Drive it with the `type` command (or `click` into the field first, then `type`).
- **Post URL pattern with optional comment-deep-link hash.** A bare post URL is `https://www.skool.com/<community>/<post-slug>`. Skool also produces `?p=<8-char-hex>` query suffixes when deep-linking into a specific comment (e.g. `https://www.skool.com/joinskool/welcome-to-join-skool?p=6dd91f8f`). Use the bare URL for navigation; the `?p=` form auto-scrolls to a specific comment if you want to verify your reply landed where expected.
- **No public API.** Probed `https://api.skool.com` → 404 (CloudFront origin returns plain `404 page not found`). The Next.js app at `www.skool.com/api/*` returns 404 on idle GET. The real authoring endpoints run under the session cookie and the page CSP whitelists `wss://*.skool.com` for real-time updates. **Don't waste time trying to reverse-engineer a REST surface — there isn't a stable one.**
- **`/<community>/api`** is not an API — it's a community-slug route. Skool's slug router catches everything after `/` as a potential community name first.
- **Anti-bot posture is mild.** Skool is fronted by AWS WAF + CloudFront. A `browserless_agent` call with `proxy: { proxy: "residential" }` sails through; bare datacenter IPs occasionally see a WAF challenge but it's not Akamai-level. Residential proxy is recommended, not strictly mandatory for read; a captcha `solve` command is normally unnecessary here.
- **The "Filter" / category-pill row on the feed is for browsing, not for posting.** The pill row near the top (e.g. "All / 💬 Chat / ⭐ Groups …") filters the feed in place. Clicking one of these BEFORE opening the composer does NOT pre-select that category in the new-post modal — you still need to pick the category inside the modal itself.
- **Composer click target is the parent `div`, not the `StaticText`.** Snapshots show `StaticText: Write something` nested inside a clickable card. Click the card (a `div` ~2-3 levels up the tree), not the text node, or the modal may not open in headless modes.

## Expected Output

Two outcome shapes — one for new-post, one for reply.

```json
// New post — success
{
  "success": true,
  "action": "post",
  "community": "joinskool",
  "post_url": "https://www.skool.com/joinskool/my-new-post-title",
  "post_slug": "my-new-post-title",
  "title": "My New Post Title",
  "category": "General Discussion",
  "attachments_count": 2,
  "email_notification_sent": false
}

// Reply — success
{
  "success": true,
  "action": "reply",
  "community": "joinskool",
  "post_url": "https://www.skool.com/joinskool/welcome-to-join-skool",
  "parent_comment_author": "Mindy Molein",
  "parent_comment_snippet": "Hi all! I am going through the trainings…",
  "reply_body": "Welcome! My favorite part is…",
  "nesting_level": 1
}

// Not a member — bail before authoring
{
  "success": false,
  "reason": "not_a_member",
  "community": "skoolers",
  "landed_url": "https://www.skool.com/skoolers/about",
  "note": "Composer is structurally absent on /about. User must join group first."
}

// Not authenticated — login wall
{
  "success": false,
  "reason": "not_authenticated",
  "note": "Session has no Skool cookies. Run login automation or replay a saved context first."
}

// Category missing — Skool refused to publish
{
  "success": false,
  "reason": "category_required",
  "available_categories": ["💬 Chat", "⭐ Groups", "💥 Skool News", "📖 SkoolMagazine"],
  "note": "Modal stayed open after clicking Post. Category dropdown is mandatory."
}

// Image upload didn't finish before submit
{
  "success": false,
  "reason": "attachment_upload_incomplete",
  "post_url": "https://www.skool.com/joinskool/my-new-post-title",
  "note": "Post published but imagePreview is empty. Wait ≥3s after file pick for Bunny CDN thumbnail before clicking Post."
}
```
