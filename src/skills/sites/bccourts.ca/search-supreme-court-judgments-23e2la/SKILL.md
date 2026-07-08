---
name: search-supreme-court-judgments
title: Search BC Supreme Court Judgments
description: >-
  Search the BC Supreme Court (bccourts.ca) public judgments index by full-text
  (boolean), case name, neutral citation, judge, docket, registry, or date
  range. First-class support for landlord-tenant matters that reached BCSC via
  judicial review of Residential Tenancy Branch decisions, large-dollar
  petitions for possession, or RTA/foreclosure intersections. Returns case name,
  citation, decision date, court level, judgment HTML URL, and
  highlighted-snippet URL. Read-only.
website: bccourts.ca
category: legal
tags:
  - legal
  - case-law
  - court
  - british-columbia
  - tenancy
  - read-only
source: 'browserbase: agent-runtime 2026-05-24'
updated: '2026-05-24'
recommended_method: browser
alternative_methods:
  - method: fetch
    rationale: >-
      No public JSON/REST API exists. Direct GET with form fields as query
      string is silently ignored (the page is ASP.NET WebForms — server expects
      a POST with a fresh __VIEWSTATE + __EVENTVALIDATION blob). Reconstructing
      the POST out-of-band is possible but brittle (viewstate rotates each
      request), so the browser is the only reliable path.
  - method: browser
    rationale: >-
      Mandatory. Stealth + residential proxies are NOT required — bccourts.ca is
      a public-sector site with no anti-bot. A plain `browserless_agent` call
      handles form submission, postback-based pagination, and judgment HTML
      retrieval end-to-end.
verified: true
proxies: true
---

# Search BC Supreme Court Judgments

## Purpose

Search the public judgments database of the **Supreme Court of British Columbia** (BCSC — the superior trial court of BC) on bccourts.ca and return a paged list of matching decisions with neutral citation, case name, decision date, court level, and a direct URL to the full-text judgment HTML. Designed to work for any topic but with first-class support for **landlord-tenant disputes** that reached BCSC (typically via judicial review of Residential Tenancy Branch decisions, petitions for orders of possession, or foreclosure proceedings affecting tenants). Read-only — does not file, comment on, or otherwise mutate court records.

**Naming disambiguation — this matters.** The user prompt often says "BC Supreme Court of Canada" or "Supreme Court of Canada" when they actually mean the **Supreme Court of British Columbia** (BCSC, on `bccourts.ca`). The **Supreme Court of Canada** (SCC) is a separate federal apex court whose judgments live at `decisions.scc-csc.ca`, not on bccourts.ca, and the bccourts.ca search page explicitly tells you so. If the request is about BC law / a BC dispute / a BC tribunal review, you want BCSC on bccourts.ca — that's this skill. If the user genuinely needs SCC decisions, redirect to `scc-csc.ca`; this skill cannot serve them.

## When to Use

- "Find recent BC Supreme Court judgments about residential tenancy / eviction / Residential Tenancy Branch judicial review."
- Boolean / phrase / case-name / citation / judge / docket / registry-location search of the official BC judgments index.
- Locating the canonical full-text HTML URL of a known BCSC decision (`2024 BCSC 1234` → `https://www.bccourts.ca/jdb-txt/sc/24/12/2024BCSC1234.htm`).
- Date-bounded surveys (e.g. "all BCSC RTA judicial reviews in 2024").
- Distinguishing whether a tenancy dispute actually reached BCSC (vs. staying at the administrative tribunal or in Provincial Court Small Claims).

Not appropriate for: searching Supreme Court of Canada decisions (different domain — `scc-csc.ca`); searching BC Provincial Court judgments (different domain — `provincialcourt.bc.ca`); searching the Residential Tenancy Branch's own decisions (that's `housing.gov.bc.ca`, and most RTB arbitration decisions are not publicly indexed at all).

## Workflow

The bccourts.ca judgments search is a classic **ASP.NET WebForms** page driven by a server-side `__VIEWSTATE` blob. There is **no public JSON/REST API**, no GET-with-query-string shortcut (verified — a GET to `search_judgments.aspx?TabContainer$search$txtFullText=...` returns the empty form, no results), and CanLII (the third-party mirror at canlii.org) is Datadome-protected and returns 403 to a plain fetch. Therefore the browser is the only viable surface.

Stealth is **not required**: bccourts.ca is a public-sector site with no anti-bot. Residential proxy is **not required**. A plain `browserless_agent` call (no proxy, no stealth) handles the workflow end-to-end and is the cheapest, fastest configuration. The validation run that produced this skill added proxy + stealth out of caution; subsequent runs should drop them.

**Session model.** A `browserless_agent` session **persists across separate calls**, keyed by the call's `proxy`/`profile` config — it does not tear down when a call returns, and there is nothing to create or release. Still, because the result set is reconstructed server-side from the rotating `__VIEWSTATE` held on the page, it's simplest to keep the entire flow (open the form → fill via `evaluate` → click submit → read results → paginate) inside **one** call's `commands` array so the loaded page and its viewstate carry across steps without you having to re-establish them.

### 1. Open the search page

The whole flow runs as one `browserless_agent` call whose `commands` array starts by navigating to the search page:

```json
{
  "method": "goto",
  "params": {
    "url": "https://www.bccourts.ca/search_judgments.aspx",
    "waitUntil": "load"
  }
}
```

All the steps below are further entries in the **same** `commands` array — keeping them together is the simplest guarantee that the loaded page and its `__VIEWSTATE` from the previous step are still in place for each subsequent step.

### 2. Fill the form via `evaluate`

The form lives inside an AJAX `TabContainer`. Typing against the human-visible labels works but is brittle (the tab strip and validators occasionally intercept); an `evaluate` against the DOM IDs is the reliable path.

| Field             | DOM ID                                                      | Notes                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Neutral Citation  | `TabContainer_search_txtCitation`                           | Format `YYYY BCSC ####` (e.g. `2024 BCSC 1234`).                                                                                                                                                                 |
| Case Name         | `TabContainer_search_txtCaseName`                           | Substring against the styled case name (e.g. `Naderi` matches both `Naderi v. Cheng` and `Naderi v. Naderi`).                                                                                                    |
| Exact case name   | `TabContainer_search_chkExact`                              | Checkbox; pair with Case Name.                                                                                                                                                                                   |
| Full Text         | `TabContainer_search_txtFullText`                           | Boolean engine. Use `"residential tenancy"` (quoted) for phrase; `A AND B`, `A OR B`, `A NOT B` for operators. **In the absence of operators the engine implies a phrase search**, per the site's own help text. |
| Date From / To    | `TabContainer_search_txtFrom` / `TabContainer_search_txtTo` | **`MM/DD/YYYY`** format (US-style, despite the rest of the site using ISO `YYYY/MM/DD` in result rows). Both inclusive.                                                                                          |
| Court             | `TabContainer_search_radBCCA` / `radBCSC` / `radBoth`       | Pick exactly one. **For BC Supreme Court only, set `radBCSC.checked = true`.** Default if none chosen tends to favour both.                                                                                      |
| Judge             | `TabContainer_search_txtJudge`                              | Surname substring.                                                                                                                                                                                               |
| Docket            | `TabContainer_search_txtDocket`                             | Registry file number.                                                                                                                                                                                            |
| Registry Location | `TabContainer_search_ddlLocation`                           | `<select>` — values are city names like `Vancouver`, `New Westminster`, `Victoria`. Leave blank for province-wide.                                                                                               |
| Submit            | `TabContainer_search_btnSubmit`                             | `<input type=submit>` — `{ "method": "click", "params": { "selector": "#TabContainer_search_btnSubmit" } }`.                                                                                                     |

As `commands` entries (the `evaluate` fills the fields, the `click` submits):

```json
{ "method": "evaluate", "params": { "content": "(() => { document.getElementById('TabContainer_search_txtFullText').value = '\"Residential Tenancy Act\" AND \"judicial review\"'; document.getElementById('TabContainer_search_radBCSC').checked = true; document.getElementById('TabContainer_search_txtFrom').value = '01/01/2023'; document.getElementById('TabContainer_search_txtTo').value = '12/31/2025'; return 'ok'; })()" } }
{ "method": "click", "params": { "selector": "#TabContainer_search_btnSubmit" } }
{ "method": "waitForSelector", "params": { "selector": "#gvResults", "timeout": 15000 } }
```

(The `waitForSelector` on `#gvResults` replaces the old load-wait — the postback re-renders the results table; on a zero-results query it never appears, so also cap it with a `waitForTimeout` and branch on the table being absent, per step 3.)

### 3. Read total count and extract result rows

The total result count is rendered as text on the page in the form `Number found: <N>` (the count is wrapped in the same `<span>` as a discrepancy-disclaimer sentence). The result table has DOM ID `gvResults` — header row at index 0, **50 result rows per page** at indices 1..50, pager row at index 51 (or last). Each result row is a **single `<td>`** containing two `<a>` elements and a free-text block; cell count is always 1.

Each result row's text follows the shape:

```
{CaseName}, {YYYY} BCSC {####} – {YYYY/MM/DD} Supreme Court Highlighted more ...
```

Parse with `/^(.+?), (\d{4}) (BCSC|BCCA) (\d+) – (\d{4}\/\d{2}\/\d{2}) (Supreme Court|Court of Appeal)/`. The two anchors are:

1. **Direct judgment HTML** — `https://www.bccourts.ca/jdb-txt/sc/{YY}/{HH}/{YYYY}BCSC{####}.htm` where `{YY}` is the two-digit year and `{HH}` is `floor(####/100)` zero-padded to 2 digits (file-bucket folder). Corrections add a `cor1`/`cor2` suffix before `.htm`. Example: `2025 BCSC 2362` (corrected) → `/jdb-txt/sc/25/23/2025BCSC2362cor1.htm`. **Always take the URL from the anchor — do not synthesize it, because of `cor1` suffixes and occasional folder anomalies.**
2. **Highlighter snippet URL** — `https://www.bccourts.ca/Highlighter.aspx?DocId={N}&Index=W%3A%5CInternet%5CsearchIndex&HitCount={K}&hits={hex-offsets}` — produces a contextual preview with search terms bolded. Useful as a "preview" link.

Add this as an `evaluate` command in the same array. The result comes back under `.value` — the function returns a `JSON.stringify`ed projection (not raw DOM), so parse `.value` as JSON:

```json
{
  "method": "evaluate",
  "params": {
    "content": "(() => {\n  const t = document.getElementById('gvResults');\n  if (!t) {\n    // 'No Results' page — there is no gvResults table at all\n    const msg = document.body.textContent.match(/No Results/i);\n    return JSON.stringify({total: 0, rows: [], reason: msg ? 'no_results' : 'unknown'});\n  }\n  const total = parseInt((document.body.textContent.match(/Number found:?\\s*(\\d+)/i)||[])[1] || '0', 10);\n  const rows = [];\n  // Skip header (i=0) and pager (last row).\n  for (let i = 1; i < t.rows.length - 1; i++) {\n    const r = t.rows[i];\n    if (r.cells.length !== 1) continue;\n    const txt = r.textContent.replace(/\\s+/g,' ').trim();\n    const m = txt.match(/^(.+?),\\s+(\\d{4})\\s+(BCSC|BCCA)\\s+(\\d+)\\s+–\\s+(\\d{4}\\/\\d{2}\\/\\d{2})/);\n    const aJudg  = r.querySelector('a[href*=\"/jdb-txt/\"]');\n    const aHlt   = r.querySelector('a[href*=\"Highlighter.aspx\"]');\n    rows.push({\n      case_name: m ? m[1] : null,\n      citation:  m ? `${m[2]} ${m[3]} ${m[4]}` : null,\n      court:     m ? m[3] : null,\n      year:      m ? parseInt(m[2],10) : null,\n      number:    m ? parseInt(m[4],10) : null,\n      decision_date: m ? m[5].replace(/\\//g,'-') : null,\n      judgment_url:  aJudg ? aJudg.href : null,\n      snippet_url:   aHlt  ? aHlt.href  : null\n    });\n  }\n  return JSON.stringify({total, rows});\n})()"
  }
}
```

### 4. Paginate

The pager row exposes JavaScript-postback anchors. There is **no URL change** between pages — the result set is reconstructed from `__VIEWSTATE` on the server. Pages are 50 results each. The visible pager shows pages 1..10 plus a `...` link; clicking `...` advances the visible window by 10. To jump to an arbitrary page, drive `__doPostBack` from an `evaluate` (still in the same `commands` array, so the viewstate persists), then re-read the table:

```json
{ "method": "evaluate", "params": { "content": "__doPostBack('gvResults', 'Page$3')" } }
{ "method": "waitForSelector", "params": { "selector": "#gvResults", "timeout": 15000 } }
```

Follow each postback with another copy of the step-3 extraction `evaluate` to read that page's rows. Rather than splitting the flow across calls, append one `__doPostBack` + extract pair per page you need to the **same** `commands` array — that keeps the loaded page and its search state in place across the postbacks. For very wide queries (`Number found: 3174` on the bare term `tenancy`, observed 2026-05-24), iterate until `Math.ceil(total/50)` — or read `total` from page 1 first, then issue a second call that re-navigates, re-submits the identical query, and walks straight to the needed pages. A landlord-tenant filter (`"Residential Tenancy Act" AND "judicial review"` 2023-01-01 to 2025-12-31) returns ~144 results — three pages — which is typical.

### 5. No session-release step

There is nothing to release, and no session dies on return: a `browserless_agent` session **persists across calls, keyed by the `proxy`/`profile` config**. Keeping the entire open → fill → submit → read → paginate flow inside one call's `commands` array is still the simplest approach, because it guarantees the loaded page and its `__VIEWSTATE` carry across the steps without re-establishing them (see the session-model note above).

### 6. Recommended landlord-tenant query patterns

Tenancy disputes in BC follow a layered jurisdiction. Most disputes start at the **Residential Tenancy Branch (RTB)** — an administrative tribunal under the _Residential Tenancy Act_ — and reach **BCSC only by**:

| Path to BCSC                                                               | Recommended `Full Text` query                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Judicial review of an RTB decision                                         | `"Residential Tenancy Branch" AND "judicial review"`                   |
| Petition for order of possession (above provincial small-claims cap)       | `"order of possession" AND landlord`                                   |
| Trespass / occupation disputes outside RTA scope                           | `"Residential Tenancy Act" AND ("non-residential" OR "not a tenancy")` |
| RTA + foreclosure intersection (tenants of mortgaged properties)           | `"Residential Tenancy Act" AND foreclosure`                            |
| All RTA-citing decisions (broadest useful net)                             | `"Residential Tenancy Act"`                                            |
| All tenancy-mentioning decisions (very broad — includes commercial leases) | `tenancy`                                                              |

Always pair these with `radBCSC` to filter out the Court of Appeal layer. To capture appeals from BCSC judicial-review decisions, run the same query with `radBoth` and post-filter by `court === 'BCCA'`.

## Site-Specific Gotchas

- **"BC Supreme Court" ≠ "Supreme Court of Canada".** Users (and LLMs) routinely conflate them. bccourts.ca is the BC superior trial court; the SCC is at `scc-csc.ca` and is out of scope for this skill. The search page itself says: _"To search judgments of the Supreme Court of Canada or of other Canadian courts, please visit their websites."_ If your prompt is genuinely SCC-bound, fail loudly rather than returning BCSC results.
- **Residential-tenancy law in BC mostly lives outside BCSC.** The Residential Tenancy Branch handles ~99% of tenancy arbitration; its own decisions are _not_ indexed on bccourts.ca and largely not public. A BCSC search for "landlord-tenant disputes" therefore returns the small slice that reached the superior court (judicial reviews, large-dollar petitions, foreclosure intersections). Set user expectations accordingly — a "0 results" or "low double-digit results" outcome can be the right answer for a narrow query.
- **ASP.NET WebForms — no GET shortcut, no JSON API.** The form is driven by `__VIEWSTATE`, `__EVENTVALIDATION`, `__VIEWSTATEGENERATOR` hidden inputs. A GET to `search_judgments.aspx?TabContainer$search$txtFullText=...` ignores the query string and serves the empty form. POST without a fresh viewstate gets rejected. Browser is mandatory.
- **CanLII (third-party mirror) is Datadome-protected.** A plain fetch (or a `browserless_agent` `goto`) of `https://www.canlii.org/...` returns 403 with `X-Datadome: protected`. Don't try to route around bccourts.ca via canlii.org for headless flows — even with a residential proxy, you'll hit the captcha wall.
- **Stealth + residential proxies are NOT needed.** A plain `browserless_agent` call works. The validation run that produced this skill added proxy + stealth defensively, but every form-submit, pagination postback, and judgment-HTML GET succeeded against unproxied direct IPs in subsequent spot-checks. Save the cost.
- **Date format is `MM/DD/YYYY`** in the search inputs, even though the result rows render dates as ISO `YYYY/MM/DD`. Sending `2024-01-01` or `2024/01/01` in the From/To fields is silently ignored (no validation error — just no date filter applied). Always format as `01/01/2024`.
- **"Full Text" without operators is a phrase search, not a bag-of-words.** Per the page's own help text: _"In the absence of operators, the search engine will imply a phrase search."_ So `residential tenancy act` and `"Residential Tenancy Act"` return the same results; `residential AND tenancy` is what gets you the boolean expansion.
- **Result rows are a single `<td>` of mixed text + anchors** — not a multi-column table. Parse by regex on the row's text content; pull the judgment URL from the `a[href*="/jdb-txt/"]` anchor and the snippet preview from the `a[href*="Highlighter.aspx"]` anchor.
- **Pagination is JS-only postback.** Clicking page numbers fires `__doPostBack('gvResults', 'Page$N')`. The URL never changes (it stays `search_judgments.aspx#SearchTitle`), so the page can't be deep-linked. To collect all N pages of a wide query, drive an `evaluate` of `__doPostBack('gvResults', 'Page$K')` for `K = 2..ceil(total/50)`, waiting on `#gvResults` between each (all in the one `commands` array). The pager only renders 10 page links at a time + a `...` link to advance the window — but `__doPostBack` accepts any page number, so jump directly.
- **Judgment URL pattern is `{YY}/{HH}/{YYYY}BCSC{####}.htm` where `{HH} = floor(####/100)`.** Verified across `2026 BCSC 904` → `26/09/`, `2025 BCSC 2082` → `25/20/`, etc. But corrections add a `cor1`/`cor2` suffix (e.g. `2025BCSC2362cor1.htm`), and occasional cases have folder anomalies. **Always take the anchor's `href` from `gvResults` rather than synthesizing the URL from the citation alone** — synthesis will 404 on corrections.
- **Zero results renders no `gvResults` table at all** — just the text "No Results" on the page. Branch on `document.getElementById('gvResults') === null` to detect this case; otherwise the result-row loop iterates over `undefined`.
- **There may be some discrepancies in the search results due to the way the historical data was compiled** — this disclaimer is in the header of the gvResults table on every search. The site warns that older decisions (pre-~2000s) may have incomplete metadata. For dispositive legal research, cross-reference with CanLII (manually — see Datadome note above) or a paid service.
- **Court Registry location dropdown has a stray leading blank entry** before `100 Mile House`. If round-tripping the dropdown value, the empty `value=""` is "no filter" (good); `value="-- Unknown --"` (the first option) is invalid — don't select it.
- **The Court of Appeal and Supreme Court share the same search page**, with `radBCCA` / `radBCSC` / `radBoth` as the discriminator. Despite the URL being `search_judgments.aspx` (no court qualifier), forgetting to select `radBCSC` and leaving the default returns both court levels mixed together, which is rarely what a "BC Supreme Court judgments" prompt wants.

## Expected Output

```json
{
  "query": {
    "full_text": "\"Residential Tenancy Act\" AND \"judicial review\"",
    "court": "BCSC",
    "date_from": "2023-01-01",
    "date_to": "2025-12-31"
  },
  "total_results": 144,
  "page": 1,
  "page_size": 50,
  "results": [
    {
      "case_name": "Banni v. Coast Foundation Society (1974) (Coast Mental Health)",
      "citation": "2025 BCSC 2362",
      "court": "BCSC",
      "year": 2025,
      "number": 2362,
      "decision_date": "2025-12-01",
      "judgment_url": "https://www.bccourts.ca/jdb-txt/sc/25/23/2025BCSC2362cor1.htm",
      "snippet_url": "https://www.bccourts.ca/Highlighter.aspx?DocId=..."
    },
    {
      "case_name": "Ferguson v. Candou Industries Ltd.",
      "citation": "2025 BCSC 2430",
      "court": "BCSC",
      "year": 2025,
      "number": 2430,
      "decision_date": "2025-11-28",
      "judgment_url": "https://www.bccourts.ca/jdb-txt/sc/25/24/2025BCSC2430.htm",
      "snippet_url": "https://www.bccourts.ca/Highlighter.aspx?DocId=..."
    }
  ]
}
```

Zero-results shape:

```json
{
  "query": { "full_text": "xyzqqq-no-match", "court": "BCSC" },
  "total_results": 0,
  "page": 1,
  "page_size": 50,
  "results": [],
  "reason": "no_results"
}
```

Wrong-court warning (when the prompt asked for "Supreme Court of Canada" but the skill defaulted to BCSC):

```json
{
  "warning": "wrong_court",
  "message": "The prompt mentioned 'Supreme Court of Canada' (SCC), which is a different court from the BC Supreme Court (BCSC) indexed at bccourts.ca. For SCC decisions, use https://decisions.scc-csc.ca. Returning BCSC results as a best-guess interpretation."
}
```
