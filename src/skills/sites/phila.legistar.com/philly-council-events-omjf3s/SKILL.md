---
name: philly-council-events
title: Philadelphia City Council Events
description: >-
  Extract Philadelphia City Council and committee meeting events from the
  Legistar calendar (phila.legistar.com), filterable by year and body. Returns a
  Zod-validated array of events with name, date, time, location, and
  agenda/minutes URLs. Read-only.
website: phila.legistar.com
category: government
tags:
  - government
  - legislative
  - philadelphia
  - legistar
  - calendar
  - civic-data
source: 'browserbase: agent-runtime 2026-05-20'
updated: '2026-05-20'
recommended_method: api
alternative_methods:
  - method: browser
    rationale: >-
      When the public Legistar WebAPI (webapi.legistar.com) is unreachable at
      the network layer, navigate phila.legistar.com/Calendar.aspx, change the
      Telerik year dropdown to the target year, and scrape the resulting
      RadGrid. Costs ~10x more turns and depends on unstable a11y refs across
      ASP.NET postbacks.
verified: false
proxies: true
---

# Philadelphia City Council Events — Browser Skill

## Purpose

Extract Philadelphia City Council meeting events (City Council + all standing/joint committees) from the Legistar calendar — returning each event's name (meeting body), date, time, location, agenda/minutes status, and Legistar detail-page URL. Filterable by year and/or by specific body. Read-only — never opens agenda PDFs in write-mode, never modifies state.

The output is a Zod-validated array of event records. A reference Zod schema is included in `Expected Output`.

## When to Use

- Building a roster of upcoming or historical City Council and committee meetings for a given year.
- Backfilling a database of Philadelphia legislative meetings (the catalog goes back to 2000).
- Cross-referencing agenda packets / minutes URLs with a specific meeting date + body.
- Anywhere you'd otherwise scrape `phila.legistar.com/Calendar.aspx` HTML — the public Granicus Legistar **WebAPI is faster, cheaper, paginatable, and structurally more reliable**.

## Workflow

The phila.legistar.com Calendar.aspx page is a Telerik RadGrid built on top of an **unauthenticated, public Granicus Legistar WebAPI** at `https://webapi.legistar.com/v1/phila/`. The browser UI is a thin client over this API — every record visible in the grid is queryable directly via OData. Lead with the API; the browser flow is the fallback for when the API is unreachable from your network (no auth, no anti-bot).

> **Transport note (Browserless):** The Legistar WebAPI is a plain HTTPS OData endpoint — the `GET` examples below are canonical; run them from any HTTP client (`curl`, Node `fetch`, Python `httpx`). Only under restricted egress route via `browserless_function`: `page.goto('https://webapi.legistar.com/')` first, then a **same-origin** `page.evaluate` fetch; parse/project inside the eval, don't return raw XML.

### Recommended — Legistar WebAPI

1. **Endpoint discovery.** The Philadelphia tenant slug is `phila`. The Events endpoint is:

   ```
   GET https://webapi.legistar.com/v1/phila/Events
   ```

   No API key, no cookies, no Referer required. Verified 2026-05-20 — Microsoft IIS/10.0 + `Granicusserver: gasmp-legapi1/2`, ASP.NET WebAPI OData v3.

2. **Filter by year.** OData v3 `$filter` syntax — the field is `EventDate` (datetime, midnight UTC):

   ```
   GET https://webapi.legistar.com/v1/phila/Events
       ?$filter=EventDate ge datetime'2025-01-01' and EventDate lt datetime'2026-01-01'
       &$orderby=EventDate
       &$top=200
   ```

   URL-encode the `$` as `%24` and the apostrophes/spaces as needed; literal `+` for spaces works inside `$filter`. The `datetime'YYYY-MM-DD'` literal is the supported OData v3 form (NOT `datetimeoffset'...'` — that 400s).

3. **Filter by body.** Each meeting carries `EventBodyId` (integer) and `EventBodyName` (string). To restrict to "CITY COUNCIL" only (no committees), add:

   ```
   and EventBodyId eq 10
   ```

   Bodies discovered 2026-05-20 (sample): `BodyId=10 → "CITY COUNCIL"`, `4 → "Committee on Public Health and Human Services"`, `39 → "Committee of the Whole"`, `44 → "Committee on Legislative Oversight"`, `50 → "Committee on Law and Government"`. The full body list is at `GET https://webapi.legistar.com/v1/phila/Bodies` (filter on `BodyActiveFlag eq 1` for currently-meeting bodies).

4. **Paginate.** Default page size for the Events endpoint is large but you should still cap with `$top` and step with `$skip` when iterating multi-year ranges:

   ```
   &$top=1000&$skip=0     # batch 1
   &$top=1000&$skip=1000  # batch 2
   ```

   2025 has 154 records (verified against the browser grid). A single `$top=1000` covers a full year safely.

5. **Parse the response.** **Default content-type is XML** (`application/xml; charset=utf-8`) — the OData `$format` query option is rejected (`"Query option 'Format' is not allowed"`), and the `Accept: application/json` header is silently ignored on this tenant (still returns XML). Parse the XML envelope `<ArrayOfGranicusEvent>` → `<GranicusEvent>` elements with these fields:

   | XML element              | Type                               | Maps to                                                                                            |
   | ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
   | `EventId`                | int                                | Stable meeting ID (e.g. `6115`)                                                                    |
   | `EventGuid`              | UUID                               | Alternate stable ID                                                                                |
   | `EventBodyId`            | int                                | See body-id table above                                                                            |
   | `EventBodyName`          | string                             | Meeting body / committee name                                                                      |
   | `EventDate`              | ISO datetime (date-only, midnight) | Meeting date                                                                                       |
   | `EventTime`              | string                             | Display time, e.g. `"10:00 AM"`, `"2:00 PM"`                                                       |
   | `EventLocation`          | string                             | e.g. `"Room 400, City Hall"`                                                                       |
   | `EventAgendaFile`        | URL or nil                         | Agenda PDF (may be `i:nil="true"`)                                                                 |
   | `EventAgendaStatusName`  | string                             | `"Final"` / `"Draft"`                                                                              |
   | `EventMinutesFile`       | URL or nil                         | Minutes PDF                                                                                        |
   | `EventMinutesStatusName` | string                             | `"Final"` / `"Draft"`                                                                              |
   | `EventComment`           | string or nil                      | Free-text annotations (cancellations, tabled-until notes)                                          |
   | `EventInSiteURL`         | URL                                | Legistar detail page: `https://phila.legistar.com/MeetingDetail.aspx?LEGID={EventId}&GID=30&G=...` |
   | `EventVideoStatus`       | string                             | `"Public"` etc.                                                                                    |
   | `EventVideoPath`         | URL or nil                         | Recorded-video URL                                                                                 |

6. **Zod-validate.** See the schema in `Expected Output`. Coerce `EventDate` to `Date`, parse `EventTime` separately, treat any element with `i:nil="true"` attribute as `null`.

### Browser fallback

Only use this when the WebAPI is blocked at the network layer (e.g. some sandboxes refuse outbound DNS for `webapi.legistar.com`). A residential proxy reaches `webapi.legistar.com` over the same egress it uses for `phila.legistar.com`, so if the browser can load the calendar the API is almost always reachable too — try the API path first.

Run the entire flow — open → change the year filter → extract → paginate — inside a **single** `browserless_agent` call. The session persists across calls (keyed by `proxy`, or by the default config when no proxy is set), but batching every step into one `commands` array is the convenient default: it preserves cookies and the ASP.NET postback/ViewState across them without round-trips. If you do split across calls, carry the same config so you reconnect to the same session. No stealth/anti-bot handling is needed (no Akamai, no Cloudflare). Add a residential proxy only if your egress is rate-limited — otherwise omit `proxy` entirely.

Call shape:

```jsonc
{
  // proxy is OPTIONAL — include only if your egress is rate-limited:
  "proxy": { "proxy": "residential", "proxyCountry": "us" },
  "commands": [
    {
      "method": "goto",
      "params": {
        "url": "https://phila.legistar.com/Calendar.aspx",
        "waitUntil": "load",
        "timeout": 45000,
      },
    },
    { "method": "waitForTimeout", "params": { "time": 2000 } },
    { "method": "snapshot" },
    // ...year filter + grid extraction, see steps below
  ],
}
```

1. **Open the calendar.** The first two commands above load `Calendar.aspx` (`waitUntil: "load"` — never `networkidle`, the RadGrid keeps sockets warm) and settle for 2s. Default state: `Calendar Year = "This Month"`, `Body = "City Council and All Committees"`. The grid is a Telerik RadGrid (`#ctl00_ContentPlaceHolder1_gridCalendar`) inside an ASP.NET WebForms postback model.

2. **Locate the controls.** A `{ "method": "snapshot" }` returns the a11y tree; read it to find the Year combobox `select` cell and the target-year option (on a fresh page the year select landed near ref `~117`, but **refs are NOT stable across postbacks** — always re-`snapshot` before each `click`). Because every Telerik interaction regenerates the whole tree, the robust pattern is: `snapshot` → `click` the year `select` → `waitForTimeout` → `click` the year option → `waitForTimeout` (full postback) → `waitForSelector` on the grid → `evaluate` to scrape. Chain them in the one `commands` array:

   ```jsonc
   { "method": "click", "params": { "selector": "<year-select-cell>" } },   // confirm the selector/ref via the preceding snapshot
   { "method": "waitForTimeout", "params": { "time": 1500 } },
   { "method": "click", "params": { "selector": "<year-option>" } },        // e.g. the "2025" listitem
   { "method": "waitForTimeout", "params": { "time": 3000 } },              // full ASP.NET __doPostBack
   { "method": "waitForSelector", "params": { "selector": "#ctl00_ContentPlaceHolder1_gridCalendar", "timeout": 10000 } }
   ```

3. **Year options.** `All Years`, `2026`, `2025`, ..., `2000`, `Last Year`, `Last Month`, `Last Week`, `This Year`, `This Month`, `This Week`, `Today`, `Next Week`, `Next Month`, `Next Year`. Pick the target-year listitem from the snapshot and `click` it; the page does a full ASP.NET postback, so allow ~3000ms before scraping.

4. **Extract the grid** with an `evaluate` that parses in-page and returns a compact JSON projection (never ship raw grid HTML). Each grid row holds 11 cells in order: BodyName, MeetingDate, ExportToCalendar (iCal), MeetingTime, MeetingLocation, MeetingDetails (link), Agenda (link or "Not available"), AccessibleAgendaHTML, AgendaPacket, Minutes, AccessibleMinutesHTML. Read the record-count header to validate completeness before trusting the row set:

   ```jsonc
   {
     "method": "evaluate",
     "params": {
       "content": "(() => { const grid = document.querySelector('#ctl00_ContentPlaceHolder1_gridCalendar'); const rows = [...grid.querySelectorAll('tr.rgRow, tr.rgAltRow')].map(tr => { const c = [...tr.querySelectorAll('td')].map(td => td.innerText.trim()); const link = sel => { const a = tr.querySelector(sel); return a ? a.href : null; }; return { bodyName: c[0], date: c[1], time: c[3], location: c[4], detailUrl: link('td:nth-child(6) a'), agendaFile: link('td:nth-child(7) a'), minutesFile: link('td:nth-child(10) a') }; }); const countEl = document.querySelector('.rgWrap.rgInfoPart, .rgPagerCell .rgInfoPart'); const recordCount = countEl ? countEl.innerText.trim() : null; return JSON.stringify({ recordCount, rows }); })()",
     },
   }
   ```

   The result comes back under `.value` as a JSON string — parse it, then map into the `Expected Output` schema (the grid exposes fewer fields than the WebAPI; `eventGuid`, `videoStatus`, agenda/minutes status enums, and `comment` may need to be filled from the detail page or left null).

5. **Paginate.** The grid defaults to 100 rows per page. If the record count > 100, append a `click` on the pager's "Next page" control (confirm the selector via `snapshot`), a `waitForTimeout`, then another `evaluate` — all still inside the same call. 2025 = 154 records = 2 pages.

6. **Body filter (optional).** Same pattern as the year: `click` the Body combobox `select` cell, then `click` the desired body listitem (the Body dropdown is ~115 options long — standing, joint, and special committees). Re-`snapshot` first, since the postback regenerated the refs.

7. **No release step.** There is nothing to release. The session persists across calls, keyed by `proxy` (or the default config when no proxy is set). Keeping the open → filter → extract → paginate sequence in one `commands` array preserves the ViewState/cookies across the postbacks without round-trips; if you split it across calls, carry the same config so you reconnect to the same warmed session rather than landing back on the default "This Month" state.

## Site-Specific Gotchas

- **No JSON.** `$format=json` query option is explicitly rejected by the Granicus WebAPI (`"Query option 'Format' is not allowed"` 400). The `Accept: application/json` header is silently ignored. Parse XML. Don't waste time looking for a JSON toggle — there isn't one.
- **`$inlinecount=allpages` is rejected** on Events. To get a total count, fetch with `$top=1000` and count entries in the response (or scrape the browser grid's `menuitem: NNN records` header). Verified 2026-05-20 — `$inlinecount` returns 200 but the count metadata is not present in the XML output.
- **OData v3 datetime literal form.** Use `datetime'2025-01-01'` (no time portion, no Z, no offset). `datetimeoffset'...'` 400s. ISO-8601 raw strings 400.
- **`EventDate` is date-only (midnight UTC).** The actual meeting wall-clock time is in `EventTime` as a display string (`"10:00 AM"`). To produce a single canonical timestamp, combine `EventDate` + `EventTime` in America/New_York (Philadelphia's timezone) — do NOT add `EventTime` to `EventDate` as UTC.
- **`i:nil="true"` attribute = null.** Any GranicusEvent field can be empty; the API marks empties with `<EventAgendaFile i:nil="true" />` rather than omitting the element. Map to `null` in your Zod schema.
- **Browser refs are NOT stable across postbacks.** Every Telerik RadComboBox interaction is a full ASP.NET `__doPostBack`, which regenerates the entire a11y tree (the grid snapshot grew from ~940 to ~5306 nodes after a single year-filter click). Always insert a fresh `snapshot` command before each `click` in the fallback flow.
- **Default page state is "This Month".** First page load returns 2 records (the current week's meetings). Don't conclude "the calendar is empty" — change the year filter to `All` or a specific year first.
- **Body dropdown is ~115 entries** including standing committees, joint committees ("Joint Committees on X and Y"), and special committees. The full enum is in the `RadComboBox` `itemData` array embedded in Calendar.aspx HTML; the WebAPI `Bodies` endpoint is the canonical list (filter `BodyActiveFlag eq 1, BodyMeetFlag eq 1` for currently-meeting bodies).
- **Cookie-based settings.** Calendar.aspx persists filter state in cookies (`Setting-30-Calendar Year`, `Setting-30-Calendar Body`, `Setting-30-Calendar Options`). These travel across page reloads in the same session. Useful if you want to lock a year selection without re-clicking the dropdown — but irrelevant when using the WebAPI.
- **`EventInSiteURL` includes session-bound parameters.** The `G=A5947DFE-...` GUID is a tenant-static identifier, NOT a per-user session token — safe to cache and reuse across runs. The `LEGID=` parameter is the canonical `EventId`.
- **`EventComment` carries meeting-state metadata.** Look for strings like `"No Calendar for Today"`, `"Council President tabled meeting until ..."`, `"CANCELLED"`. The grid UI displays these as inline notes. Surface them in the output schema so consumers can distinguish a scheduled-but-cancelled meeting from one that actually occurred.
- **Joint committees have free-text names in the dropdown but normalized names in the API.** The Calendar.aspx itemData has explicit `text` overrides like `"Joint Committees on Children & Youth and Education"` for some joint bodies; the WebAPI returns the same string in `EventBodyName`. Treat `EventBodyName` as the source of truth.
- **Catalog depth.** Years 2000 through 2026 are queryable. Pre-2000 events return empty.

## Expected Output

A Zod-validated array of event records:

```typescript
import { z } from 'zod';

export const PhilaCouncilEventSchema = z.object({
  eventId: z.number().int(),
  eventGuid: z.string().uuid(),
  bodyId: z.number().int(),
  bodyName: z.string(), // e.g. "CITY COUNCIL", "Committee on Law and Government"
  date: z.coerce.date(), // EventDate, midnight UTC
  time: z.string(), // EventTime display string, e.g. "10:00 AM"
  location: z.string(), // e.g. "Room 400, City Hall"
  agendaFile: z.string().url().nullable(),
  agendaStatus: z.enum(['Draft', 'Final']),
  minutesFile: z.string().url().nullable(),
  minutesStatus: z.enum(['Draft', 'Final']),
  comment: z.string().nullable(), // e.g. "CANCELLED", "tabled until ..."
  videoStatus: z.string(), // e.g. "Public"
  videoPath: z.string().url().nullable(),
  detailUrl: z.string().url(), // EventInSiteURL
});

export const PhilaCouncilEventsSchema = z.array(PhilaCouncilEventSchema);
```

Example output (2 records from year=2025):

```json
[
  {
    "eventId": 6115,
    "eventGuid": "0C3EC3DE-5220-4E73-8D14-47FA1D2C4EFA",
    "bodyId": 50,
    "bodyName": "Committee on Law and Government",
    "date": "2025-01-22T00:00:00.000Z",
    "time": "10:00 AM",
    "location": "Room 400, City Hall",
    "agendaFile": "https://philadelphia.legistar1.com/philadelphia/meetings/2025/1/6115_A_Committee_on_Law_and_Government_25-01-22_Public_Hearing_Notice.pdf",
    "agendaStatus": "Final",
    "minutesFile": null,
    "minutesStatus": "Draft",
    "comment": null,
    "videoStatus": "Public",
    "videoPath": null,
    "detailUrl": "https://phila.legistar.com/MeetingDetail.aspx?LEGID=6115&GID=30&G=A5947DFE-5A17-435B-A57D-5F0923C2343D"
  },
  {
    "eventId": 6093,
    "eventGuid": "BCAFB815-DC0D-4423-AAFE-44150A03BBFA",
    "bodyId": 10,
    "bodyName": "CITY COUNCIL",
    "date": "2025-01-23T00:00:00.000Z",
    "time": "10:00 AM",
    "location": "Room 400, City Hall",
    "agendaFile": "https://philadelphia.legistar1.com/philadelphia/meetings/2025/1/6093_A_CITY_COUNCIL_25-01-23_City_Council_Calendar.pdf",
    "agendaStatus": "Final",
    "minutesFile": "https://philadelphia.legistar1.com/philadelphia/meetings/2025/1/6093_M_CITY_COUNCIL_25-01-23_Meeting_Minutes_%28Long%29.pdf",
    "minutesStatus": "Final",
    "comment": null,
    "videoStatus": "Public",
    "videoPath": null,
    "detailUrl": "https://phila.legistar.com/MeetingDetail.aspx?LEGID=6093&GID=30&G=A5947DFE-5A17-435B-A57D-5F0923C2343D"
  }
]
```

If the requested year has no events (e.g., a year before 2000), return `[]`.
