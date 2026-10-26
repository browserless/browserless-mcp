# MCP Apps widget verification spike

Experimental code for comparing direct replay rendering with a two-call API:
prepare a result, then display it with `browserless_show({ viewRef })`. This is
not a production-ready integration. The standalone probe uses synthetic data
and identities, real Streamable HTTP MCP, the existing `defineTool` wrapper,
and the official MCP Apps `App`/`AppBridge` SDK. It never contacts an account or
production browser service. The root source changes contain the earlier direct
replay experiment; the probe registers its own tools instead.

## Run locally

From this checkout:

```sh
npm ci
npm run build
node spikes/widgets/server.mjs
```

Open **http://127.0.0.1:8790/probe**. Each top-level button prepares a result and
calls `browserless_show`. Replay, sessions, usage, and scorecard share one widget
resource. Refresh sessions or change the usage timeframe inside the widget.
The chunked replay button exercises widget-driven bulk loading.

The server binds to loopback. `Bearer local-alice` and `Bearer local-bob` are
synthetic fixture identities, not account credentials. The local host uses
`local-alice`. Stop the server with Ctrl+C.

## Test in ChatGPT through ngrok

With the server running, start a temporary tunnel:

```sh
ngrok http 8790
```

Create a ChatGPT connection named **Browserless Widget API Probe** using the
HTTPS URL printed by ngrok, followed by `/mcp?token=local-alice`. Choose
**No authentication**: the query parameter selects only a fixture identity.
Keep CSP enabled. Refresh the connection after changing tool metadata and use a
fresh chat to avoid cached descriptors.

Send each prompt separately:

1. **Replay:** “Call widget_probe_replay, then call browserless_show with the
   viewRef it returns.” Verify play, pause, and seeking.
2. **Sessions:** “Call widget_probe_sessions, then call browserless_show with
   the viewRef it returns.” Click Refresh twice. The revision should increase
   inside the same widget without another model turn or `browserless_show` call.
3. **Usage:** “Call widget_probe_usage with timeframe day, then call
   browserless_show with the viewRef it returns.” Switch to week. Expect
   **1680 / 2000 units (week)** in the same widget.
4. **Scorecard:** “Call widget_probe_performance, then call browserless_show
   with the viewRef it returns.” Expect performance 92/100, accessibility
   Unavailable, and SEO 78/100.
5. **Large replay:** “Call widget_probe_replay with large set to true, then
   call browserless_show with its returned viewRef. Let the widget load the data;
   do not fetch chunks yourself.” Verify that loading finishes and playback works.

All five cases have manual ChatGPT passes with CSP enabled, including refresh
and timeframe controls. See the checked-in [verification summary](verification.json).
The summary contains synthetic results only; raw tunnel logs are excluded.

## Tools

| Tool                                                     | Purpose                                    |
| -------------------------------------------------------- | ------------------------------------------ |
| `widget_probe_replay({ large?, paddingBytes? })`         | Prepare a replay or exact-boundary fixture |
| `widget_probe_sessions({})`                              | Prepare a numbered sessions snapshot       |
| `widget_probe_usage({ timeframe })`                      | Prepare hour/day/week totals               |
| `widget_probe_performance({})`                           | Prepare scores including a null value      |
| `browserless_show({ viewRef })`                          | Resolve an owned reference and display it  |
| `browserless_view_data({ viewRef, cursor?, encoding? })` | Read bounded data; app-only                |

Only `browserless_show` declares a UI resource. References survive transport
reconnects by the same synthetic owner. The store is temporary, process-local,
and bounded. It does not demonstrate shared storage.

## Automated verification

Supply an existing Chromium executable and Puppeteer installation. No browser
automation dependency is added to the application. `PUPPETEER_MODULE` accepts a
module name or absolute module path; it defaults to `puppeteer-core`.

```sh
CHROME_PATH="/path/to/chromium" PUPPETEER_MODULE="puppeteer-core" node spikes/widgets/check.mjs
```

The runner starts and stops its own isolated MCP server and Chromium. The
interactive server can stay running. Results and screenshots are written to the
ignored `spikes/widgets/evidence/` directory.

**14 grouped checks passed:** discovery and schemas; two-call rendering without
producer reruns; owner isolation and reconnect; no-UI text; exact Unicode
reconstruction over 47 bounded reads; gzip reconstruction and cross-encoding
cursor denial; complete-result boundaries at 2 MiB minus one byte, exactly 2 MiB,
and above; actual replay play/pause/seek under local enforced CSP; sessions
refresh and usage switching without remount; null scores; transient bridge-error
recovery; browser-native decompression; and exact expiry without extension.

## Findings and limits

The uncompressed 47-read replay failed twice in ChatGPT with connection errors,
although local checks and a public SDK client completed it. Bounded retries
recover one injected local failure in 48 attempts without repeating successful
pages. The external limiting component is not established.

The widget negotiates gzip through the same app-only reader using Node gzip and
browser-native `DecompressionStream`. The full 3,421,861-byte fixture becomes
9,046 gzip bytes in one 12,185-byte MCP result. Both the 128 KiB reply ceiling
and 50 MiB decoded ceiling remain enforced. The compressed replay loads and
plays in ChatGPT. This repeated fixture compresses unusually well; the result
does not establish reliability for incompressible data or many host calls.

The installed SDK rejects a bare top-level union without an object type in
`outputSchema`. An object-root schema through FastMCP's `jsonSchemaAdapter`
works with draft-7; its installed validator rejects Zod's default 2020-12 schema.
Production TypeScript integration must accommodate the wrapper's Zod-specific
type; the JavaScript probe does not prove it.

The local host has no LLM. Its widget CSP blocks connections, external assets,
and frame navigation, and permits bundled inline scripts/styles and data/blob
images. Its sandbox permits scripts and same-origin access. This does not
reproduce a production host's complete security policy.

Real account integrations, OAuth/revocation, Claude, video preview/Range access,
multi-replica resolution, restart durability, and a real-time 15-minute soak
remain unverified. These are diagnostic views, not finished product widgets.
