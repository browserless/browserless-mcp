"""CDP multiplexer: many local CDP clients (agent-browser daemon, CDP supervisor, ...) over ONE
upstream browser WebSocket.

Serves ws://127.0.0.1:<port>/devtools/browser/<secret> (+ GET /json/version). Routing rules:
  * per-client message-id remapping (client id <-> upstream id)
  * sessionId -> owning client, learned from responses carrying result.sessionId and from
    Target.attachedToTarget events nested under a session the client already owns
  * sessionless Target.attachedToTarget routed via a pending-attach FIFO keyed by targetId;
    otherwise buffered by sessionId until a response claims it
  * Target.setDiscoverTargets enabled upstream once; per-client flags; late joiners get
    synthesized Target.targetCreated for existing targets
  * Target.targetCreated/Destroyed/InfoChanged/Crashed broadcast to discover-enabled clients
  * Browser.close / Browser.crash answered locally with {} (the provider owns browser lifetime)
  * on client disconnect: Target.detachFromTarget for every session it owns
  * on upstream loss: downstream sockets are closed (clients re-dial), the listener stays up, the
    upstream is re-dialed with backoff, and new clients wait for it before being served
"""
import asyncio
import collections
import itertools
import json
import secrets
import threading
import time
from http import HTTPStatus

import websockets
from websockets.datastructures import Headers
from websockets.http11 import Response

TARGET_BROADCAST = {"Target.targetCreated", "Target.targetDestroyed", "Target.targetInfoChanged", "Target.targetCrashed"}
LOCAL_NOOP = {"Browser.close", "Browser.crash"}
RECOVERY_DELAYS = (0, 0.25, 0.5, 1, 2, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5)  # ~57 s total
INTERNAL = object()  # pending-attach marker for the mux's own attaches


class UpstreamGone(Exception):
    """The remote browser no longer exists; recovery is pointless."""


class Client:
    def __init__(self, ws, generation, cid):
        self.ws = ws
        self.cid = cid
        self.generation = generation
        self.discover = False
        self.sessions = set()
        self.requests = 0
        self.responses = 0


class Mux:
    """``upstream`` provides: ``async connect() -> ws``, ``async after_connect(mux)``,
    ``async maintain(mux)`` (called periodically), ``async shutdown(mux)``, ``maintain_interval``."""

    def __init__(self, upstream, host="127.0.0.1", port=0, log=print, client_wait_s=60.0):
        self.upstream = upstream
        self.host, self.port = host, port
        self.secret = secrets.token_hex(16)
        self.path = f"/devtools/browser/{self.secret}"
        self.log = log
        self.client_wait_s = client_wait_s
        self.up = None
        self.generation = 0
        self.upstream_connects = 0
        self.up_ids = itertools.count(1)
        self.client_ids = itertools.count(1)  # numbered per session, for readable logs
        self.clients = set()
        self.stats = collections.Counter()
        self.dead = False
        self._stopping = False
        self._tasks = set()
        self._reset_routing()
        self._server = self._loop = self._thread = None
        self._ready_evt = threading.Event()
        self._start_error = None

    @property
    def url(self):
        return f"ws://{self.host}:{self.port}{self.path}"

    def upstream_open(self):
        return self.up is not None and self.up.state.name == "OPEN"

    def _reset_routing(self):
        for entry in getattr(self, "pending", {}).values():
            if entry[0] is None and not entry[1].done():
                entry[1].set_exception(ConnectionError("upstream lost"))
        self.pending = {}  # up_id -> (client|None, client_msg_id|future, method, params)
        self.owner = {}  # sessionId -> Client
        self.pending_attach = collections.defaultdict(collections.deque)  # targetId -> deque[Client|INTERNAL]
        self.orphans = {}  # sessionId -> [buffered events, first_seen]
        self.upstream_discover = False
        # sessionId -> former owner; tells a stale session (closed by the browser while the client still
        # had commands in flight, e.g. a replaced iframe target) from a real misroute
        self.recently_released = collections.OrderedDict()

    def _spawn(self, coro):
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        return t

    # ------------------------------------------------------------------ lifecycle
    async def start(self):
        self.ready = asyncio.Event()
        try:
            await self._connect_upstream()
        except BaseException:
            await self._shutdown_upstream()
            raise
        self._server = await websockets.serve(self._serve_client, self.host, self.port, max_size=None,
                                              ping_interval=None, close_timeout=2, process_request=self._http)
        if not self.port:
            self.port = self._server.sockets[0].getsockname()[1]
        self._spawn(self._maintain_loop())
        self.log(f"mux: listening on ws://{self.host}:{self.port}/devtools/browser/<secret>")

    async def _connect_upstream(self):
        ws = await self.upstream.connect()
        self.generation += 1
        self.up = ws
        self.upstream_connects += 1
        self._reset_routing()
        self._spawn(self._read_upstream(ws, self.generation))
        try:
            await self.upstream.after_connect(self)
        except BaseException:
            self.generation += 1  # orphan this socket's reader so closing it doesn't trigger recovery
            await ws.close()
            raise
        self.ready.set()

    async def _shutdown_upstream(self):
        try:
            await asyncio.wait_for(self.upstream.shutdown(self), 20)
        except Exception as e:  # noqa: BLE001
            self.log(f"mux: upstream shutdown error: {type(e).__name__}: {e}")
        if self.up is not None:
            await self.up.close()

    async def stop(self):
        self._stopping = True
        for c in list(self.clients):
            await c.ws.close(1001, "session closed")
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        await self._shutdown_upstream()
        for t in list(self._tasks):
            t.cancel()
        self.log(f"mux: stopped; upstream_connects={self.upstream_connects} stats={dict(self.stats)}")

    def start_in_thread(self, timeout=60):
        """Run the mux on its own event loop in a daemon thread (Hermes providers are sync)."""
        def run():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            try:
                self._loop.run_until_complete(self.start())
            except BaseException as e:  # noqa: BLE001
                self._start_error = e
                self._ready_evt.set()
                self._loop.close()
                return
            self._ready_evt.set()
            self._loop.run_forever()
            self._loop.close()

        self._thread = threading.Thread(target=run, name="browserless-cdp-mux", daemon=True)
        self._thread.start()
        if not self._ready_evt.wait(timeout):
            raise RuntimeError("Browserless CDP mux did not start in time")
        if self._start_error:
            raise self._start_error
        return self.url

    def stop_thread(self, timeout=30):
        if not self._loop or self._loop.is_closed():
            return
        fut = asyncio.run_coroutine_threadsafe(self.stop(), self._loop)
        try:
            fut.result(timeout)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)
            self._thread.join(timeout)

    def run_threadsafe(self, coro, timeout=30):
        """Helper for tests/diagnostics: run a coroutine on the mux loop."""
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(timeout)

    def _http(self, conn, request):
        if request.path == "/json/version":
            body = json.dumps({"Browser": "browserless-cdp-mux", "Protocol-Version": "1.3",
                               "webSocketDebuggerUrl": self.url}).encode()
            return Response(200, "OK", Headers([("Content-Type", "application/json"),
                                                 ("Content-Length", str(len(body)))]), body)
        if request.path != self.path:
            return conn.respond(HTTPStatus.NOT_FOUND, "unknown path\n")
        return None

    # ------------------------------------------------------------------ upstream I/O
    async def _send_up(self, msg):
        await self.up.send(json.dumps(msg))

    async def internal(self, method, params=None, session=None, timeout=15):
        """Send a command on behalf of the mux itself; returns the raw CDP response dict."""
        uid = next(self.up_ids)
        fut = asyncio.get_running_loop().create_future()
        self.pending[uid] = (None, fut, method, params or {})
        msg = {"id": uid, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        if method == "Target.attachToTarget" and not session:
            self.pending_attach[(params or {}).get("targetId")].append(INTERNAL)
        await self._send_up(msg)
        return await asyncio.wait_for(fut, timeout)

    async def _deliver(self, client, msg):
        try:
            await client.ws.send(json.dumps(msg))
        except websockets.ConnectionClosed:
            pass

    def _claim(self, sid, client):
        prev = self.owner.get(sid)
        if prev is not None and prev is not client:
            self.stats["claim_conflict"] += 1
            self.log(f"mux: WARNING session {sid[:8]} claimed by c{client.cid} but owned by c{prev.cid}")
            return
        self.owner[sid] = client
        client.sessions.add(sid)
        buffered = self.orphans.pop(sid, None)
        if buffered:
            for ev in buffered[0]:
                self._spawn(self._deliver(client, ev))

    def _release(self, sid):
        c = self.owner.pop(sid, None)
        if c:
            c.sessions.discard(sid)
            self.recently_released[sid] = c.cid
            while len(self.recently_released) > 1000:
                self.recently_released.popitem(last=False)

    def _drop_pending_attach(self, target_id, who):
        q = self.pending_attach.get(target_id)
        if q and who in q:
            q.remove(who)
            if not q:
                self.pending_attach.pop(target_id, None)

    async def _read_upstream(self, ws, generation):
        try:
            async for raw in ws:
                msg = json.loads(raw)
                if "id" in msg:
                    await self._on_response(msg)
                else:
                    await self._on_event(msg)
        except websockets.ConnectionClosed:
            pass
        finally:
            if not self._stopping and generation == self.generation:
                self.log(f"mux: UPSTREAM LOST code={ws.close_code} reason={ws.close_reason!r}; recovering")
                self.stats["upstream_lost"] += 1
                self.ready.clear()
                self._reset_routing()
                self._spawn(self._recover())  # don't wait for downstream close handshakes
                for c in list(self.clients):
                    self._spawn(c.ws.close(1012, "upstream reconnecting"))

    async def _recover(self):
        start = time.monotonic()
        for i, delay in enumerate(RECOVERY_DELAYS):
            await asyncio.sleep(delay)
            if self._stopping:
                return
            try:
                await self._connect_upstream()
                self.stats["upstream_recovered"] += 1
                self.log(f"mux: upstream recovered after {time.monotonic() - start:.2f}s (attempt {i + 1})")
                return
            except UpstreamGone as e:
                self.log(f"mux: upstream gone, giving up: {e}")
                break
            except Exception as e:  # noqa: BLE001
                self.log(f"mux: upstream reconnect attempt {i + 1} failed: {type(e).__name__}: {e}")
        self.dead = True
        self.log("mux: upstream unrecoverable; new clients will be refused")

    async def _maintain_loop(self):
        interval = getattr(self.upstream, "maintain_interval", None)
        if not interval:
            return
        while not self._stopping:
            await asyncio.sleep(interval)
            if self.ready.is_set():
                try:
                    await self.upstream.maintain(self)
                except Exception as e:  # noqa: BLE001
                    self.log(f"mux: maintain failed: {type(e).__name__}: {e}")

    async def _on_response(self, msg):
        entry = self.pending.pop(msg["id"], None)
        if entry is None:
            self.stats["unmatched_response"] += 1
            return
        client, cmid, method, params = entry
        sid = (msg.get("result") or {}).get("sessionId")
        if client is None:  # internal call
            if method == "Target.attachToTarget":
                self._drop_pending_attach(params.get("targetId"), INTERNAL)
            if not cmid.done():
                cmid.set_result(msg)
            return
        if method == "Target.attachToTarget":
            self._drop_pending_attach(params.get("targetId"), client)
        if sid and client in self.clients:
            self._claim(sid, client)
        elif sid:  # client went away while attaching
            self._spawn(self._quiet_detach(sid))
        if client in self.clients:
            msg["id"] = cmid
            client.responses += 1
            await self._deliver(client, msg)

    async def _quiet_detach(self, sid):
        try:
            await self.internal("Target.detachFromTarget", {"sessionId": sid}, timeout=5)
        except Exception:  # noqa: BLE001
            pass

    async def _on_event(self, msg):
        method = msg.get("method")
        sid = msg.get("sessionId")
        params = msg.get("params") or {}
        if sid:
            owner = self.owner.get(sid)
            if owner is None:
                self.stats["event_unowned_session"] += 1
                return
            if method == "Target.attachedToTarget":
                self._claim(params["sessionId"], owner)
            await self._deliver(owner, msg)
            if method == "Target.detachedFromTarget":
                self._release(params.get("sessionId"))
            return
        if method in TARGET_BROADCAST:
            for c in list(self.clients):
                if c.discover:
                    await self._deliver(c, msg)
            return
        if method == "Target.attachedToTarget":
            child = params["sessionId"]
            q = self.pending_attach.get(params["targetInfo"]["targetId"])
            if child in self.owner:
                await self._deliver(self.owner[child], msg)
            elif q and q[0] is INTERNAL:
                pass  # the mux's own short-lived attach
            elif q:
                self._claim(child, q[0])
                await self._deliver(q[0], msg)
            else:
                self.orphans.setdefault(child, [[], time.monotonic()])[0].append(msg)
                self.stats["orphans_buffered"] += 1
            return
        if method == "Target.detachedFromTarget":
            child = params.get("sessionId")
            owner = self.owner.get(child)
            if owner:
                await self._deliver(owner, msg)
            self._release(child)
            return
        self.stats["sessionless_broadcast"] += 1
        for c in list(self.clients):
            await self._deliver(c, msg)

    # ------------------------------------------------------------------ downstream
    async def _serve_client(self, ws):
        if self.dead:
            await ws.close(1011, "upstream browser is gone")
            return
        if not self.ready.is_set():
            try:
                await asyncio.wait_for(self.ready.wait(), self.client_wait_s)
            except asyncio.TimeoutError:
                await ws.close(1013, "upstream unavailable")
                return
        client = Client(ws, self.generation, next(self.client_ids))
        self.clients.add(client)
        self.stats["clients_total"] += 1
        self.log(f"mux: c{client.cid} connected ({len(self.clients)} live)")
        try:
            async for raw in ws:
                await self._on_client_msg(client, json.loads(raw))
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.discard(client)
            owned = list(client.sessions)
            if client.generation == self.generation:
                for uid, entry in list(self.pending.items()):
                    if entry[0] is client:  # keep the slot so the late response is swallowed
                        self.pending[uid] = (None, asyncio.get_running_loop().create_future(), entry[2], entry[3])
                for q in self.pending_attach.values():
                    while client in q:
                        q.remove(client)
                for sid in owned:
                    self.owner.pop(sid, None)
                if self.ready.is_set():
                    for sid in owned:
                        await self._quiet_detach(sid)
            self.log(f"mux: c{client.cid} gone; req={client.requests} resp={client.responses} detached={len(owned)}")

    async def _on_client_msg(self, client, msg):
        cmid, method = msg.get("id"), msg.get("method")
        params = msg.get("params") or {}
        sid = msg.get("sessionId")
        client.requests += 1

        async def reply(result):
            client.responses += 1
            await self._deliver(client, {"id": cmid, "result": result, **({"sessionId": sid} if sid else {})})

        if client.generation != self.generation or not self.ready.is_set():
            return  # stale client from before an upstream reconnect; it is being closed
        if sid and self.owner.get(sid) is not client:
            kind = "stale_session_rejected" if self.recently_released.get(sid) == client.cid else "foreign_session_rejected"
            self.stats[kind] += 1
            if kind == "foreign_session_rejected" and self.stats[kind] <= 5:
                own = self.owner.get(sid)
                self.log(f"mux: WARNING c{client.cid} sent {method} on a session it doesn't own "
                         f"(sess={sid[:8]} owner={'c%d' % own.cid if own else None})")
            client.responses += 1
            await self._deliver(client, {"id": cmid, "sessionId": sid,
                                         "error": {"code": -32001, "message": "Session with given id not found."}})
            return
        if not sid and method in LOCAL_NOOP:
            self.stats["browser_close_swallowed"] += 1
            await reply({})
            return
        if not sid and method == "Target.setDiscoverTargets":
            want = bool(params.get("discover"))
            client.discover = want
            if not want:
                await reply({})
                return
            if self.upstream_discover:
                infos = (await self.internal("Target.getTargets"))["result"]["targetInfos"]
                for ti in infos:
                    await self._deliver(client, {"method": "Target.targetCreated", "params": {"targetInfo": ti}})
                self.stats["discover_synthesized"] += len(infos)
                await reply({})
                return
            self.upstream_discover = True  # first enabler: the browser emits targetCreated itself
        if not sid and method == "Target.attachToTarget":
            self.pending_attach[params.get("targetId")].append(client)
        uid = next(self.up_ids)
        self.pending[uid] = (client, cmid, method, params)
        msg["id"] = uid
        await self._send_up(msg)
