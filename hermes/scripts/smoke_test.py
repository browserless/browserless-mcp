"""No-LLM smoke test: drives Hermes' real browser tools through the installed Browserless plugin.

Run it with the Python interpreter of your Hermes install (BROWSERLESS_TOKEN exported), with HERMES_HOME
pointing at the Hermes home where the plugin is installed:
    HERMES_HOME=~/.hermes  /path/to/hermes/venv/bin/python hermes/scripts/smoke_test.py [--drop-upstream]

--drop-upstream kills the mux's Browserless socket mid-task and checks that the mux reconnects
and Hermes keeps working on the same page.
"""
import base64
import json
import os
import subprocess
import sys
import time

if not os.environ.get("HERMES_HOME"):
    sys.exit("Set HERMES_HOME first (the Hermes home the plugin is installed in).")
DROP = "--drop-upstream" in sys.argv
# --wait-before-drop N: idle N seconds first, so the drop lands after the initial keepalive window
WAIT = int(sys.argv[sys.argv.index("--wait-before-drop") + 1]) if "--wait-before-drop" in sys.argv else 0
TASK = "bl_smoke"
HTML = ('<!doctype html><title>Browserless smoke</title><button id="b" onclick="alert(`hi`);'
        'document.getElementById(`r`).textContent=`after-alert`">Say hi</button><p id="r">before</p>')
PAGE = "https://httpbin.org/base64/" + base64.urlsafe_b64encode(HTML.encode()).decode()

from tools import browser_tool as bt  # noqa: E402
from tools import browser_tool_session as bts  # noqa: E402
from tools.browser_supervisor import SUPERVISOR_REGISTRY  # noqa: E402
from tools.browser_tool_lifecycle import cleanup_browser  # noqa: E402

checks = {}


def check(name, ok, detail=""):
    checks[name] = bool(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}{('  -- ' + detail) if detail else ''}", flush=True)


def https_conns():
    out = subprocess.run(["lsof", "-nP", "-a", "-p", str(os.getpid()), "-iTCP", "-sTCP:ESTABLISHED"],
                         capture_output=True, text=True).stdout
    return len([l for l in out.splitlines() if "->" in l and l.split("->")[1].split()[0].endswith(":443")])


try:
    r = json.loads(bt.browser_navigate(PAGE, task_id=TASK))
    check("navigate", r.get("success"), r.get("error", ""))
    sess = bt._active_sessions.get(TASK, {})
    check("served by the browserless plugin (no silent local fallback)",
          sess.get("features", {}).get("browserless") and not sess.get("fallback_from_cloud"),
          f"features={sess.get('features')} fallback={sess.get('fallback_reason', '')}")
    from agent.browser_registry import get_provider
    provider = get_provider("browserless")
    mux = provider._muxes.get(sess.get("bb_session_id")) if provider else None
    time.sleep(1)
    sup = SUPERVISOR_REGISTRY.get(TASK)
    check("CDP supervisor connected through the mux", sup is not None and sup.cdp_url == sess.get("cdp_url"))

    r = json.loads(bt.browser_snapshot(task_id=TASK))
    ref = next((line.split("ref=")[1].split("]")[0] for line in r.get("snapshot", "").splitlines() if "Say hi" in line), None)
    check("snapshot shows the alert button", ref, r.get("snapshot", "")[:120])

    if DROP and mux:
        if WAIT:
            print(f"...idling {WAIT}s (past the keepalive window) before the drop", flush=True)
            time.sleep(WAIT)
        print("...dropping the mux's upstream Browserless socket", flush=True)
        mux.run_threadsafe(mux.up.close())
        time.sleep(3)
        r = json.loads(bt.browser_snapshot(task_id=TASK))
        if not r.get("success"):  # agent-browser may fail once while its socket is replaced
            print(f"   first snapshot after drop: {r.get('error')}", flush=True)
            r = json.loads(bt.browser_snapshot(task_id=TASK))
        check("after upstream drop: same page still there", r.get("success") and "Say hi" in r.get("snapshot", ""))
        check("after upstream drop: mux recovered", mux.stats.get("upstream_recovered") == 1, str(dict(mux.stats)))
        time.sleep(1)
        sup = SUPERVISOR_REGISTRY.get(TASK)

    t = time.monotonic()
    r = json.loads(bt.browser_click(ref, task_id=TASK))
    check("click alert button (no hang)", r.get("success") and time.monotonic() - t < 20, f"{time.monotonic() - t:.2f}s")
    time.sleep(1)
    r = json.loads(bt.browser_console(expression="document.getElementById('r').textContent", task_id=TASK))
    check("alert was handled and the page continued", r.get("result") == "after-alert", str(r.get("result")))

    shot = os.path.abspath("browserless_smoke.png")
    bts._run_browser_command(TASK, "screenshot", [shot])
    check("screenshot", os.path.exists(shot) and os.path.getsize(shot) > 0, shot)

    if mux:
        expected = 2 if DROP else 1
        check(f"mux used {expected} upstream connection(s) total", mux.upstream_connects == expected,
              f"upstream_connects={mux.upstream_connects}, downstream clients={mux.stats.get('clients_total')}")
        n = https_conns()
        check("exactly one live HTTPS connection from this process (the mux upstream)", n == 1, f"{n}")
finally:
    cleanup_browser(TASK)
    if "mux" in dir() and mux:
        check("session closed (mux stopped)", mux._loop.is_closed() or not mux._thread.is_alive())
        ep = getattr(mux.upstream, "endpoint", None)
        if ep:  # reconnect upstream: the remote browser must really be gone
            import asyncio
            import websockets
            from urllib.parse import urlencode

            async def probe():
                time.sleep(1.5)
                try:
                    ws = await websockets.connect(ep + "?" + urlencode({"token": mux.upstream.token}), open_timeout=20)
                    await ws.close()
                    return "still connectable"
                except websockets.InvalidStatus as e:
                    return f"HTTP {e.response.status_code}"
            res = asyncio.run(probe())
            check("Browserless browser terminated after cleanup", res == "HTTP 404", res)

print("\nRESULT:", "ALL PASS" if all(checks.values()) else "SOME CHECKS FAILED")
sys.exit(0 if all(checks.values()) else 1)
