"""Browserless browser provider for Hermes.

``create_session`` launches a Browserless browser and starts a local CDP multiplexer in front of it
(background thread). Hermes gets the mux URL, so every Hermes CDP client (agent-browser daemon, CDP
supervisor, ...) shares ONE upstream Browserless connection and the API token never leaves this process.

Config (env or $HERMES_HOME/.env):
  BROWSERLESS_TOKEN                required (BROWSERLESS_API_TOKEN / BROWSERLESS_API_KEY also accepted)
  BROWSERLESS_BASE_URL             default https://production-sfo.browserless.io
  BROWSERLESS_UPSTREAM             auto (default) | reconnect | session
  BROWSERLESS_SESSION_TIMEOUT_MS   max browser lifetime, default 600000
  BROWSERLESS_KEEPALIVE_MS         how long the browser survives with no connection, default 60000
  BROWSERLESS_STEALTH              true (default) | false  -- stealth route (/chromium/stealth)
  BROWSERLESS_PROXY                residential | (empty, default)  -- residential proxy (uses more plan units)
  BROWSERLESS_PROXY_COUNTRY        e.g. us, gb, de  (with BROWSERLESS_PROXY)
  BROWSERLESS_PROXY_STICKY         true (default) | false  -- keep the same proxy IP for the whole session
  BROWSERLESS_BLOCK_ADS            false (default) | true
  BROWSERLESS_SOLVE_CAPTCHAS       false (default) | true  -- Browserless auto-solves captchas it detects
  BROWSERLESS_EXTRA_QUERY          extra launch params appended as-is, e.g. "humanlike=true"
  BROWSERLESS_MUX_LOG              optional file path for a mux trace (token redacted)
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from typing import Any, Dict, Optional

from agent.browser_provider import BrowserProvider

from .mux import Mux
from .upstream import ReconnectUnavailable, ReconnectUpstream, SessionApiUpstream, UpstreamHTTPError, redact

logger = logging.getLogger(__name__)
_DEFAULT_BASE = "https://production-sfo.browserless.io"
_EXPIRY_MARGIN_S = 3  # let Hermes replace the session just before Browserless ends it


def _explain(e: Exception) -> str:
    """Plain-language reason for a failed session start (Hermes shows/logs it as the fallback reason)."""
    if isinstance(e, UpstreamHTTPError):
        if e.status in (401, 403):
            return f"Browserless rejected the API token (HTTP {e.status}). Check BROWSERLESS_TOKEN."
        if e.status == 429:
            return "Browserless plan concurrency limit reached (HTTP 429): too many browsers open at once."
        return f"Browserless refused the session: {e}"
    return f"{type(e).__name__}: {e}"


def _setting(name: str, default: Optional[str] = None) -> Optional[str]:
    try:
        from agent.secret_scope import get_secret
        val = get_secret(name, None)
    except Exception:  # noqa: BLE001  (fail-closed scope errors -> fall back to the process env)
        val = None
    if val is None:
        val = os.environ.get(name, default)
    return val if val not in ("", None) else default


def _bool_setting(name: str, default: bool) -> bool:
    val = _setting(name)
    return default if val is None else val.strip().lower() in ("1", "true", "yes", "on")


def _launch_options() -> tuple:
    """(route, query params, features) for the Browserless launch, from settings."""
    stealth = _bool_setting("BROWSERLESS_STEALTH", True)
    query: Dict[str, str] = {}
    proxy = (_setting("BROWSERLESS_PROXY") or "").strip().lower()
    if proxy:
        query["proxy"] = proxy
        country = (_setting("BROWSERLESS_PROXY_COUNTRY") or "").strip().lower()
        if country:
            query["proxyCountry"] = country
        if _bool_setting("BROWSERLESS_PROXY_STICKY", True):
            query["proxySticky"] = "true"
    if _bool_setting("BROWSERLESS_BLOCK_ADS", False):
        query["blockAds"] = "true"
    if _bool_setting("BROWSERLESS_SOLVE_CAPTCHAS", False):
        query["solveCaptchas"] = "true"
    extra = _setting("BROWSERLESS_EXTRA_QUERY")
    if extra:
        from urllib.parse import parse_qsl
        query.update({k: v for k, v in parse_qsl(extra.lstrip("?&"), keep_blank_values=True) if k != "token"})
    features = {"stealth": stealth, "proxies": bool(proxy), "block_ads": query.get("blockAds") == "true",
                "solve_captchas": query.get("solveCaptchas") == "true"}
    return ("/chromium/stealth" if stealth else "/chromium"), query, features


def _token() -> Optional[str]:
    for name in ("BROWSERLESS_TOKEN", "BROWSERLESS_API_TOKEN", "BROWSERLESS_API_KEY"):
        val = _setting(name)
        if val:
            return val
    return None


def _int_setting(name: str, default: int) -> int:
    try:
        return int(_setting(name, str(default)))
    except (TypeError, ValueError):
        return default


class BrowserlessBrowserProvider(BrowserProvider):
    def __init__(self) -> None:
        self._muxes: Dict[str, Mux] = {}
        self._lock = threading.Lock()

    @property
    def name(self) -> str:
        return "browserless"

    @property
    def display_name(self) -> str:
        return "Browserless"

    def is_available(self) -> bool:
        return bool(_token())

    def _trace(self, msg: str) -> None:
        line = redact(msg)
        logger.info(line)
        path = _setting("BROWSERLESS_MUX_LOG")
        if path:
            with open(path, "a") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {line}\n")

    def create_session(self, task_id: str) -> Dict[str, object]:
        try:
            return self._create_session(task_id)
        except Exception as e:
            reason = redact(_explain(e))
            # Hermes falls back to local Chrome on any failure; make the reason visible in our log too.
            self._trace(f"create_session(task_id={task_id}) FAILED: {reason} -> Hermes will use local Chrome instead")
            raise RuntimeError(reason) from e

    def _create_session(self, task_id: str) -> Dict[str, object]:
        token = _token()
        if not token:
            raise ValueError("BROWSERLESS_TOKEN is required (https://www.browserless.io/account)")
        base = _setting("BROWSERLESS_BASE_URL", _DEFAULT_BASE).rstrip("/")
        ws_base = "wss://" + base.split("://", 1)[-1] if base.startswith("https") else "ws://" + base.split("://", 1)[-1]
        mode = (_setting("BROWSERLESS_UPSTREAM", "auto") or "auto").lower()
        timeout_ms = _int_setting("BROWSERLESS_SESSION_TIMEOUT_MS", 600000)
        keepalive_ms = _int_setting("BROWSERLESS_KEEPALIVE_MS", 60000)

        route, query, features = _launch_options()
        mux = None
        started = time.time()
        if mode in ("auto", "reconnect"):
            mux = Mux(ReconnectUpstream(ws_base, token, timeout_ms, keepalive_ms, launch_query=query, route=route,
                                        log=self._trace), log=self._trace)
            try:
                mux.start_in_thread()
            except ReconnectUnavailable as e:
                if mode == "reconnect":
                    raise RuntimeError(f"Browserless.reconnect unavailable on this account: {e}") from e
                self._trace(f"Browserless.reconnect unavailable ({e}); falling back to the session API")
                mux = None
        if mux is None:
            if features["stealth"] or query:
                self._trace("note: stealth/proxy/ad-block options are not applied in session-API mode")
                features = {"stealth": False, "proxies": False, "block_ads": False, "solve_captchas": False}
            mux = Mux(SessionApiUpstream(base, token, timeout_ms, keepalive_ms, log=self._trace), log=self._trace)
            mux.start_in_thread()
        elif mux.upstream.route == "/chromium":
            features["stealth"] = False  # stealth route was refused and the plugin fell back

        session_id = f"bl-{uuid.uuid4().hex[:16]}"
        with self._lock:
            self._muxes[session_id] = mux
        limit_ms = mux.upstream.session_timeout_ms  # may have been lowered to the plan maximum
        opts = ",".join(k for k, v in features.items() if v) or "none"
        self._trace(f"create_session(task_id={task_id}) -> {session_id} upstream={mux.upstream.kind} "
                    f"options={opts} max_session={limit_ms // 1000}s "
                    f"mux=ws://127.0.0.1:{mux.port}/devtools/browser/<secret>")
        return {
            "session_name": f"hermes_{task_id}_{uuid.uuid4().hex[:8]}",
            "bb_session_id": session_id,
            "cdp_url": mux.url,
            # Hermes replaces the session (fresh browser) on its next command after this time,
            # instead of failing when Browserless ends the browser at its session limit.
            "expires_at": started + limit_ms / 1000 - _EXPIRY_MARGIN_S,
            # Hermes reads "proxies" (no "without residential proxies" warning) and lists truthy keys.
            "features": {"browserless": True, "cdp_mux": True, "upstream": mux.upstream.kind, **features},
        }

    def close_session(self, session_id: str) -> bool:
        with self._lock:
            mux = self._muxes.pop(session_id, None)
        if mux is None:
            return False
        try:
            mux.stop_thread()
            self._trace(f"close_session({session_id}): done; upstream_connects={mux.upstream_connects} "
                        f"stats={dict(mux.stats)}")
            return True
        except Exception as e:  # noqa: BLE001  (must not raise)
            self._trace(f"close_session({session_id}) failed: {type(e).__name__}: {e}")
            return False

    def emergency_cleanup(self, session_id: str) -> None:
        self.close_session(session_id)

    def get_setup_schema(self) -> Optional[Dict[str, Any]]:
        return {
            "name": self.display_name,
            "badge": "paid",
            "tag": "Cloud browser (stealth, proxies, captcha solving)",
            "env_vars": [{"key": "BROWSERLESS_TOKEN", "prompt": "Browserless API token",
                          "url": "https://www.browserless.io/account"}],
            "post_setup": "browserbase",  # installs the agent-browser CLI only (Browserless hosts Chromium)
        }
