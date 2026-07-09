---
name: get-trending-content
title: Xiaohongshu Trending Short Videos
description: >-
  Extract the currently-trending short-video posts from Xiaohongshu's explore
  feed (homefeed_recommend), returning each as a 1-line title plus author, like
  count, duration, and canonical URL. Read-only — no login, like, or follow.
website: xiaohongshu.com
category: social
tags:
  - xiaohongshu
  - rednote
  - trending
  - short-video
  - social
  - ssr
  - read-only
source: 'browserbase: agent-runtime 2026-05-21'
updated: '2026-05-21'
recommended_method: browser
alternative_methods:
  - method: fetch
    rationale: >-
      A plain HTTP GET to /explore (even with a residential proxy) returns the
      SSR shell with feeds:[] empty — the EdgeOne CDN gates the populated feed on
      a real-browser fingerprint. Do NOT use this path; drive a full
      browserless_agent browser session instead.
  - method: api
    rationale: >-
      POST /api/sns/web/v1/homefeed exists and works in-browser, but every call
      requires X-S / X-S-Common / X-t / x-rap-param headers signed by xhs-secsdk
      obfuscated JS. The algorithm rotates; not viable outside a real browser
      session.
verified: true
proxies: true
---

# Xiaohongshu Trending Short Videos

## Purpose

Return the currently-trending short-video posts on Xiaohongshu (小红书 / RedNote) as a list of 1-line descriptions plus structured metadata (author, like-count, duration, canonical URL). The data source is the `homefeed_recommend` channel — Xiaohongshu's algorithmic "for-you" feed served to logged-out visitors of `https://www.xiaohongshu.com/explore`, which is the platform's de-facto trending surface for unauthenticated traffic. Read-only — never click into a note, like, follow, comment, or attempt the login QR/SMS flow.

## When to Use

- "What's trending on Xiaohongshu right now?" / "Show me hot short-video posts."
- Daily / hourly snapshots of the explore feed for content-trend dashboards.
- Pre-screening trending videos by category (穿搭 / 美食 / 彩妆 / 影视 / 职场 / 情感 / 家居 / 游戏 / 旅行 / 健身) by switching the `category` slug.
- Anywhere you'd otherwise scrape rendered cards from `/explore`. The cards are noise; the underlying `window.__INITIAL_STATE__.feed.feeds[]` blob has everything in clean JSON.

## Workflow

The Xiaohongshu explore page is server-side-rendered with the first batch of feed items embedded inline in `window.__INITIAL_STATE__.feed.feeds[]`. **This is the cheap path** — one page-load gives you 20–30 ranked items (mix of `type: "video"` and `type: "normal"` (image)) with author, like count, video duration, and the `xsec_token` needed to construct canonical note URLs. **No homefeed API call is required and none is even fired during initial load** — the homefeed XHR only fires on scroll-to-load-more, and that request is signed (`X-S`, `X-S-Common`, `X-t`, `x-rap-param`) by Xiaohongshu's obfuscated `xhs-secsdk` bundle, so it's not callable from outside a real browser without re-implementing their signature scheme.

**Do NOT** issue a plain HTTP fetch against `/explore` and try to parse the result — the same URL served to a non-browser client returns the SSR shell with `feeds: []` empty (verified 2026-05-21: shell is 596 KB but `feed.feeds` is empty arrays). The SSR server gates the populated feed on a real-browser fingerprint. Use a full `browserless_agent` browser session with stealth + a residential `proxy`.

### Recommended path — SSR initial-state extraction

Keep the whole flow in **one** `browserless_agent` call — batching the steps saves round-trips and avoids accidentally dropping the session config. The session actually persists across separate calls, keyed by the call's `proxy`/`profile`, so there's no session to release; just repeat the same `proxy` on every call to stay in the same warmed browser (drop or change it and you land in a different, blank session). Set a residential proxy + stealth on the call — both are mandatory; a plain session renders the shell but the feed comes back empty (the EdgeOne edge gates by TLS/UA fingerprint):

```jsonc
// top-level browserless_agent arg
"proxy": { "proxy": "residential" }
```

1. **Open the explore page and let hydration settle.** The login QR-code modal opens automatically — it's an overlay only; the feed is rendered behind it and the SSR JSON is already in the DOM. You can ignore the modal entirely.

   ```jsonc
   // browserless_agent commands
   { "method": "goto", "params": { "url": "https://www.xiaohongshu.com/explore", "waitUntil": "load", "timeout": 45000 } },
   { "method": "waitForTimeout", "params": { "time": 3000 } }
   ```

2. **Read `window.__INITIAL_STATE__` and project the videos in-page.** The object is live in the page — no need to regex the HTML. Fold the filter + projection into a single `evaluate` and return a compact JSON array (never ship the raw 596 KB shell back). `noteCard.type === "video"` is the video filter (`"normal"` is an image-only post); `displayTitle` is the 1-line description we want.
   ```jsonc
   // browserless_agent command — returns under .value
   {
     "method": "evaluate",
     "params": {
       "content": "(() => { const feeds = (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.feed && window.__INITIAL_STATE__.feed.feeds) || []; const arr = (feeds.value || feeds); return JSON.stringify(arr.filter(f => f && f.noteCard && f.noteCard.type === 'video').map(f => ({ title: f.noteCard.displayTitle, author: (f.noteCard.user.nickname || f.noteCard.user.nickName), like_count: f.noteCard.interactInfo.likedCount, duration_seconds: (f.noteCard.video && f.noteCard.video.capa && f.noteCard.video.capa.duration), note_id: f.id, xsec_token: f.xsecToken, url: 'https://www.xiaohongshu.com/explore/' + f.id + '?xsec_token=' + f.xsecToken + '&xsec_source=pc_feed', note_type: 'video' }))); })()",
     },
   }
   ```
   Field notes preserved: `like_count` is a pre-formatted CN string (e.g. `"1.4万"`); `xsec_token` is mandatory in the canonical URL; coalesce `user.nickname || user.nickName`. (Xiaohongshu's Vue SSR may expose `feed.feeds` as a `{ value: [...] }` ref or a bare array — the `feeds.value || feeds` guard handles both.)

### Optional — category filter

To restrict the feed to a single category instead of the default homefeed_recommend mix, append `?channel_id={category}` to the URL. Observed category ids (from `state.channel.categories[]` on the same page load):

| `channel_id`                    | Category               |
| ------------------------------- | ---------------------- |
| `homefeed_recommend`            | 推荐 (default — mixed) |
| `homefeed.fashion_v3`           | 穿搭                   |
| `homefeed.food_v3`              | 美食                   |
| `homefeed.cosmetics_v3`         | 彩妆                   |
| `homefeed.movie_and_tv_v3`      | 影视                   |
| `homefeed.career_v3`            | 职场                   |
| `homefeed.love_v3`              | 情感                   |
| `homefeed.household_product_v3` | 家居                   |
| `homefeed.gaming_v3`            | 游戏                   |
| `homefeed.travel_v3`            | 旅行                   |
| `homefeed.fitness_v3`           | 健身                   |

There is **no** `homefeed.video_feed_v3` channel — all categories are mixed video+image, filter client-side on `noteCard.type === "video"`.

### Want more than 25 items? (Not recommended)

Each SSR load returns 20–30 ranked items. Subsequent items come from `POST https://edith.xiaohongshu.com/api/sns/web/v1/homefeed`, but every request must carry valid `X-S`, `X-S-Common`, `X-t`, and `x-rap-param` headers computed by Xiaohongshu's obfuscated client signature SDK. **Reproducing those headers outside the browser is not viable** — they rotate the algorithm regularly. If you genuinely need more than one SSR-page worth of items, drive the browser further in the same call: append `{ "method": "scroll", "params": { "direction": "down" } }` commands (repeat to load more batches) and the JS will fire the signed `homefeed` POST itself, then re-run the `evaluate` above to re-read `feed.feeds` from the updated in-page state (it's mutated in place).

## Site-Specific Gotchas

- **A plain HTTP fetch returns the empty SSR shell.** Same URL, same residential proxy, but the EdgeOne / Tencent CDN gates the populated feed on a real-browser fingerprint (TLS, UA, sec-ch-ua headers). Verified 2026-05-21: a non-browser fetch returned 596 KB of HTML with `"feeds":[]` in the initial state, while a `browserless_agent` browser session got the populated 25-item feed inline. **Always use a full browser session.**
- **Stealth + residential proxy is mandatory.** A plain (non-stealth, no-proxy) session loads `/explore` but the SSR-embedded feed is empty. Set `proxy: { proxy: "residential" }` and rely on `browserless_agent`'s stealth.
- **The login QR modal is cosmetic, not a wall.** It overlays the feed but the data is already in the DOM behind it. You do not need to dismiss it for extraction. Press `Escape` only if you want a clean screenshot.
- **`likedCount` is a pre-formatted Chinese-style string, not an integer.** Values like `"1.4万"` (14,000), `"9.2万"` (92,000), `"1185"`, `"2万"` (20,000). If you need a numeric value, parse: trim `"万"` and multiply by 10,000; `"亿"` × 100,000,000.
- **`displayTitle` may be truncated.** Cards show ~22 Chinese chars before truncation (the card is fixed-width). The SSR JSON does NOT contain a separate full-title field — `displayTitle` is what you get. For the full body text, you'd need to GET `/explore/{noteId}?xsec_token=…` and parse the note-detail page (out of scope for trending).
- **`xsec_token` is mandatory in the canonical URL.** Direct `/explore/{noteId}` without the token redirects to the explore root or returns a 404-like state. Always carry the `xsecToken` from the same SSR snapshot — tokens are scoped to the request session and may stop working after a few hours.
- **`noteCard.type` values observed:** `"video"` (short video, has `video.capa.duration` seconds) and `"normal"` (image post, no video block). No other types seen in the recommend feed. Default mix is roughly 50/50 video/image (verified iter-1: 12 video / 13 normal out of 25).
- **`user.nickname` vs `user.nickName`** — both fields exist on the same object and usually have the same value, but for some users only `nickName` is populated (camelCase) and for others only `nickname` (lowercase). Always coalesce: `user.nickname || user.nickName`.
- **The `feeds` array starts at SSR index 0** but Xiaohongshu marks individually-loaded items with `ssrRendered: true`. Items appended later by the signed homefeed XHR do not carry this flag — useful for telling "first paint" items apart from scroll-loaded items if you ever extend the skill.
- **No `homefeed.video_feed_v3` channel exists** despite plausible-looking task hints. Video isolation is client-side only. (The task prompt may suggest this URL — it returns the same mixed recommend feed.)
- **Direct calls to `POST /api/sns/web/v1/homefeed` are non-viable.** They require `X-S` / `X-S-Common` / `X-t` / `x-rap-param` signatures generated by `xhs-secsdk` / `mnscore` obfuscated JS. Don't waste time trying to reverse-engineer the signature scheme — it rotates. Use the browser path.
- **The `/website/hot-list` endpoint** (热搜 / hot search) is a different thing — it lists trending search **keywords**, not trending **videos**. Don't confuse it with this skill's surface.
- **Scrolling-triggered API calls return 204 first, then 200** — the 204 is the CORS preflight (OPTIONS), the 200 is the actual POST. Both must succeed for the in-browser scroll-to-load-more to populate the next batch.
- **Geographic accessibility:** Xiaohongshu is open globally without a CN-IP requirement (verified from US-region residential-proxy session, 2026-05-21). The login wall only blocks personalized features (search, follow, save) — public trending feed is anonymous-readable.

## Expected Output

```json
{
  "success": true,
  "source": "explore-ssr-initial-state",
  "channel": "homefeed_recommend",
  "fetched_at": "2026-05-21T23:02:30Z",
  "video_count": 12,
  "videos": [
    {
      "title": "李若彤｜好吃不胖更抗炎～再不为三餐发愁",
      "author": "李若彤",
      "like_count": "8664",
      "duration_seconds": 244,
      "note_id": "6453db04000000001300c1bb",
      "xsec_token": "ABmEUv4MbDhlwDICDI6NNR8RoC0SFuGxPHWnM2uq0iBuU=",
      "url": "https://www.xiaohongshu.com/explore/6453db04000000001300c1bb?xsec_token=ABmEUv4MbDhlwDICDI6NNR8RoC0SFuGxPHWnM2uq0iBuU=&xsec_source=pc_feed",
      "note_type": "video"
    },
    {
      "title": "新疆旅行vlog🍃是我梦里才会出现的场景啊",
      "author": "林森Live",
      "like_count": "1.4万",
      "duration_seconds": 286,
      "note_id": "6479822c0000000013002886",
      "xsec_token": "ABtkcQnFP-73URrNUeGSyeTRerpGI9UYTnt_w79xFVNqw=",
      "url": "https://www.xiaohongshu.com/explore/6479822c0000000013002886?xsec_token=ABtkcQnFP-73URrNUeGSyeTRerpGI9UYTnt_w79xFVNqw=&xsec_source=pc_feed",
      "note_type": "video"
    },
    {
      "title": "加油啊，宝………",
      "author": "鹿十元",
      "like_count": "9.2万",
      "duration_seconds": 287,
      "note_id": "644fb4db0000000007038e63",
      "xsec_token": "ABbpHsLUVDfzFGQhVGvLVuGtVX4bVBjsmPJILobMCubdg=",
      "url": "https://www.xiaohongshu.com/explore/644fb4db0000000007038e63?xsec_token=ABbpHsLUVDfzFGQhVGvLVuGtVX4bVBjsmPJILobMCubdg=&xsec_source=pc_feed",
      "note_type": "video"
    }
  ],
  "error_reasoning": null
}
```

Failure outcomes (less common — the SSR path is stable):

```json
// Stealth-less session: shell renders but feed is empty
{ "success": false, "videos": [], "error_reasoning": "SSR returned empty feeds[] — call is missing residential proxy/stealth or was fingerprinted as bot." }

// Non-browser fetch path: same symptom as above
{ "success": false, "videos": [], "error_reasoning": "plain HTTP fetch returns empty feed; must use a full browserless_agent browser session." }
```
