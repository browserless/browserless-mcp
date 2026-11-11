"""Offline mux contract tests. Run: python -m unittest discover -s hermes/scripts -p 'test_*.py'.

Requires websockets >= 14; no Hermes install or Browserless credentials needed.
"""
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest

import websockets

spec = importlib.util.spec_from_file_location("mux", Path(__file__).resolve().parents[1] / "mux.py")
mux_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mux_module)


class MuxLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.forwarded = []

        async def serve(ws):
            self.upstream_ws = ws
            async for raw in ws:
                msg = json.loads(raw)
                self.forwarded.append(msg)
                result = {"sessionId": f"session-{msg['id']}"} if msg["method"].startswith("Target.attachTo") else {}
                await ws.send(json.dumps({"id": msg["id"], "result": result,
                                          **({"sessionId": msg["sessionId"]} if "sessionId" in msg else {})}))

        server = await websockets.serve(serve, "127.0.0.1", 0)
        self.addAsyncCleanup(server.wait_closed)
        self.addCleanup(server.close)
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"

        class Upstream:
            async def connect(self):
                return await websockets.connect(url)

            async def after_connect(self, mux):
                pass

            async def shutdown(self, mux):
                pass

        self.mux = mux_module.Mux(Upstream(), log=lambda _: None)
        await self.mux.start()
        self.addAsyncCleanup(self.mux.stop)
        self.client = await websockets.connect(self.mux.url)
        self.addAsyncCleanup(self.client.close)

    async def request(self, method, params=None, session=None, client=None):
        ws = client or self.client
        msg = {"id": 37, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        await ws.send(json.dumps(msg))
        return json.loads(await asyncio.wait_for(ws.recv(), 2))

    async def attach(self):
        result = await self.request("Target.attachToBrowserTarget")
        return result["result"]["sessionId"]

    async def test_legacy_events_follow_nested_session_owner(self):
        async with websockets.connect(self.mux.url) as other:
            sessions = []
            for client, target in ((self.client, "target-a"), (other, "target-b")):
                response = await self.request("Target.attachToTarget", {
                    "targetId": target, "flatten": False}, client=client)
                sessions.append(response["result"]["sessionId"])
            for owner, peer, sid, parent in ((self.client, other, sessions[0], sessions[1]),
                                             (other, self.client, sessions[1], sessions[0])):
                for payload in ({"id": 9, "result": {"value": "owner-only"}},
                                {"method": "Runtime.consoleAPICalled", "params": {"args": []}}):
                    for outer in (None, parent):
                        with self.subTest(sid=sid, payload=payload, outer=outer):
                            event = {"method": "Target.receivedMessageFromTarget", "params": {
                                "sessionId": sid, "message": json.dumps(payload), "targetId": "target"}}
                            if outer:
                                event["sessionId"] = outer
                            await self.upstream_ws.send(json.dumps(event))
                            self.assertEqual(json.loads(await asyncio.wait_for(owner.recv(), 2)), event)
                            # A later response is a wire-order barrier: no event may precede it on the peer.
                            self.assertEqual(await self.request("Browser.getVersion", client=peer),
                                             {"id": 37, "result": {}})

            for sid in (None, "", "unknown-session"):
                for outer in (None, sessions[0]):
                    with self.subTest(unowned=sid, outer=outer):
                        params = {"message": '{"id": 9, "result": {}}'}
                        if sid is not None:
                            params["sessionId"] = sid
                        event = {"method": "Target.receivedMessageFromTarget", "params": params}
                        if outer:
                            event["sessionId"] = outer
                        await self.upstream_ws.send(json.dumps(event))
                        for client in (self.client, other):
                            self.assertEqual(await self.request("Browser.getVersion", client=client),
                                             {"id": 37, "result": {}})

            # Controls: ordinary flat events stay private; browser-wide events still broadcast.
            flat = {"method": "Runtime.executionContextCreated", "sessionId": sessions[0],
                    "params": {"context": {"id": 1}}}
            await self.upstream_ws.send(json.dumps(flat))
            self.assertEqual(json.loads(await asyncio.wait_for(self.client.recv(), 2)), flat)
            self.assertEqual(await self.request("Browser.getVersion", client=other), {"id": 37, "result": {}})
            broadcast = {"method": "Browser.downloadProgress", "params": {"guid": "download"}}
            await self.upstream_ws.send(json.dumps(broadcast))
            for client in (self.client, other):
                self.assertEqual(json.loads(await asyncio.wait_for(client.recv(), 2)), broadcast)

    async def test_direct_lifecycle_is_local_at_root_and_on_owned_session(self):
        sid = await self.attach()
        for method in ("Browser.close", "Browser.crash"):
            for session in (None, sid):
                with self.subTest(method=method, session=session):
                    before = len(self.forwarded)
                    response = await self.request(method, session=session)
                    self.assertEqual(response, {"id": 37, "result": {},
                                               **({"sessionId": session} if session else {})})
                    self.assertEqual(len(self.forwarded), before)
        self.assertIn("result", await self.request("Browser.getVersion"))

    async def test_legacy_lifecycle_is_rejected_at_every_envelope_depth(self):
        sid = await self.attach()
        for method in ("Browser.close", "Browser.crash"):
            for depth in (1, 3):
                for session in (None, sid):
                    with self.subTest(method=method, depth=depth, session=session):
                        command = {"id": 81, "method": method}
                        for _ in range(depth):
                            command = {"id": 82, "method": "Target.sendMessageToTarget", "params": {
                                "sessionId": sid, "message": json.dumps(command)}}
                        before = len(self.forwarded)
                        response = await self.request(command["method"], command["params"], session)
                        self.assertIn("error", response)
                        self.assertEqual(response["error"]["code"], -32000)
                        self.assertEqual(response["id"], 37)
                        self.assertEqual(response.get("sessionId"), session)
                        self.assertEqual(len(self.forwarded), before)

    async def test_ownership_still_precedes_lifecycle_policy(self):
        sid = await self.attach()
        async with websockets.connect(self.mux.url) as other:
            for method in ("Browser.close", "Browser.crash"):
                response = await self.request(method, session=sid, client=other)
                self.assertEqual(response["error"]["code"], -32001)
        response = await self.request("Browser.close", session="unknown-session")
        self.assertEqual(response["error"]["code"], -32001)

    async def test_ordinary_and_malformed_legacy_messages_still_reach_upstream(self):
        sid = await self.attach()
        payloads = [json.dumps({"id": 9, "method": "Runtime.evaluate", "params": {
            "expression": "'Browser.close'"}}), "[]", "null", "1", None,
            '{"method": []}', '{"method": "Target.sendMessageToTarget", "params": [1]}']
        for payload in payloads:
            with self.subTest(payload=payload):
                params = {"sessionId": sid, "message": payload}
                before = len(self.forwarded)
                self.assertIn("result", await self.request("Target.sendMessageToTarget", params))
                self.assertEqual(len(self.forwarded), before + 1)
                self.assertEqual(self.forwarded[-1]["params"], params)
        self.assertIn("result", await self.request("Runtime.evaluate", {"expression": "6 * 7"}, sid))
        await self.mux.internal("Browser.close")
        self.assertEqual(self.forwarded[-1]["method"], "Browser.close")


if __name__ == "__main__":
    unittest.main()
