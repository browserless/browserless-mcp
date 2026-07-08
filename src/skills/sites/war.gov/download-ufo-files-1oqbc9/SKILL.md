---
name: download-ufo-files
title: Download War.gov UFO Files (Release 01 & 02)
description: >-
  Download the U.S. Department of War's UAP/UFO document bundles (Release 01
  ~1.2GB and Release 02 ~70MB) from war.gov/UFO/ through a Browserless browser
  session that captures the download, then verify the ZIP archives.
website: war.gov
category: government-records
tags:
  - government
  - uap
  - ufo
  - file-download
  - archive
  - war-gov
source: 'browserbase: agent-runtime 2026-06-09'
updated: '2026-06-09'
recommended_method: browser
alternative_methods:
  - method: fetch
    rationale: >-
      A size-capped fetch (any HTTP client with a response-body limit, and the
      ~200k-char browserless_function text return) can't carry these bundles —
      usable only for files under the cap, which 1.2GB / 70MB are not.
  - method: cli
    rationale: >-
      Retrieval is a browser download: the bundle downloads inside the
      Browserless session's Chrome and is pulled from the session's download
      storage — it cannot be returned inline from a tool call at this size.
verified: false
proxies: false
---

# Download UFO Files Release 01 & 02 (war.gov)

## Purpose

Download the two UAP/UFO **document bundles** published by the U.S. Department of War on its "Presidential Unsealing and Reporting System for UAP Encounters" page (`war.gov/UFO/`): **Release 01 Documents** (`Release_1.zip`, ~1.2 GB, 262 files) and **Release 02 Documents** (`release_02_document_bundle.zip`, ~70 MB). Both are publicly accessible ZIP archives of declassified PDFs/images. This skill retrieves the raw ZIPs and verifies them; it is read-only and never submits anything.

## When to Use

- A user wants the full Release 01 and/or Release 02 UAP **document** archives from war.gov pulled to local disk.
- Archival / bulk-ingest pipelines that need the original ZIPs (not individual PDFs).
- Re-validating that the official bundle URLs are still live and unchanged.
- NOT for the separate **video** bundles — those are large CloudFront-hosted archives (see Gotchas) and are out of scope here.

## Workflow

These ZIPs are far too large to return inline from any tool call — a size-capped fetch 502s, and the `browserless_function` text return caps at ~200k chars. They must be pulled as a **browser download**: the file downloads inside the Browserless session's Chrome and is retrieved from the session's download storage (Browserless captures files a page downloads into a per-session download area, retrievable as an archive). **A real Chrome session — even a plain one with no residential proxy — passes war.gov's WAF, so no `proxy` arg is required** (verified across both files; see Gotchas for why the pre-run probe disagreed).

Direct, stable bundle URLs (no auth, no Content-Disposition; `application/zip`, HTTP 200):

- Release 01 Documents — `https://www.war.gov/medialink/ufo/bundle/Release_1.zip` (1,223,976,178 bytes)
- Release 02 Documents — `https://www.war.gov/medialink/ufo/052226/release_02/release_02_document_bundle.zip` (69,986,448 bytes)

1. **Run a download-enabled session with a generous timeout.** Use a `browserless_function` (or `browserless_agent`) call with no `proxy` arg, and set a long timeout — the 1.2 GB transfer can run several minutes and the session must outlive it. Enable download capture on the session before navigating (Browserless persists page downloads to the session's download storage; that capture must be active _before_ the download fires).

2. **Navigate to the ZIP so Chrome downloads it.** Inside the function, `page.goto` the bundle URL (or set a same-tab navigation to it). A ZIP triggers a _download_, not a page navigation, so the tab's title/URL won't change and the `goto` may reject with `net::ERR_ABORTED` — **that rejection is expected, not a failure**; the download still proceeds. Wait until the download completes (received bytes === total bytes) before ending the call.

3. **Retrieve the file from session download storage.** After the in-browser download completes there is a propagation delay (~12–30 s, longer for 1.2 GB) before the file is available. Pull it from the session's download area (Browserless returns captured downloads as an archive). An empty/near-empty result means "nothing captured yet" — wait and retry until the size jumps to the real bundle size. The retrieved archive may **wrap** the actual bundle (renamed with a timestamp suffix, e.g. `Release_1-<epoch_ms>.zip`); unzip one level to get the real bundle. Because of the ~200k-char cap you cannot receive the bytes through a tool's text return — the download must land as a file in storage, not as a returned value.

4. **Verify.** Unzip the wrapper if present, confirm the inner ZIP's byte size matches the expected `content-length`, and `unzip -l` it. Release 01 should list 262 entries under `Release_1/` (FBI photos + `*-HQ-*` document PDFs); Release 02 lists UAP PDFs under `release_02_document_bundle/` (DOE/CIA/DOW `*-UAP-*` files). The bundles include macOS `__MACOSX/` resource-fork entries — ignore them.

5. **No explicit session release is needed** — there is nothing to release. Just make sure the call's timeout is long enough for the whole download + capture to finish inside it; the transfer runs within the call, so a too-short timeout cuts it off.

### Finding the links (optional discovery)

If the bundle URLs ever change, run a `browserless_agent` call that `goto`s `https://www.war.gov/UFO/` and `evaluate`s the anchor hrefs whose text matches `Download Release NN Documents`. Note the **Release 01 link lives in a hidden release-toggle tab** — on page load the "Release 02" tab is active, so the Release 01 document link is not visible until you `click` the `RELEASE 01` tab (or just read it straight from `document.querySelectorAll('a')` in the `evaluate`, since hidden anchors are still in the DOM).

## Site-Specific Gotchas

- **A real browser works; the probe's 403 is a non-browser artifact.** A plain HTTP client (no browser) gets `403` from war.gov's WAF — that is what the pre-run probe saw. A real Chrome session, even with **no** residential `proxy`, loads the homepage and both ZIPs with `200`. So set `verified:false, proxies:false` honestly. If the WAF ever tightens, adding `proxy: { proxy: "residential" }` is the escalation, but it was not required here and a residential proxy would add per-GB bandwidth cost (painful on the 1.2 GB file).
- **A size-capped fetch can't download these.** Pulling a bundle through any response-body-limited fetch (or a `browserless_function` text return, ~200k chars) fails with an "exceeded maximum allowed size" error. Use a real browser download to a file, not an inline fetch, for the bundles.
- **Download capture must be enabled BEFORE the navigation fires.** If Chrome starts the download before the session's download capture is armed, nothing is stored — the retrieved archive comes back empty. Arm capture first, then navigate to the ZIP URL.
- **The retrieved archive may wrap the bundle, not be it directly.** The real archive can be nested inside and renamed with a `-<epoch_ms>` suffix (`Release_1-1781017165599.zip`). Unzip one level.
- **Capture is asynchronous.** Right after the in-browser download completes, the file can be missing/empty from download storage for 10–30 s. Poll with a delay; don't treat the first empty result as failure.
- **Release 01 is 1.2 GB.** Budget disk (~2.5 GB transient for wrapper + extracted inner), a generous session timeout, and wall time (several minutes). The in-browser download is reliable end-to-end but slow.
- **Release 01 download link is in a hidden tab.** On `war.gov/UFO/` the Release 02 tab is selected by default; the Release 01 documents anchor is present in the DOM but `offsetParent === null` until the `RELEASE 01` tab is clicked. The direct URL is stable regardless, so prefer the hard-coded URL over scraping the visible tab.
- **Video bundles are a different host and out of scope.** The same page also offers "Download Release 0N Videos" — those point at CloudFront (`https://d34w7g4gy10iej.cloudfront.net/uapvideos.zip` ~1.3 GB, `uap052226.zip` ~5.6 GB), not war.gov. This skill targets only the two **document** bundles.
- **A CSV manifest exists** for Release 01 at `https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-release001.csv` — handy for cross-checking the file list without unzipping 1.2 GB.

## Expected Output

A confirmation object per downloaded bundle (paths are local to wherever you unzipped):

```json
{
  "success": true,
  "verified": false,
  "proxies": false,
  "bundles": [
    {
      "release": "01",
      "label": "Download Release 01 Documents",
      "source_url": "https://www.war.gov/medialink/ufo/bundle/Release_1.zip",
      "content_type": "application/zip",
      "bytes": 1223976178,
      "inner_filename": "Release_1.zip",
      "entry_count": 262,
      "top_folder": "Release_1/",
      "valid_zip": true
    },
    {
      "release": "02",
      "label": "Download Release 02 Documents",
      "source_url": "https://www.war.gov/medialink/ufo/052226/release_02/release_02_document_bundle.zip",
      "content_type": "application/zip",
      "bytes": 69986448,
      "inner_filename": "release_02_document_bundle.zip",
      "top_folder": "release_02_document_bundle/",
      "valid_zip": true
    }
  ]
}
```

Failure shape (e.g. WAF tightened, or sync never produced a non-empty archive):

```json
{
  "success": false,
  "release": "01",
  "error_reasoning": "downloads get returned 22-byte empty archive after 6 retries / 120s"
}
```
