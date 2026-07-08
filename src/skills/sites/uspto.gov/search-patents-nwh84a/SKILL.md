---
name: search-patents
title: USPTO Patent Search
description: >-
  Search USPTO Patent Public Search for granted patents and pre-grant
  publications matching a keyword/full-text query and return the top results
  (number, title, inventors, publication/grant date, type, total hits, and PDF
  link) via the app's in-session JSON API.
website: uspto.gov
category: legal
tags:
  - patents
  - uspto
  - search
  - intellectual-property
  - read-only
  - government
source: 'browserbase: agent-runtime 2026-06-04'
updated: '2026-06-04'
recommended_method: hybrid
alternative_methods:
  - method: browser
    rationale: >-
      Drive the Basic app UI (ppubs.uspto.gov/basic/) — type the query, click
      Search, read the results table. Reliable but costly: the advanced results
      grid snapshots to 1000-1500 a11y refs, so prefer the in-session API call.
  - method: api
    rationale: >-
      PatentsView (search.patentsview.org) and the USPTO Open Data Portal
      (api.uspto.gov) are clean JSON APIs and the best choice IF you have an
      X-Api-Key. Both return 401 without a key, so they are unusable anonymously
      in-sandbox.
verified: true
proxies: true
---

# USPTO Patent Search

## Purpose

Search the USPTO Patent Public Search corpus (granted patents `USPAT`, pre-grant
publications `US-PGPUB`, and older OCR documents `USOCR`) for a keyword / full-text
query and return the top results with patent (or publication) number, title, lead
inventor string, publication/grant date, document type, page count, total hit count,
and a direct link to the patent PDF. Read-only — it never logs in, saves a case, or
exports anything.

The reliable, low-cost path is **hybrid**: load the Patent Public Search app once in a
real browser to bootstrap the WAF cookie + session token, then call the app's own
JSON search API (`/api/searches/generic`) from page context. This returns clean
structured JSON in a single round-trip and avoids scraping the 1000+-node results grid.

## When to Use

- "Find recent USPTO patents about <topic>" / keyword or full-text patent search.
- Assignee, inventor, or title searches via USPAT field operators (e.g. `IBM.as.`,
  `Smith.in.`, `quantum.ti.`).
- Monitoring newly-granted patents or pre-grant publications matching a query.
- Any flow that needs a ranked/dated list of matching patents + their numbers and
  document links, without needing to read full claim text per result.

## Workflow

This site has **no usable anonymous JSON API off a real browser**: the two documented
public APIs both require an API key (see Gotchas), and direct egress to
`ppubs.uspto.gov/api` from outside a browser session is WAF-blocked. So the optimal
path runs the app's internal API _from inside_ a Browserless page.

### 1. Run the whole flow in one `browserless_function` call

Everything below lives in a single `browserless_function` (with
`proxy: { proxy: "residential" }`). The function body **must first navigate the page**
to the app origin so the WAF cookie is set and the `/api/` backend is primed, then
`page.evaluate` the same-origin two-fetch sequence. Because the fetches run from page
context after `page.goto`, they are same-origin and succeed where a bare client is
WAF-blocked. The WAF cookie set by `page.goto` persists into the `page.evaluate`, so
there is no separate session-create/bootstrap step.

```js
export default async ({ page }) => {
  // Bootstrap: this sets the WAF cookie and primes the /api/ backend.
  // The lighter "Basic" app at https://ppubs.uspto.gov/basic/ works identically.
  // Avoid https://ppubs.uspto.gov/pubwebapp/external.html — it can land on a
  // "Log Manager" overlay that wastes steps.
  await page.goto('https://ppubs.uspto.gov/pubwebapp/', {
    waitUntil: 'load',
    timeout: 45000,
  });

  // The API requires a rotating x-access-token. Obtain it from the RESPONSE HEADER
  // of a session POST, then use it on the search POST — both in the same evaluate so
  // the token is fresh. Same-origin fetches, so they work from page context.
  const data = await page.evaluate(async () => {
    const sh = {
      'Content-Type': 'application/json',
      'x-access-token': 'null',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: '*/*',
    };
    const s = await fetch('/api/users/me/session', {
      method: 'POST',
      headers: sh,
      body: '-1',
    });
    const tok = s.headers.get('x-access-token');
    const q = {
      cursorMarker: '*',
      databaseFilters: [
        { databaseName: 'USPAT' },
        { databaseName: 'US-PGPUB' },
      ],
      fields: [
        'documentId',
        'patentNumber',
        'title',
        'datePublished',
        'inventors',
        'pageCount',
        'type',
      ],
      op: 'AND',
      pageSize: 10,
      q: 'quantum AND computing',
      searchType: 0,
      sort: 'date_publ desc',
    };
    const r = await fetch('/api/searches/generic', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': tok,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json',
      },
      body: JSON.stringify(q),
    });
    return JSON.stringify(await r.json());
  });

  return { data, type: 'application/json' };
};
```

Response: `{ "cursorMarker": "...", "numFound": <int>, "docs": [ {documentId, patentNumber, title, datePublished, inventors, pageCount, type}, ... ] }`.

### 2. Build the output

- `numFound` → `total_results`.
- Per `docs[]` entry: `patent_number` = `patentNumber`; `title`; `publication_date` =
  `datePublished` (this is the grant date for `USPAT`, the publication date for
  `US-PGPUB`); `inventors` = the `inventors` string (lead inventor + "et al.");
  `type` (`USPAT` = granted, `US-PGPUB` = pre-grant publication, `USOCR` = OCR backfile).
- `document_url` (granted patents): `https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/{patentNumber}` (verified `200 application/pdf`).
- Paginate by passing the returned `cursorMarker` as the next request's `cursorMarker`
  (and keep all other params identical).

### 3. (Optional) Enrich with assignee / abstract / filing date

These are **not** in the search-results JSON (see Gotchas). They are rendered by the
app's Document Viewer when a result is opened. If you need them, select the result row
in the UI and read the Document Viewer panel (it shows Inventor / Applicant / Assignee
blocks with city/state/country, plus the abstract and application data). Budget one
extra interaction per result — do this only for the handful of results you actually
need enriched.

### Browser fallback (no `browserless_function` path available)

Use `browserless_agent` (with `proxy: { proxy: "residential" }`) against the **Basic**
app UI: `{ "method": "goto", "params": { "url": "https://ppubs.uspto.gov/basic/", "waitUntil": "load", "timeout": 45000 } }`,
then `{ "method": "type", "params": { "selector": "<term box>", "text": "<word>" } }`
into each term box (one word per box; pick the "Operator" = `AND`/`OR` between the two
boxes), `{ "method": "click", "params": { "selector": "<Search button>" } }`, then
`{ "method": "snapshot" }` the rendered results table (columns: Result #, Document/
Patent number, Title, Inventor name, Publication date, Pages). This works but is far
costlier — the advanced app's results grid alone snapshots to 1000–1500 a11y refs,
which is why the `browserless_function` path above is preferred.

## Site-Specific Gotchas

- **READ-ONLY.** Never save a case, log in, or export. The app silently creates an
  "Untitled Case" per session — that's expected; ignore it.
- **The API must run from inside the browser session.** Direct curl/fetch to
  `ppubs.uspto.gov/api` from outside a real browser page fails (WAF / network). A
  same-origin `fetch` inside `browserless_function`'s `page.evaluate` succeeds because
  the `page.goto` earlier in the same call already established the WAF cookie + session.
- **Rotating `x-access-token`.** `POST /api/users/me/session` (body `-1`,
  `x-access-token: null`) returns a fresh token in the **response header**
  `x-access-token` (a base64 JSON blob `{sub, ver, exp}`; `ver` rotates each call).
  Grab the token and use it immediately on the search POST. If a call returns 401/403,
  reload the app and re-bootstrap.
- **Only 7 fields come back from search.** Per `SearchResultDoc.js` the search response
  carries exactly: `documentId, inventors, pageCount, patentNumber, datePublished,
title, type`. **Assignee, abstract, filing date, and the full inventor list are NOT
  returned** — adding them to the `fields` array is silently ignored. Get them from the
  Document Viewer (Workflow step 3).
- **`inventors` is a truncated string**, e.g. `"Niu; Yuezhen et al."` (lead inventor +
  "et al."), not an array. Treat it as a display string, not structured data.
- **`datePublished` is grant date OR publication date depending on `type`.** For
  `USPAT` it's the grant date; for `US-PGPUB` it's the publication date. There is no
  separate filing/grant field in the search response.
- **Query syntax.** `searchType: 0` with `op: "AND"|"OR"` joins plain terms. The `q`
  field also accepts USPAT operators: `quantum.ti.` (title), `IBM.as.` (assignee),
  `Smith.in.` (inventor), `.clm.` (claims), `.ab.` (abstract), date ranges
  `@pd>=20240101`. `sort`: `"date_publ desc"` (newest first) or `"relevance"`.
- **Basic-UI number formatting** (only relevant on the fallback UI): patent numbers
  need leading zeros to 7 digits (e.g. `123456` → `0123456`); publication numbers to
  11 (e.g. `2021123456` → `20210123456`); dates are `YYYYMMDD`.
- **Don't waste time on the documented public APIs anonymously — confirmed key-gated:**
  PatentsView `search.patentsview.org` returns 401/400 without `X-Api-Key`, and the
  USPTO Open Data Portal `api.uspto.gov` returns `401 UnauthorizedException`
  (`X-Api-Key` required). If you _have_ a key, those are cleaner JSON APIs and a better
  choice than the browser; without one, the in-session `ppubs` API above is the path.
- **Richer `ppubs` endpoints exist but need a different body schema.**
  `/api/searches/searchWithBeFamily` and `/api/searches/counts` return `400 Invalid
request content` on the generic body — not worth reverse-engineering for a
  search-and-list skill.
- **Stealth + residential proxy was used during development** (`proxy: { proxy:
"residential" }` on the function/agent call). USPTO did not serve a captcha or hard
  block in testing, but it is a heavy WAF-fronted gov SPA; keep the residential proxy
  on for reliability.

## Expected Output

```json
{
  "success": true,
  "query": "quantum computing",
  "total_results": 160437,
  "result_count": 10,
  "results": [
    {
      "patent_number": "12645963",
      "document_id": "US-12645963-B1",
      "type": "USPAT",
      "title": "Systems and methods to learn two-level system defects in quantum systems",
      "inventors": "Niu; Yuezhen et al.",
      "publication_date": "2026-06-02",
      "page_count": 30,
      "document_url": "https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12645963",
      "assignee": null,
      "abstract_excerpt": null,
      "filing_date": null
    }
  ],
  "notes": "assignee, abstract_excerpt, and filing_date are null because they are not in the search-results API; open the Document Viewer per result to populate them (see Workflow step 3).",
  "error_reasoning": null
}
```

Failure / blocked shape:

```json
{
  "success": false,
  "query": "quantum computing",
  "total_results": 0,
  "results": [],
  "error_reasoning": "Exact on-screen or HTTP error, e.g. 'session bootstrap returned 403' or 'app failed to load'."
}
```
