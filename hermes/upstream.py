"""Browserless upstreams for the CDP mux.

ReconnectUpstream (default): ``/chromium`` + ``Browserless.reconnect``.
  * The keepalive is an absolute deadline (arm time + timeout), so it is re-armed periodically.
  * The reconnect endpoint can change after a deadline lapses -> always use the latest one.
  * ``Browser.close`` is ignored on an armed connection -> disarm (timeout 0) first.
  * 404 on the reconnect endpoint means the browser is gone.
SessionApiUpstream (fallback): ``POST /session`` -> ``connect`` (single client) / ``DELETE stop``.
"""
import asyncio
import json
import re
from urllib.parse import urlencode

import requests
import websockets

from .mux import UpstreamGone

_TOKEN_RE = re.compile(r"(token=)[^&\s\"'<>]+")


def redact(s):
    return _TOKEN_RE.sub(r"\1***", str(s))


class ReconnectUnavailable(Exception):
    pass


class UpstreamHTTPError(ConnectionError):
    """Browserless refused the connection/request with an HTTP status."""

    def __init__(self, status, body):
        self.status, self.body = status, body
        super().__init__(f"HTTP {status} {body}")


def plan_max_timeout(body):
    """Browserless' 400 for a too-long session names the plan maximum:
    "... must be a whole number of milliseconds between 1 and 120,000 (your plan's maximum ...)"."""
    m = re.search(r"between 1 and ([\d,]+)", body or "")
    return int(m.group(1).replace(",", "")) if m else None


async def _ws_connect(url):
    try:
        return await websockets.connect(url, max_size=None, ping_interval=None, open_timeout=30)
    except websockets.InvalidStatus as e:
        status = e.response.status_code
        body = redact(e.response.body[:300].decode(errors="replace").strip())
        if status == 404:
            raise UpstreamGone(f"HTTP 404 {body}") from None
        if status == 429:
            await asyncio.sleep(1)  # documented short-lived lock; back off a little extra
        raise UpstreamHTTPError(status, body) from None


def _with_token(url, token):
    return url + ("&" if "?" in url else "?") + urlencode({"token": token})


class ReconnectUpstream:
    def __init__(self, ws_base, token, session_timeout_ms, keepalive_ms, launch_query=None, route="/chromium",
                 log=print):
        self.ws_base = ws_base.rstrip("/")
        self.route = route
        self.token = token
        self.session_timeout_ms = session_timeout_ms
        self.keepalive_ms = keepalive_ms
        self.maintain_interval = max(5.0, keepalive_ms / 1000 / 3)  # re-arm at ~1/3 of the window
        self.launch_query = launch_query or {}
        self.log = log
        self.endpoint = None
        self.kind = "reconnect"

    async def connect(self):
        if self.endpoint is not None:
            return await _ws_connect(_with_token(self.endpoint, self.token))
        for _ in range(3):
            q = {"token": self.token, "timeout": self.session_timeout_ms, **self.launch_query}
            try:
                return await _ws_connect(f"{self.ws_base}{self.route}?{urlencode(q)}")
            except (UpstreamHTTPError, UpstreamGone) as e:
                status = getattr(e, "status", 404)
                if self.route != "/chromium" and (status == 404 or "stealth" in str(e).lower()):
                    self.log(f"upstream: {self.route} not available ({str(e)[:120]}); using /chromium (no stealth)")
                    self.route = "/chromium"
                    continue
                if isinstance(e, UpstreamGone):
                    raise
                cap = plan_max_timeout(e.body) if e.status == 400 and "timeout" in e.body.lower() else None
                if not cap or cap >= self.session_timeout_ms:
                    raise
                self.log(f"upstream: plan allows at most {cap} ms per session; using that instead of "
                         f"{self.session_timeout_ms} ms")
                self.session_timeout_ms = cap
        raise RuntimeError("could not agree on a session timeout with Browserless")

    async def _arm(self, mux, timeout_ms):
        infos = (await mux.internal("Target.getTargets"))["result"]["targetInfos"]
        page = next((t for t in infos if t["type"] == "page"), None)
        if page is None:
            page = (await mux.internal("Target.createTarget", {"url": "about:blank"}))["result"]
        att = await mux.internal("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True})
        if "error" in att:
            raise RuntimeError(f"attach for arming failed: {att['error']}")
        sid = att["result"]["sessionId"]
        try:
            res = await mux.internal("Browserless.reconnect", {"timeout": timeout_ms}, session=sid)
        finally:
            try:
                await mux.internal("Target.detachFromTarget", {"sessionId": sid}, timeout=5)
            except Exception:  # noqa: BLE001
                pass
        r = res.get("result") or {}
        if "error" in res or r.get("error") or not r.get("browserWSEndpoint"):
            raise ReconnectUnavailable(json.dumps(res.get("error") or r.get("error")))
        if r["browserWSEndpoint"] != self.endpoint:
            self.log(f"upstream: reconnect endpoint {'set' if self.endpoint is None else 'CHANGED'}")
        self.endpoint = r["browserWSEndpoint"]

    async def after_connect(self, mux):
        try:
            await self._arm(mux, self.keepalive_ms)
        except ReconnectUnavailable:
            if self.endpoint is None:  # first connection: kill the un-armed browser we just launched
                try:
                    await mux.internal("Browser.close", timeout=5)
                except Exception:  # noqa: BLE001
                    pass
            raise

    async def maintain(self, mux):
        await self._arm(mux, self.keepalive_ms)

    async def shutdown(self, mux):
        if not mux.upstream_open():
            if mux.dead:
                self.log("upstream: Browserless browser already gone; nothing to close")
            elif self.endpoint is not None:
                self.log(f"upstream: socket already closed; any leftover browser ends within "
                         f"{self.keepalive_ms // 1000} s (keepalive)")
            return
        await self._arm(mux, 0)  # disarm, otherwise Browser.close is ignored
        try:
            await mux.internal("Browser.close", timeout=5)
        except Exception:  # noqa: BLE001  (the socket usually drops before the reply)
            pass


class SessionApiUpstream:
    def __init__(self, http_base, token, session_timeout_ms, keepalive_ms, log=print):
        self.http_base = http_base.rstrip("/")
        self.token = token
        self.session_timeout_ms = session_timeout_ms
        self.keepalive_ms = keepalive_ms
        self.maintain_interval = None
        self.log = log
        self.info = None
        self.kind = "session"

    async def connect(self):
        if self.info is None:
            for _ in range(2):
                r = await asyncio.to_thread(
                    requests.post, f"{self.http_base}/session", params={"token": self.token},
                    json={"ttl": self.session_timeout_ms, "processKeepAlive": self.keepalive_ms}, timeout=30)
                cap = plan_max_timeout(r.text) if r.status_code == 400 else None
                if cap and cap < self.session_timeout_ms:
                    self.log(f"upstream: plan allows at most {cap} ms per session; using that")
                    self.session_timeout_ms = cap
                    continue
                break
            if not r.ok:
                raise UpstreamHTTPError(r.status_code, redact(r.text[:300]))
            self.info = r.json()
            self.log(f"upstream: session API session {self.info['id'][:12]}… created")
        url = self.info["connect"]
        return await _ws_connect(url if "token=" in url else _with_token(url, self.token))

    async def after_connect(self, mux):
        return None

    async def maintain(self, mux):
        return None

    async def shutdown(self, mux):
        if not self.info:
            return
        stop = self.info["stop"]
        stop = stop if "token=" in stop else _with_token(stop, self.token)
        r = await asyncio.to_thread(requests.delete, stop + "&force=true", timeout=15)
        self.log(f"upstream: DELETE session -> HTTP {r.status_code}")
