---
name: search-wholesale
title: 1688.com Wholesale Product Search
description: >-
  Search 1688.com (Alibaba's China-domestic wholesale platform) by keyword and
  return structured offers — title, CNY wholesale price, MOQ, supplier name +
  location, recent-transaction count, and canonical offer URL. Supports
  price-range, supplier-province, and sort filters. Headed browsers are
  hard-blocked at IP level (cloud_ip_bl); the recommended path is the mtop JSON
  API at h5api.m.1688.com with md5-signed requests.
website: 1688.com
category: wholesale
tags:
  - wholesale
  - '1688'
  - alibaba
  - china
  - sourcing
  - mtop
  - read-only
source: 'browserbase: agent-runtime 2026-05-20'
updated: '2026-05-20'
recommended_method: api
alternative_methods:
  - method: browser
    rationale: >-
      Not viable from a cloud browser IP. Every navigation to s.1688.com /
      m.1688.com / detail.1688.com over a cloud IP — verified across
      stealth+residential-proxy, stealth alone, and residential-proxy alone — is
      hard-redirected to bixi.alicdn.com/punish with action=deny and cloud_ip_bl
      tag. No captcha to solve. Browser fallback is documented for runtimes that
      have access to a genuine residential egress, but agents running on a cloud
      browser pool cannot use it.
  - method: hybrid
    rationale: >-
      Useful when you already have a Browserbase session warmed: navigate to
      https://h5.m.1688.com/ (the only un-punished *.1688.com origin reachable
      from Browserbase) and run the signed-mtop fetch from that page context.
      document.cookie is visible there, so the _m_h5_tk bootstrap + signed call
      work in one async IIFE.
verified: true
proxies: true
---

# 1688.com Wholesale Product Search

## Purpose

Given a keyword (Chinese strongly preferred; English works but returns sparser hits because 1688's corpus is Mandarin), return the first page of wholesale offers from `s.1688.com` — title, lowest-tier wholesale price in CNY, MOQ + unit, supplier company name, supplier `<province> <city>` location, recent-transaction count, and the canonical `detail.1688.com/offer/{offerId}.html` URL. Supports the platform's price-range, supplier-region (`province=`), and sort-order filters. **Read-only** — never click `加入进货车` / `立即下单` / contact-supplier buttons.

## When to Use

- Sourcing-research agents comparing wholesale prices for the same SKU across multiple suppliers.
- China-domestic-procurement workflows enriching a BOM with current CNY wholesale costs and MOQs.
- Cross-checking Alibaba.com (English-export) prices against 1688.com (China-domestic) prices for the same supplier — the same supplier company is often listed on both at very different unit prices.
- Anywhere a workflow needs structured product metadata from 1688 search results without booking, contacting, or transacting.

## Workflow

1688's PC search page (`s.1688.com/selloffer/offer_search.htm`) is a thin React shell that hydrates from a single `mtop` JSON call to `h5api.m.1688.com`. **Headed browsers cannot reach the search UI** — cloud/datacenter browser IPs (Browserless and Browserbase alike, data-center and residential-proxy) are on Alibaba's `cloud_ip_bl` blocklist and get terminal-action `deny` redirects to `bixi.alicdn.com/punish/...` with no captcha to solve (see Site-Specific Gotchas). The only working path is calling the mtop endpoint directly with a proper md5 sign — that endpoint is _not_ punished and accepts requests from a `browserless_function` / `browserless_agent` session sitting on the un-punished `h5.m.1688.com` origin (see "How to actually execute").

### Recommended path — mtop API (signed)

The same JSON endpoint that the PC search shell fires after mount. Method: `mtop.relationrecommend.WirelessRecommend.recommend`, with `appId='32517'` (PC offer search) and a stringified `params` object carrying the search parameters.

**Step 1 — Bootstrap the `_m_h5_tk` token.** Call the endpoint once with a dummy `sign` to get back `Set-Cookie: _m_h5_tk=<token>_<expiry-ms>` and `_m_h5_tk_enc=...`. The body returns `FAIL_SYS_TOKEN_EMPTY::令牌为空` — that's expected; you only care about the cookies.

```
GET https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/
    ?jsv=2.5.1
    &appKey=12574478
    &t=<ms-epoch>
    &sign=x
    &api=mtop.relationrecommend.WirelessRecommend.recommend
    &v=2.0
    &data=%7B%7D
```

**Step 2 — Compute the sign for the real call.**

```
token  = <part before "_" in the _m_h5_tk cookie>
t      = <fresh ms-epoch>
appKey = "12574478"
data   = JSON.stringify({
  "appId": "32517",
  "params": JSON.stringify({
    "keywords":             "<UTF-8 keyword>",
    "beginPage":            1,
    "pageSize":             20,         // observed range 10–60
    "method":               "getOfferList",
    "verticalProductFlag":  "pcmarket",
    "searchScene":          "pcOfferSearch",
    "charset":              "GBK",
    // --- optional filter fields, omit if unused ---
    "priceStart":           "<min CNY>",     // string, e.g. "1.5"
    "priceEnd":             "<max CNY>",     // string, e.g. "20"
    "province":             "<中文省份>",    // e.g. "广东", "浙江"
    "sortType":             "<sort>"         // see table below
  })
})
sign   = md5(token + "&" + t + "&" + appKey + "&" + data)   // lowercase hex
```

Sort values verified from page traffic:

| `sortType`     | Meaning                          |
| -------------- | -------------------------------- |
| `""` / omitted | Popularity / relevance (default) |
| `"price-asc"`  | Wholesale price ↑                |
| `"price-desc"` | Wholesale price ↓                |
| `"booked"`     | Transaction count (30-day) ↓     |
| `"newOffer"`   | Newest first                     |

**Step 3 — Make the signed call** with both `_m_h5_tk` and `_m_h5_tk_enc` cookies in `Cookie:`:

```
GET https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/
    ?jsv=2.5.1
    &appKey=12574478
    &t=<t from sign>
    &sign=<md5 from sign step>
    &api=mtop.relationrecommend.WirelessRecommend.recommend
    &v=2.0
    &data=<URL-encoded data from sign step>
Cookie: _m_h5_tk=<full>; _m_h5_tk_enc=<full>
```

Response is JSON with `ret: ["SUCCESS::调用成功"]` and `data.data.offerList[]` (wrapped — the `params` is parsed by the recommend service and the `getOfferList` response is returned inline). Top-level errors are returned in `ret[0]` as `FAIL_<X>::<message>`.

**Step 4 — Decode each offer.** Per-offer fields (observed key set on `data.data.offerList[i]`):

| Skill output field  | mtop path                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `title`             | `subject` (sometimes `title`) — strip newlines and HTML highlight tags `<font>`                                              |
| `price_cny`         | `priceInfo.price` (string CNY) or lowest of `priceInfo.priceRange[]`                                                         |
| `moq`               | `tradeInfo.moq` (or `tradeInfo.minOrderQuantity`) + `tradeInfo.unit` (件/箱/双/kg/米)                                        |
| `supplier_name`     | `company.name` (Chinese, usually ends `有限公司`)                                                                            |
| `supplier_location` | `company.province` + " " + `company.city` (or `address` for the joined string)                                               |
| `transaction_count` | `tradeInfo.tradeNumber` (raw int — "近30天成交X件") or `monthSold`                                                           |
| `url`               | `https://detail.1688.com/offer/${offerId}.html` (offerId = `id` or `offerId` field)                                          |
| `is_certified`      | `feMapping.memberTagIds.isShiliDangKou` (实力商家) OR `marketOfferTag.isShiliDangKou` OR `company.tagIds` contains `3910593` |

Field shapes may vary slightly across the AB-test buckets 1688 routes through; iterate the live response keys defensively rather than assuming the strict map above.

**Step 5 — Total result count + pagination.** `data.data.totalCount` (integer). To paginate, repeat steps 2–4 with `beginPage: 2,3,...`. Page-size hard cap appears to be 60.

### How to actually execute the protocol

> **Runtime constraint (verified):** the `browserless_function` sandbox runs in a **browser page context**, not Node — there is no `process` and `import 'node:crypto'` fails. WebCrypto has no MD5. So the md5 `sign` **must** be produced in-page, either by injecting a tiny md5 lib or inlining one. That makes `browserless_agent` (below) the natural primary; a `browserless_function` works too but only with the same in-page md5 (via `page.evaluate`), not `node:crypto`.

**Primary — `browserless_agent` (single-call IIFE).** Land on the un-punished `h5.m.1688.com` origin, then run the whole bootstrap → sign → call inside one `evaluate`. The sign happens in-browser, so inject blueimp-md5 first (if `h5.m.1688.com`'s CSP blocks the external `<script>`, paste a pure-JS md5 into the IIFE instead). `proxy` is optional for the mtop host (it isn't punished) but include it if the `h5.m.1688.com` nav gets walled from a datacenter IP:

```jsonc
{
  "rationale": "1688 signed mtop offer search",
  "proxy": { "proxy": "residential" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://h5.m.1688.com/",
        "waitUntil": "domcontentloaded",
        "timeout": 45000,
      },
    },
    {
      "method": "evaluate",
      "params": {
        "content": "(async()=>{await new Promise((res,rej)=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/blueimp-md5@2.19.0/js/md5.min.js';s.onload=res;s.onerror=rej;document.head.appendChild(s);});const appKey='12574478';await fetch('https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/?jsv=2.5.1&appKey='+appKey+'&t='+Date.now()+'&sign=x&api=mtop.relationrecommend.WirelessRecommend.recommend&v=2.0&data=%7B%7D',{credentials:'include'});await new Promise(r=>setTimeout(r,300));const token=document.cookie.match(/_m_h5_tk=([^;]+)/)[1].split('_')[0];const t=Date.now();const params=JSON.stringify({keywords:'手机壳',beginPage:1,pageSize:20,method:'getOfferList',verticalProductFlag:'pcmarket',searchScene:'pcOfferSearch',charset:'GBK'});const data=JSON.stringify({appId:'32517',params});const sign=md5(token+'&'+t+'&'+appKey+'&'+data);const u='https://h5api.m.1688.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/?jsv=2.5.1&appKey='+appKey+'&t='+t+'&sign='+sign+'&api=mtop.relationrecommend.WirelessRecommend.recommend&v=2.0&data='+encodeURIComponent(data);return JSON.stringify(await (await fetch(u,{credentials:'include'})).json());})()",
      },
    },
  ],
}
```

Everything must stay in **one** `evaluate` (bootstrap → sign → call). Splitting across calls can park the active target back to `about:blank` — a different, sandboxed origin — and `document.cookie` for `h5.m.1688.com` is then invisible (`Access is denied`).

**Out-of-band alt.** From any runtime with a residential egress you can skip Browserless entirely: an HTTP client with a cookie jar persisting `_m_h5_tk` + `_m_h5_tk_enc`, `Referer: https://www.1688.com/` and `Origin: https://www.1688.com`, doing the same token-then-signed-call dance. Browserless is only needed for the cookie-bound origin + clean egress.

### Browser fallback

There is **no working browser fallback today** from a cloud browser IP (Browserless or Browserbase). Every navigation to `s.1688.com`, `m.1688.com`, or `detail.1688.com` returns the `bixi.alicdn.com/punish/...&action=deny&qrcode=...&cloud_ip_bl` page — a _terminal_ block, not a captcha (no slider, no checkbox, no rotating image — the action verb is `deny`, not `verify`), so the `solve` command cannot help. A user running this from a clean residential network _can_ drive the search UI normally; a cloud session cannot. If your runtime has a genuine residential egress, the conventional browser path (via `browserless_agent` with that proxy) is:

1. `goto` `https://s.1688.com/selloffer/offer_search.htm?keywords=<urlencoded>&priceStart=<min>&priceEnd=<max>&province=<urlencoded-中文>&sortType=<sort>` (waitUntil:load).
2. `waitForTimeout` ~3000 ms (the `offerresultData` block populates after a follow-up XHR fires `mtop.relationrecommend.WirelessRecommend.recommend` with `appId=32517` — same call as the API path).
3. `evaluate` `"(()=>JSON.stringify(window.data?.offerresultData?.offerList||[]))()"` to grab the hydrated state without parsing the rendered grid.
4. Per-card extraction via the same `offerList[i]` schema above.

In practice this whole path is dead from a cloud IP — use the signed-mtop `browserless_function` above, which hits the un-punished `h5api` host instead.

## Site-Specific Gotchas

- **Cloud browser IPs are on Alibaba's `cloud_ip_bl` blocklist — confirmed for headed browsers, all stealth/proxy combinations.** Verified 2026-05-20 across stealth-only, residential-proxy-only, and stealth+proxy. Every navigation to `s.1688.com / m.1688.com / detail.1688.com / www.alibaba.com` lands on `bixi.alicdn.com/punish/punish:resource:template:cbuSpace:default_38604715.html?...&cloud_ip_bl|0&action=deny`. The `action=deny` is **terminal** — there is no captcha, slider, or verify flow, so `solve` cannot help. Alibaba.com over a datacenter proxy returns the Akamai `Bxpunish: 1` headered HTML loading `sufei-punish/0.1.122/build/main.css` — same block, different CDN. _Do not waste iterations trying to drive the search UI from a cloud session (Browserless or Browserbase); go straight to the signed mtop path._
- **`h5api.m.1688.com` is NOT punished — this is the load-bearing exception.** The mtop JSON host is on a separate infra path from the HTML edges and accepts cloud-IP traffic (Browserless/Browserbase). Verified originally with a plain fetch (returned `ret:["FAIL_SYS_TOKEN_EMPTY"]` after issuing `_m_h5_tk`) and page-context `fetch()` from a session on `h5.m.1688.com` — the same two-step the `browserless_function` performs.
- **`h5.m.1688.com` is the only `*.1688.com` origin reachable from Browserbase.** `h5.m.1688.com/` itself 302-redirects to `h5.m.1688.com/wingdev/notfound.html` ("页面不存在" / page-not-found shell) but the navigation completes cleanly — no punish redirect. Use it as the JS execution origin for cookie-jar-bound mtop calls. `h5.m.1688.com/page/offerlist.html` returns its own 404 too. There is no productive UI here; the value is the un-punished same-origin context.
- **A plain fetch of `s.1688.com/selloffer/offer_search.htm` returns 200 OK shell HTML with NO offer data.** All product rows are hydrated client-side from the mtop call. Searching the shell for `offerresultData`, `offerList`, `totalCount`, `getOfferList` finds _string references_ in JS code — never the actual array. The shell is useful only for sniffing `appKey`, `appId`, and the method name; it's not a viable extraction surface.
- **The signed call needs a real cookie jar — the sign is bound to the `_m_h5_tk` cookie.** Without sending that cookie back on the signed request you get `FAIL_SYS_ILLEGAL_ACCESS::非法请求`. That is why the call must run in page context (`page.evaluate`/`evaluate` with `credentials:'include'`) on the `h5.m.1688.com` origin, or from an out-of-band HTTP client with a cookie jar — a headerless one-shot fetch that can't attach `Cookie:` fails.
- **Keep the whole protocol in one round-trip.** bootstrap-token → sign → call must be a single `evaluate` (agent) or a single `page.evaluate` chain (function); splitting across separate tool calls can park the active target back to `about:blank` (a sandboxed origin) so `document.cookie` for `h5.m.1688.com` becomes invisible (`Access is denied`). Project the offer list down to the output-schema fields **inside** that eval and return only the summary JSON — the raw payload is ~50–200 KB and the `evaluate`/function text return is capped.
- **Token has a ~5400s lifetime** (`Max-Age=5400` on `Set-Cookie`). One token issuance covers up to ~90 minutes of search calls. Cache `_m_h5_tk` + `_m_h5_tk_enc` and only re-bootstrap when the next signed call returns `FAIL_SYS_TOKEN_EMPTY` or `FAIL_SYS_TOKEN_EXOIRED`/`FAIL_SYS_ILLEGAL_ACCESS`.
- **`charset: "GBK"` is correct even though the JSON body is UTF-8.** This is a 1688 quirk — the PC search service tags the result-set ranking pipeline with GBK because legacy Chinese consumers run on GBK pages. Sending `"UTF-8"` returns 200 but with degraded relevance. Mirror the value the PC shell sends.
- **`appId="32517"` is PC offer search; mobile offer search uses a different `appId`.** Inferred from the in-page constant `requestCode: 32517_search_offer_getOfferList`. Don't change it unless you've verified an alternative against live traffic.
- **`appKey="12574478"` is the H5 PC token-issuing app key.** Mobile h5 web pages use the same `appKey`. Confirmed by both reading the page shell and reproducing the token-issue handshake (token returned, cookies set as expected).
- **English keywords work but return junky results.** 1688's corpus is Chinese. "phone case" returns ~10 results; `手机壳` returns ~1.2M. Always machine-translate the user's English keyword to Chinese before searching (`OpenAI: translate the search term to simplified Mandarin retail-product naming convention, return only the term`), keep the original as a fallback if the Chinese hits 0.
- **Province filter expects the Chinese two-character form, not pinyin.** `province=广东` ✓, `province=guangdong` returns no province scoping. URL-encode UTF-8 bytes when passing through query strings (`%E5%B9%BF%E4%B8%9C` for `广东`).
- **`priceStart` / `priceEnd` are strings, not numbers, and represent CNY.** Sub-yuan values are valid (`"0.5"`). When `priceEnd` is omitted, no upper bound is applied.
- **The recommend wrapper returns nested status.** `ret[0]` is the outer mtop status (`SUCCESS::调用成功` even when the inner `params.method=getOfferList` returns 0 results). To distinguish "API succeeded but 0 hits" from "API call failed", check `data.data.totalCount` and `data.data.offerList.length`. An empty offer list with `totalCount: 0` is a valid empty result; `ret[0]` starting with `FAIL_` is a transport failure.
- **Network tracing is useless on a walled nav.** When the session is immediately punished, a CDP/network trace captures only `Page.frameAttached`/`Page.lifecycleEvent` and no `Network.responseReceived` for the target — the punish redirect fires before observers attach. For debugging a wall, take a `screenshot` of the landed URL instead. (Not that you need tracing on the working path — the mtop JSON is the whole response.)
- **DNS may not resolve `*.1688.com` locally.** In restricted-DNS environments a local `curl` fails with `Could not resolve host` for `s.1688.com` / `h5api.m.1688.com`. Running the fetch inside `browserless_function` (or a `browserless_agent` page) resolves them via Browserless's egress — another reason to execute the protocol through Browserless rather than a local client.

## Expected Output

Three distinct outcome shapes:

**Success:**

```json
{
  "success": true,
  "keyword": "手机壳",
  "filters_applied": {
    "priceStart": "1.0",
    "priceEnd": "20",
    "province": "广东",
    "sortType": "booked"
  },
  "search_url": "https://s.1688.com/selloffer/offer_search.htm?keywords=%E6%89%8B%E6%9C%BA%E5%A3%B3&priceStart=1.0&priceEnd=20&province=%E5%B9%BF%E4%B8%9C&sortType=booked",
  "total_results": 1234567,
  "page_size": 20,
  "results": [
    {
      "title": "新款 透明硅胶手机壳 适用于iphone15 防摔保护套 全包边",
      "price_cny": 1.85,
      "moq": "10 件",
      "supplier_name": "深圳市华强北科技有限公司",
      "supplier_location": "广东 深圳",
      "transaction_count": 5823,
      "transaction_label": "近30天成交",
      "url": "https://detail.1688.com/offer/636858321032.html",
      "is_certified": true
    }
  ]
}
```

**Empty (valid keyword, zero matches — usually English keyword or over-restrictive filters):**

```json
{
  "success": true,
  "keyword": "spelaeonomicus",
  "filters_applied": {
    "priceStart": null,
    "priceEnd": null,
    "province": null,
    "sortType": null
  },
  "search_url": "https://s.1688.com/selloffer/offer_search.htm?keywords=spelaeonomicus",
  "total_results": 0,
  "page_size": 20,
  "results": []
}
```

**Anti-bot wall (only emitted if the agent attempted the browser fallback and hit `cloud_ip_bl`):**

```json
{
  "success": false,
  "reason": "anti_bot_wall",
  "wall_type": "cloud_ip_bl_punish_deny",
  "wall_url": "https://bixi.alicdn.com/punish/punish:resource:template:cbuSpace:default_38604715.html?...&action=deny&...&cloud_ip_bl|0",
  "remediation": "The mtop API path documented in Workflow does not trigger this wall. Use that path instead of driving the search UI."
}
```
