---
name: cali-highway-traffic
title: California Highway Traffic Speeds (MPH per Highway)
description: >-
  Return current real-time MPH for every California highway covered by ABC7's
  traffic map — per road, per direction, with active incidents — by querying the
  Sigalert/Total Traffic Network JSON backend that the abc7news.com/traffic/
  page embeds via iframe.
website: abc7news.com
category: transportation
tags:
  - traffic
  - highways
  - california
  - real-time
  - mph
  - sigalert
  - bay-area
source: 'browserbase: agent-runtime 2026-05-19'
updated: '2026-05-19'
recommended_method: api
alternative_methods:
  - method: browser
    rationale: >-
      Only useful if the JSON endpoints start returning 4xx — the embedded
      Sigalert map renders speeds into canvas tiles (not DOM text), so the
      browser fallback still has to read the same three JSON URLs out of
      performance.getEntriesByType('resource'). ~100× slower than direct fetch
      and adds no information.
verified: false
proxies: false
---

# California Highway Traffic Speeds (MPH per Highway)

## Purpose

Return the current real-time vehicle speed (MPH) for every California highway covered by ABC7 San Francisco's traffic map — broken down per road, per direction, per sensor — along with active incidents and traffic camera references. The data is sourced from the Sigalert / Total Traffic Network (TTN) backend that ABC7 embeds via the `partner=kgo-tv` iframe at `abc7news.com/traffic/`. Read-only; never posts or alters data.

## When to Use

- "What's the current speed on I-580 eastbound?"
- "Which Bay Area freeways are running below 30 MPH right now?"
- A commute / routing agent that needs a regional MPH snapshot to score alternatives.
- A traffic-monitoring agent producing alerts when a highway segment drops below a threshold.
- Any task framed as "MPH for each highway" / "current freeway speeds" on a California ABC7 affiliate's traffic page.

## Workflow

The ABC7 traffic page (`abc7news.com/traffic/`) is a thin shell that embeds an iframe to `sigalert.com/Custom/Map.asp?partner=kgo-tv`. **The map is rendered client-side from three plain JSON endpoints with no auth, no cookies, no anti-bot, no proxy requirement.** Lead with the JSON API — it returns the entire region's MPH-per-sensor table in a single GET. Browser-driving the embedded map is a ~100× slower fallback (panning + clicking each pin to read its tooltip), and a `snapshot` of the rendered map exposes none of the speed values (they're drawn into canvas tiles, not DOM text).

Three regions are exposed by the same backend: `NoCal` (San Francisco Bay Area — what `partner=kgo-tv` shows), `SoCal` (Los Angeles — same backend serves KABC-TV's affiliate equivalent), and `CenCal` (Central Valley). Each region is independent — fetch one region's bundle to answer questions about it.

### 1. Resolve the current data path (cache-busting indirection)

```
GET https://www.sigalert.com/Data/{Region}/path.json
```

Returns:

```json
{
  "path": "NoCal/3~j",
  "cacheBuster": 31811789,
  "updateTime": 1779168624001,
  "version": 29400181
}
```

`path` rotates every ~30s (the `~j` / `~k` / `~l` suffix is the slot; `1~j`, `2~j`, `3~j` form a small rotation). You **must** re-fetch `path.json` before each live-data pull — pinning a stale path returns the snapshot from the moment it was current, not "now".

### 2. Fetch the live speed/incident/camera bundle

```
GET https://www.sigalert.com/Data/{path}/{Region}Data.json?cb={cacheBuster}
```

E.g. `https://www.sigalert.com/Data/NoCal/3~j/NoCalData.json?cb=31811789`. Returns:

```json
{
  "speeds":    [[mph, hovMph, items[]], ...],   // positional, aligned to sensorNames[]
  "incidents": [[severity, id, timeDisplay, location, type, ...], ...],
  "cameras":   [[cameraId, sensorIdx, roadId, ?, label, label, imageUrl, ...], ...]
}
```

- `speeds[i][0]` — current MPH at sensor `i` (integer; `null` if no reading).
- `speeds[i][1]` — current HOV-lane MPH (often `null`).
- `speeds[i][2]` — array of co-located items (camera/incident references).

The Content-Type header is misleadingly `text/javascript` but the body is plain JSON — parse with `JSON.parse`.

### 3. Fetch the static road metadata (cache this; changes rarely)

```
GET https://cdn-static.sigalert.com/240/Zip/RegionInfo/{Region}Static.json
```

Returns:

```json
{
  "sensorNames":     ["Gorda Mt Rd (4.6 miles before)", "Gorda Mt Rd", ...],
  "sensorPositions": [[x, y, ...], ...],
  "roads":           { "100011": ["1", 0, 0, [[0,92,65],[93,100,35],...]], ... },
  "roadSections":    [[100011, "North", "1", 0, 332], [100012, "South", "1", 333, 667], ...]
}
```

- `sensorNames[i]` is aligned 1:1 with `speeds[i]` from step 2.
- `roads[id]` = `[displayName, _, _, speedLimitSegments]` — `displayName` is the bare route number ("1", "101", "580"); see Gotchas for the missing road-type prefix.
- `roadSections[]` is the join key — `[roadId, direction, displayName, firstSensorIdx, lastSensorIdx]` ties contiguous sensor ranges to a single direction of travel on a single highway. The 4th and 5th values are inclusive indices into `sensorNames[]` / `speeds[]`.

### 4. Join + aggregate to per-highway MPH

```js
const byRoad = new Map();
for (const [roadId, dir, name, first, last] of stat.roadSections) {
  const rec = byRoad.get(roadId) || { roadId, name, sections: [] };
  const mphValues = [];
  for (let i = first; i <= last; i++) {
    const s = data.speeds[i];
    if (s && typeof s[0] === 'number') mphValues.push(s[0]);
  }
  if (mphValues.length) {
    rec.sections.push({
      direction: dir, // "North" | "South" | "East" | "West"
      sensorRange: [first, last],
      sensors: mphValues.length,
      avgMph: +(
        mphValues.reduce((a, b) => a + b, 0) / mphValues.length
      ).toFixed(1),
      minMph: Math.min(...mphValues),
      maxMph: Math.max(...mphValues),
      perSensor: mphValues, // optional — same order as sensor indices
    });
  }
  byRoad.set(roadId, rec);
}
```

Yields ~74 distinct highway-direction entries in NoCal, each with current MPH stats.

### Executing with Browserless

There is **no anti-bot, no auth, no cookies, no proxy requirement** — so the whole protocol is three GETs plus a client-side join. Use **`browserless_function`**, but note its code runs in a **browser page context** (not Node — there is no `process`, and a bare `fetch(...)` has no network egress until you navigate the page to an origin). So: `page.goto('https://www.sigalert.com/')` first, then do all three fetches + the join inside a single `page.evaluate`. The two `www.sigalert.com` URLs are then same-origin; `cdn-static.sigalert.com` is cross-origin but CORS-permits the read (verified). Return only the compact summary.

```js
// browserless_function `code`
export default async ({ page }) => {
  const REGION = 'NoCal'; // or 'SoCal' / 'CenCal'
  await page.goto('https://www.sigalert.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  const result = await page.evaluate(async (REGION) => {
    const j = async (u) => JSON.parse(await (await fetch(u)).text()); // bodies are text/javascript; parse manually
    const p = await j(`https://www.sigalert.com/Data/${REGION}/path.json`);
    const live = await j(
      `https://www.sigalert.com/Data/${p.path}/${REGION}Data.json?cb=${p.cacheBuster}`,
    );
    const stat = await j(
      `https://cdn-static.sigalert.com/240/Zip/RegionInfo/${REGION}Static.json`,
    );
    const byRoad = new Map();
    for (const [roadId, dir, name, first, last] of stat.roadSections) {
      const mph = [];
      for (let i = first; i <= last; i++) {
        const s = live.speeds[i];
        if (s && typeof s[0] === 'number') mph.push(s[0]);
      }
      if (!mph.length) continue;
      const rec = byRoad.get(roadId) || { roadId, name, sections: [] };
      rec.sections.push({
        direction: dir,
        sensors: mph.length,
        avgMph: +(mph.reduce((a, b) => a + b, 0) / mph.length).toFixed(1),
        minMph: Math.min(...mph),
        maxMph: Math.max(...mph),
      });
      byRoad.set(roadId, rec);
    }
    return {
      region: REGION,
      snapshotTime: new Date(live.updateTime || p.updateTime).toISOString(),
      version: p.version,
      highways: [...byRoad.values()],
      incidents: live.incidents?.length ?? 0,
    };
  }, REGION);
  return { data: JSON.stringify(result), type: 'application/json' };
};
```

Verified live 2026-07-07 (NoCal): 74 roads / 84 direction-sections / 131 incidents, all three endpoints 200. Re-run for a fresh snapshot (`path.json` rotates ~every 30 s, so always fetch it first inside the same `page.evaluate`, as above). This replaces the old raw HTTP-fetch transport.

### 5. (Optional) Cross-reference incidents to enrich highway entries

`incidents[i][3]` is a free-text location string like `"CA-1 South at Scott Creek"` or `"US-101 North at Marsh Rd"` — the only place in the dataset where the road **type prefix** (`I-`, `US-`, `CA-`) is present. Match by the bare route number (`"1"`, `"101"`) plus direction substring to attach incident lists to your per-highway rows. `incidents[i][2]` is the human-readable time ("1:01 PM") and `incidents[i][8]`/`[9]` are ISO timestamps (creation / last-update).

### Browser fallback

Only reach for a `page` if the JSON endpoints start returning 4xx (none observed in 4 successive fetches across NoCal + SoCal). Fallback with `browserless_agent`: load the embedded map, then read the resource timing log to discover the live URLs, then fetch them (still from `browserless_function` / Node, not the page — the map draws speeds into canvas tiles, not DOM text, so there is nothing to scrape visually):

```jsonc
{
  "rationale": "Reading Sigalert resource URLs",
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://www.sigalert.com/Custom/Map.asp?partner=kgo-tv&sp=p&th=blue&z=2",
        "waitUntil": "load",
      },
    },
    { "method": "waitForTimeout", "params": { "time": 3000 } },
    {
      "method": "evaluate",
      "params": {
        "content": "(()=>JSON.stringify(performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/NoCalData|NoCalStatic|path\\.json/.test(n))))()",
      },
    },
  ],
}
```

No proxy, no stealth — the iframe loads on a bare session and the JSON CDN has no anti-bot layer. But this only tells you the URLs; you still parse them with the `browserless_function` block above. In practice, skip the browser entirely.

## Site-Specific Gotchas

- **`abc7news.com/traffic/` itself contains no speed values.** The page is an article shell — the entire traffic display is one nested iframe (`www.sigalert.com/Custom/Map.asp?partner=kgo-tv`). Scraping the article's DOM or running text extraction on `abc7news.com/traffic/` returns only the "TRAFFIC NEWS" sidebar headlines, not MPH. Don't waste a turn there — go straight to the Sigalert endpoints.
- **The Sigalert map renders speeds into canvas tiles, not DOM text.** A `snapshot` of the loaded iframe returns ~20 a11y refs (UI chrome only) and zero MPH values. Clicking individual pushpins exposes a single sensor at a time via a tooltip — extremely expensive vs. the bulk JSON pull.
- **`path.json` rotates roughly every 30 seconds.** The `path` field cycles through 3–4 slots (`1~j`, `2~j`, `3~j`, ...) within the current build version (`~j`). Always re-fetch `path.json` before each `{Region}Data.json` pull; do not hard-code a path. If you get a stale-looking response, the `updateTime` ms-epoch field will tell you exactly when that snapshot was published.
- **`cb` cache-buster is mandatory.** Without `?cb=...` matching the value from `path.json`, the CDN may serve a cached older version. The cache-buster monotonically increases; treat it as opaque.
- **`Content-Type: text/javascript` on JSON responses is a JSONP-era artifact.** The body is valid JSON — `JSON.parse` it directly. Do not eval.
- **Parse the body as text, not via `res.json()`.** The JSON endpoints send `Content-Type: text/javascript` (a JSONP-era artifact). Node's `fetch(...).json()` may still accept it, but to be safe read `await res.text()` and `JSON.parse` it (as the `browserless_function` block does). `NoCalData.json` is ~408 KB — comfortably under the function's 200k-char text return cap only _after_ you reduce it to the per-highway summary; do the join inside the function and return the summary, not the raw bundle.
- **Road `displayName` strips the road-type prefix.** `roads[id][0]` is just `"1"` / `"101"` / `"580"` / `"880"` — there's no `"I-"` / `"US-"` / `"CA-"` qualifier. To know whether route 1 is "CA-1 / PCH" vs. "Highway 1", inspect `incidents[].location` strings (they include the prefix) or fall back to public route-classification data. Within California: 5/15/40/80/205/210/215/238/280/380/405/505/580/605/680/710/780/805/880/980 are Interstates; 50/97/101/199/395 are US routes; everything else (1, 4, 12, 13, 17, 24, 25, 33, 35, 37, 41, 46, 52, 60, 67, 84, 85, 87, 92, 99, 109, 113, 116, 121, 128, 129, 132, 152, 156, 160, 162, 174, 175, 183, 220, 237, 242, 280-prefixed mins, 4-digit local) is a `CA-` state route.
- **Per-direction sections.** `roadSections` lists each highway as 2 (or sometimes more — for highways that turn) rows: one per direction-of-travel. Aggregating sections together loses the directional asymmetry that's usually the whole point of a traffic query (e.g. northbound 101 at 25 MPH vs. southbound at 60 MPH at 5 PM). Keep the rows separate in output.
- **HOV lane speeds available separately.** `speeds[i][1]` is the HOV/carpool-lane MPH and is often higher than the general-purpose lanes during peak hours. It's frequently `null` outside HOV-equipped segments. Decide upfront whether your output reports general-purpose only, HOV separately, or merged.
- **Three regions on one backend.** Replace `NoCal` with `SoCal` (Greater Los Angeles) or `CenCal` (Central Valley) in **all three** URLs to query other regions. Same schema, same indirection, same JSON shape. Other ABC affiliates (KABC-TV in LA, KFSN-TV in Fresno) use the same partner-keyed iframe with a different region prefilled, but the underlying data API is region-keyed not partner-keyed — so you can directly query SoCal data even from an "abc7news.com" task context if needed.
- **`Custom/Map.asp` partner shells.** `partner=kgo-tv` is hard-wired to NoCal; `partner=kabc-tv`, `partner=kfsn-tv`, etc. exist but the `.asp` server-side render checks Referer/User-Agent and 500s from a plain fetch. This **does not affect** the JSON data endpoints, which are independent and need no partner key. Don't try to use the `partner=` URL as a data source.
- **Where you run the fetch matters for DNS.** A locally-sandboxed `curl` (restricted-DNS environments) can fail to resolve `www.sigalert.com`. Running the fetch inside `browserless_function` sidesteps that — the code executes on Browserless's egress, which resolves the sigalert hosts and has no CORS/auth/rate-limit in the way. From any runtime with plain internet, a vanilla `fetch`/`curl` also works; Browserless is just a convenient, DNS-clean egress here, not a bot-evasion requirement.
- **Region naming.** Probed region tokens: `NoCal` ✓, `SoCal` ✓, `CenCal` ✓, `Sacto` ✗ (404), `SD` / `SDiego` ✗ (404). San Diego is rolled into `SoCal`. Sacramento is rolled into `NoCal`.

## Expected Output

A single snapshot for one region, returned as JSON. Shape:

```json
{
  "region": "NoCal",
  "regionLabel": "San Francisco Bay Area",
  "snapshotTime": "2026-05-19T05:30:24.001Z",
  "version": 29400181,
  "highways": [
    {
      "roadId": 105803,
      "name": "580",
      "direction": "East",
      "sensors": 24,
      "avgMph": 58.4,
      "minMph": 22,
      "maxMph": 71,
      "freeFlowSpeedLimit": 65,
      "congested": false
    },
    {
      "roadId": 101011,
      "name": "101",
      "direction": "North",
      "sensors": 67,
      "avgMph": 27.3,
      "minMph": 9,
      "maxMph": 58,
      "freeFlowSpeedLimit": 65,
      "congested": true
    }
  ],
  "incidents": [
    {
      "id": 48449051,
      "severity": 519,
      "time": "1:01 PM",
      "createdAt": "2026-05-18T20:01:06",
      "updatedAt": "2026-05-18T23:09:08",
      "location": "CA-1 South at Scott Creek",
      "type": "Accident. Shoulder blocked",
      "road": "1",
      "direction": "South"
    }
  ],
  "cameraCount": 819
}
```

Optional richer shape — per-sensor MPH for downstream segment-level analysis:

```json
{
  "region": "NoCal",
  "highways": [
    {
      "roadId": 108801,
      "name": "880",
      "direction": "North",
      "sections": [
        { "sensorIndex": 4601, "name": "Marina Blvd", "mph": 62, "hovMph": 65 },
        { "sensorIndex": 4602, "name": "23rd Ave", "mph": 48, "hovMph": 58 }
      ]
    }
  ]
}
```

Failure / edge shapes:

```json
{
  "success": false,
  "reason": "region_not_supported",
  "region": "SD",
  "supported": ["NoCal", "SoCal", "CenCal"]
}
```

```json
{
  "success": false,
  "reason": "data_endpoint_unavailable",
  "lastPathFetchStatus": 503
}
```

In observed runs (4 successive fetches across NoCal + SoCal), every endpoint returned HTTP 200 with the expected schema; no anti-bot, captcha, or rate-limit response was encountered.
