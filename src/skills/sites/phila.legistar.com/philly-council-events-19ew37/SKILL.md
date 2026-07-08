---
name: philly-council-events
title: Philadelphia City Council Events
description: >-
  Extract Philadelphia City Council meetings (event name, date, time, body,
  location, agenda/minutes links) from the public Legistar Web API, with
  optional year and body filters. Returns a Zod-validated MeetingEvent[].
website: phila.legistar.com
category: government
tags:
  - legistar
  - civic-tech
  - city-council
  - philadelphia
  - calendar
  - odata
  - read-only
source: 'browserbase: agent-runtime 2026-05-26'
updated: '2026-05-26'
recommended_method: api
alternative_methods:
  - method: browser
    rationale: >-
      When the public Legistar Web API is unreachable from the runtime (network
      policy, hard outbound allow-list), fall back to driving
      phila.legistar.com/Calendar.aspx — change the year via the date-range
      ASP.NET WebForms dropdown, then parse the rendered grid. Slower (~100x)
      because filter state lives in __VIEWSTATE, not the URL.
verified: true
proxies: true
---

# Philadelphia City Council Events — Calendar Extraction

## Purpose

Return an array of Philadelphia City Council meetings — event name (meeting body), meeting date, meeting time, body, location, and links to agenda / minutes / iCal / meeting-detail — optionally filtered by year and/or by a specific body (e.g., `CITY COUNCIL`, `Committee on Finance`, `Committee of the Whole`). Output is shaped to validate cleanly against a Zod schema. Read-only — never click an iCal/Agenda link to submit anything; only follow links to read PDFs/HTML.

**Scope note.** "Philadelphia City Council events" is ambiguous between (a) **strictly** meetings of the `CITY COUNCIL` body and (b) **the council's full calendar** (City Council + all committees + joint committees + special committees). This skill defaults to (b) — the same superset the public `Calendar.aspx` page shows — and exposes an optional `body` filter for callers that want (a). Document which interpretation you applied if the caller didn't pin it.

## When to Use

- Building a yearly archive of all Philadelphia City Council and committee meetings.
- Monitoring upcoming agenda postings for a specific committee (e.g., Finance, Rules, Appropriations).
- Producing a Zod-validated `MeetingEvent[]` for downstream pipelines (calendar import, civic-tech dashboards, agenda-diff bots).
- Anywhere you'd otherwise scrape `phila.legistar.com/Calendar.aspx` — the public Legistar REST API is faster, more stable, and returns more fields than the rendered table.

## Workflow

phila.legistar.com is a [Granicus Legistar](https://www.granicus.com/) deployment and **exposes the standard Legistar Web API at `https://webapi.legistar.com/v1/phila/`**. No auth, no API key, no cookies, no anti-bot stealth required — returns 200 OK in <1s.

> **Transport note (Browserless):** The Legistar Web API is a plain HTTPS OData endpoint — the `curl`/HTTP examples below are canonical; run them from any client (Node `fetch`, Python `httpx`, `curl`). Only under restricted egress route the call via `browserless_function`: it runs in a browser page context, so `page.goto('https://webapi.legistar.com/')` first, then `page.evaluate` a **same-origin** `fetch('/v1/phila/Events?...')` (a page-context fetch here can set `Accept: application/json`, unlike a raw cross-origin browser fetch which the tenant CORS-blocks). Project/parse inside the eval; don't return multi-hundred-KB XML raw.

Lead with the API; the browser path works as a fallback but pays a ~100× cost premium (ASP.NET WebForms postbacks per filter change, ~154 rows for a full year requires sorting + table parsing). **Residential proxies are not required** but harmless.

### Recommended path — Legistar Web API (`webapi.legistar.com/v1/phila/Events`)

1. **Build the OData URL.** Base: `https://webapi.legistar.com/v1/phila/Events`. Compose query options:

   - **Year filter** — use the OData v3 `year()` function on `EventDate`:
     ```
     $filter=year(EventDate) eq 2026
     ```
   - **Body filter** (optional — only when caller asks for a specific body):
     ```
     $filter=EventBodyName eq 'CITY COUNCIL'
     ```
     The body name must match exactly, **case-sensitive** (`CITY COUNCIL` is uppercase; committees like `Committee on Finance` are mixed-case). Discover canonical names via `GET /v1/phila/Bodies` (enumerates `BodyId`, `BodyName`, `BodyTypeName`).
   - **Combined**:
     ```
     $filter=year(EventDate) eq 2026 and EventBodyName eq 'CITY COUNCIL'
     ```
   - **Date-range filter** (alternative to `year()`, e.g. for partial years):
     ```
     $filter=EventDate ge datetime'2026-01-01' and EventDate lt datetime'2027-01-01'
     ```
   - **Sort**: `$orderby=EventDate desc` (newest first) or `EventDate asc` (chronological).
   - **Pagination**: `$top=N` (page size) and `$skip=N` (offset). The API does not enforce a max; ~150 events per year is well within a single page.
   - **URL-encode `$` as `%24`** when your HTTP client mangles literal `$`. Most clients accept an unescaped `$` in the query string directly.

2. **Fetch the URL.** Example one-liner for a full-year, all-bodies pull, newest first:

   ```bash
   curl -s "https://webapi.legistar.com/v1/phila/Events?\$filter=year(EventDate)+eq+2026&\$orderby=EventDate+desc&\$top=500"
   ```

   (Under restricted egress, wrap the same URL in a `browserless_function` `page.goto` + same-origin `page.evaluate(fetch)` as noted above.) Response shape (default `application/xml; charset=utf-8`):

   ```xml
   <ArrayOfGranicusEvent xmlns="http://schemas.datacontract.org/2004/07/LegistarWebAPI.Models.v1">
     <GranicusEvent>
       <EventId>6383</EventId>
       <EventGuid>DAB5038D-4E7C-4547-8C4C-44B6166E5F8E</EventGuid>
       <EventBodyId>10</EventBodyId>
       <EventBodyName>CITY COUNCIL</EventBodyName>
       <EventDate>2026-05-28T00:00:00</EventDate>
       <EventTime>10:00 AM</EventTime>
       <EventLocation>Room 400, City Hall</EventLocation>
       <EventComment>PLEASE USE THE AGENDA PDF...</EventComment>
       <EventAgendaFile>https://philadelphia.legistar1.com/.../Calendar.pdf</EventAgendaFile>
       <EventAgendaStatusName>Final</EventAgendaStatusName>
       <EventMinutesFile i:nil="true"/>
       <EventMinutesStatusName>Draft</EventMinutesStatusName>
       <EventInSiteURL>https://phila.legistar.com/MeetingDetail.aspx?LEGID=6383&amp;GID=30&amp;G=...</EventInSiteURL>
       <EventItems/>
       <EventVideoStatus>Public</EventVideoStatus>
     </GranicusEvent>
     ...
   </ArrayOfGranicusEvent>
   ```

3. **Prefer JSON — set the `Accept` header.** Send `Accept: application/json` to receive a JSON array with the same field names. **Do not use `$format=json`** — the API rejects it (`Query option 'Format' is not allowed`). Any HTTP client (Node `fetch`, Python `httpx`, `curl -H 'Accept: application/json'`) gets JSON natively, and a `browserless_function` page-context `fetch('/v1/phila/Events?...', { headers: { Accept: 'application/json' } })` after navigating to the `webapi.legistar.com` origin can set the header too. If you can't negotiate JSON for some reason, parse the default XML.

4. **Combine `EventDate` + `EventTime` into a full timestamp.** `EventDate` is always midnight (e.g. `2026-05-28T00:00:00`); the wall-clock meeting time lives in the separate `EventTime` string (`"10:00 AM"`, `"1:30 PM"`, `"9:30 AM"`). Parse `EventTime` and overlay it onto `EventDate` in **America/New_York** (Philadelphia's local zone) to produce a single ISO-8601 instant. Don't naively concatenate the strings — `EventTime` is human-formatted, not 24-hour.

5. **Shape into the Zod-validated array.** Recommended schema:

   ```ts
   import { z } from 'zod';

   export const MeetingEvent = z.object({
     event_id: z.number().int(), // EventId
     event_guid: z.string().uuid(), // EventGuid (uppercase)
     name: z.string(), // EventBodyName — the body that is meeting
     body_id: z.number().int(), // EventBodyId
     body: z.string(), // alias of name (kept for backward-compat)
     date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // EventDate truncated to YYYY-MM-DD
     time: z.string(), // EventTime verbatim, e.g. "10:00 AM"
     datetime_local: z.string().datetime(), // ISO 8601 in America/New_York (no offset suffix)
     location: z.string().nullable(), // EventLocation
     comment: z.string().nullable(), // EventComment (e.g. "BUDGET", "PUBLIC COMMENT")
     agenda_url: z.string().url().nullable(), // EventAgendaFile
     agenda_status: z.enum(['Final', 'Draft', 'Other']).nullable(),
     minutes_url: z.string().url().nullable(), // EventMinutesFile
     minutes_status: z.enum(['Final', 'Draft', 'Other']).nullable(),
     ical_url: z.string().url(), // synth: phila.legistar.com/View.ashx?M=IC&ID={EventId}&GUID={EventGuid}
     detail_url: z.string().url(), // EventInSiteURL
     video_status: z.string().nullable(),
   });
   export const MeetingEvents = z.array(MeetingEvent);
   ```

   Synthesize `ical_url` as `https://phila.legistar.com/View.ashx?M=IC&ID={EventId}&GUID={EventGuid}` — these are the exact links the Calendar.aspx page exposes per row.

6. **Discover available bodies once, cache locally.** Hit `GET /v1/phila/Bodies` and persist `BodyId → BodyName` to avoid round-tripping for every body filter. Philadelphia has ~110 bodies; the canonical Council is `BodyId=10, BodyName="CITY COUNCIL", BodyTypeName="LEGISLATIVE BODY"`.

### Browser fallback (`phila.legistar.com/Calendar.aspx`)

Use this only if the Web API is unreachable from your runtime. The calendar page is an ASP.NET WebForms grid; **filter state lives in `__VIEWSTATE`**, not in the URL — there is no deep-link to "calendar showing 2025". Steps:

Run the fallback as one `browserless_agent` call whose `commands` array walks the whole flow (nav → filter clicks → extract) so the postback/ViewState session persists across steps. A residential `proxy: { proxy: "residential" }` is optional here — the page is not aggressively anti-bot — but harmless and defends against the rare Akamai-403 retry.

1. `{ "method": "goto", "params": { "url": "https://phila.legistar.com/Calendar.aspx", "waitUntil": "load", "timeout": 45000 } }`.
2. The page defaults to **"This Month"** (e.g. 18 records for May 2026). To get a full year, `click` the date-range combobox (the leftmost dropdown showing the current scope, label `Date Range Dropdown List`) → `waitForTimeout` for the listitem panel to render → `click` the target year (`2026`, `2025`, ..., back to `2000`), or one of the relative options (`This Year`, `Last Year`, `Last Month`, `Last Week`, `Today`, `Next Week`, `Next Month`, `Next Year`, `All Years`). Selecting a year triggers an ASP.NET postback that refreshes `gridCalendar` in place — the URL stays `/Calendar.aspx`.
3. (Optional) To narrow by body, `click` the second combobox (`Departments Dropdown List`, default text `City Council and All Committees`) and pick a specific committee from the long listitem panel. This also fires a postback.
4. After filters settle (typically 1–2s), capture data. Two reliable approaches:
   - **`{ "method": "evaluate", ... }` that parses the grid in-page** (preferred) — read `table[id*=gridCalendar]` and return a compact JSON array of rows; or a `{ "method": "text", "params": { "selector": "table[id*=gridCalendar]" } }` gives the calendar table as columns `Name | Meeting Date | (iCal) | Meeting Time | Meeting Location | Meeting Details | Agenda | Accessible Agenda | Agenda Packet | Minutes | Accessible Minutes`. Each row contains a `View.ashx?M=IC&ID=...&GUID=...` link (iCal), `MeetingDetail.aspx?ID=...&GUID=...` (details), `View.ashx?M=A&ID=...&GUID=...` (agenda PDF). Extract `ID` and `GUID` query params per row to reconstruct the same identifiers the API returns.
   - **`{ "method": "snapshot" }`** → each row is a `[N] row` with `cell` children — iterate the rows under `[N] tbody`, ignore the header row, and pull `cell` text in column order. Caveat: the a11y tree is extremely large for a full year (~150 rows × ~10 cols) and can exceed the result-size cap; prefer the in-page `evaluate`.
5. The "records" count is shown above the table as `<N> records` — parse it to know how many rows to expect.

The browser fallback's primary failure mode is **truncation when the row count exceeds the default page size**; the Legistar grid does client-side rendering of all rows, but the snapshot may exceed token budget for large years. Prefer the API.

## Site-Specific Gotchas

- **`webapi.legistar.com/v1/phila/` is the canonical Legistar REST API for this jurisdiction** — no auth, no cookies, no rate limit observed. The `phila` slug is the Granicus client identifier; other Legistar jurisdictions use the same URL shape with their own slug (e.g., `nyc`, `sfgov`, `chicago`). Discoverable by inspecting Legistar SDK docs or the page's `<meta>` tags.
- **`$format=json` is rejected** with `Query option 'Format' is not allowed`. To get JSON, set the `Accept: application/json` request header. Default response is XML (`application/xml; charset=utf-8`). Any HTTP client (`curl -H`, Node `fetch`, Python `httpx`) — or a `browserless_function` page-context `fetch` after navigating to the `webapi.legistar.com` origin — can negotiate JSON via the header.
- **OData v3 syntax — not v4.** Use `datetime'2026-01-01'` (with the `datetime` literal prefix and single quotes), not `2026-01-01T00:00:00Z`. The `year()`, `month()`, `day()` functions on date fields work as expected.
- **`/v1/phila/Events/$count` doesn't work the standard OData way** — the controller interprets `$count` as a literal `EventId` int and 400s with `EventId of non-nullable type 'System.Int32'`. To count rows, fetch with `$top=1000` and count the array client-side, or use `$orderby` + binary search if you need precise counts at scale.
- **Body-name matching is case-sensitive and exact.** `EventBodyName eq 'CITY COUNCIL'` matches; `'city council'` returns zero rows. Pull the canonical names from `GET /v1/phila/Bodies` and cache them.
- **`EventDate` is date-only at midnight; `EventTime` is a separate human-readable string.** Always combine the two against `America/New_York` to produce a real timestamp — don't trust either field in isolation. Example: `EventDate=2026-05-28T00:00:00`, `EventTime="10:00 AM"` → `2026-05-28T10:00:00-04:00`.
- **`EventGuid` is uppercase** in API responses (e.g. `DAB5038D-4E7C-4547-8C4C-44B6166E5F8E`) — the calendar grid uses the same uppercase form in `View.ashx?M=IC&ID={EventId}&GUID={EventGuid}`. Don't lowercase before constructing the iCal URL; the page is forgiving but the canonical form is upper.
- **Two interpretations of "City Council events".** The `CITY COUNCIL` body (BodyId=10) holds the formal legislative sessions only — typically Thursday mornings, ~30/year. The full council calendar (no body filter) includes 100+ committee meetings per year (Finance, Rules, Appropriations, Public Safety, Joint Committees, Special Committees, etc.). Pick one explicitly and document the choice.
- **`Calendar.aspx` filter state is in `__VIEWSTATE` — no URL parameters.** You cannot bookmark "2025 view" or share a deep-link to a filtered calendar. Every filter change is a WebForms postback against the form's serialized state. This is why the API is strongly preferred.
- **The `Date Range Dropdown List` defaults to "This Month"** — without changing it, the rendered grid shows only the current month (~15–25 rows). Year-scope queries always require a dropdown interaction first.
- **`EventItems`, `EventMedia`, `EventVideoPath` are usually `i:nil="true"`** in the list response. To get agenda items per event, hit `GET /v1/phila/Events/{EventId}/EventItems` (separate call) — but that's outside this skill's scope; this skill returns the calendar metadata only.
- **`EventAgendaFile` / `EventMinutesFile` may be `nil`** for upcoming meetings (agenda not yet posted) or recently-completed ones (minutes still in draft). Always check `EventAgendaStatusName` (`Final` / `Draft`) and `EventMinutesStatusName` before treating either URL as authoritative.
- **Meeting comments encode meaningful context.** `EventComment` carries values like `"BUDGET"` (budget hearing), `"PLEASE USE THE AGENDA PDF to select an item for PUBLIC COMMENT, not the MEETING DETAILS."` (public-comment instructions), `"Council President tabled meeting until ..."` (rescheduling notes). Surface these in your output rather than discarding.
- **Joint committees have long, human-readable body names** like `"Joint Committees on Legislative Oversight and Transportation & Public Utilities"`. Ampersands are literal `&` in XML — your parser must decode XML entities (`&amp;`) before validating against Zod.
- **No site-specific anti-bot wall observed.** One iteration of testing surfaced no captchas, IP blocks, WAF challenges, or rate-limits on either the REST API or `Calendar.aspx`. A residential `proxy` on the `browserless_agent` fallback is belt-and-suspenders, not mandatory.

## Expected Output

```json
[
  {
    "event_id": 6383,
    "event_guid": "DAB5038D-4E7C-4547-8C4C-44B6166E5F8E",
    "name": "CITY COUNCIL",
    "body_id": 10,
    "body": "CITY COUNCIL",
    "date": "2026-05-28",
    "time": "10:00 AM",
    "datetime_local": "2026-05-28T10:00:00",
    "location": "Room 400, City Hall",
    "comment": "PLEASE USE THE AGENDA PDF to select an item for PUBLIC COMMENT, not the MEETING DETAILS.",
    "agenda_url": "https://philadelphia.legistar1.com/philadelphia/meetings/2026/5/6383_A_CITY_COUNCIL_26-05-28_City_Council_Calendar.pdf",
    "agenda_status": "Final",
    "minutes_url": null,
    "minutes_status": "Draft",
    "ical_url": "https://phila.legistar.com/View.ashx?M=IC&ID=6383&GUID=DAB5038D-4E7C-4547-8C4C-44B6166E5F8E",
    "detail_url": "https://phila.legistar.com/MeetingDetail.aspx?LEGID=6383&GID=30&G=A5947DFE-5A17-435B-A57D-5F0923C2343D",
    "video_status": "Public"
  },
  {
    "event_id": 1409826,
    "event_guid": "F6B19F6A-828E-4C00-9DB6-FE3BE3FEF351",
    "name": "Committee on Licenses and Inspections",
    "body_id": 35,
    "body": "Committee on Licenses and Inspections",
    "date": "2026-05-27",
    "time": "1:30 PM",
    "datetime_local": "2026-05-27T13:30:00",
    "location": "Room 400, City Hall",
    "comment": null,
    "agenda_url": "https://philadelphia.legistar1.com/.../1409826_A_..._Agenda.pdf",
    "agenda_status": "Final",
    "minutes_url": null,
    "minutes_status": "Draft",
    "ical_url": "https://phila.legistar.com/View.ashx?M=IC&ID=1409826&GUID=F6B19F6A-828E-4C00-9DB6-FE3BE3FEF351",
    "detail_url": "https://phila.legistar.com/MeetingDetail.aspx?ID=1409826&GUID=F6B19F6A-828E-4C00-9DB6-FE3BE3FEF351&Options=info|&Search=",
    "video_status": "Public"
  }
]
```

Verified shapes observed during testing: 18 events for `This Month` (May 2026, no body filter), 154 events for `year(EventDate) eq 2025` (all bodies), single-row response for `year(EventDate) eq 2026 and EventBodyName eq 'CITY COUNCIL'` with `$top=1&$orderby=EventDate desc` returning the most recent `CITY COUNCIL` meeting (2026-05-28, 10:00 AM, Room 400). All shapes validate cleanly against the Zod schema above after combining `EventDate + EventTime` into `datetime_local`.
