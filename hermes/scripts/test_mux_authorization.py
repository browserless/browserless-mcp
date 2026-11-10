"""Session authorization over synthetic local CDP sockets; no browser or credentials."""
import asyncio
import itertools
import json
from pathlib import Path
import sys
import unittest

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mux import Mux


class MuxAuthorizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.forwarded = []
        self.ids = itertools.count(1)

        async def respond(ws):
            async for raw in ws:
                msg = json.loads(raw)
                self.forwarded.append(msg)
                result = {"sessionId": f"session-{msg['id']}"} if msg["method"] == "Target.attachToBrowserTarget" else {}
                await ws.send(json.dumps({"id": msg["id"], "result": result,
                                          **({"sessionId": msg["sessionId"]} if "sessionId" in msg else {})}))

        server = await websockets.serve(respond, "127.0.0.1", 0)
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

        self.mux = Mux(Upstream(), log=lambda _: None)
        await self.mux.start()
        self.addAsyncCleanup(self.mux.stop)
        self.clients = []
        self.sessions = []
        for _ in range(2):
            ws = await websockets.connect(self.mux.url)
            self.addAsyncCleanup(ws.close)
            self.clients.append(ws)
            reply = await self.request(ws, {"method": "Target.attachToBrowserTarget"})
            self.sessions.append(reply["result"]["sessionId"])

    async def request(self, ws, command):
        mid = next(self.ids)
        await ws.send(json.dumps({**command, "id": mid}))
        reply = json.loads(await asyncio.wait_for(ws.recv(), 2))
        self.assertEqual(reply["id"], mid)
        return reply

    async def assert_rejected(self, command):
        before = len(self.forwarded)
        reply = await self.request(self.clients[0], command)
        self.assertEqual(reply.get("error", {}).get("code"), -32001, reply)
        self.assertEqual(reply.get("sessionId"), command.get("sessionId"))
        # A later reply is a wire-order barrier: the rejected command must not have
        # crossed the shared upstream connection, even if it got a local error too.
        await self.request(self.clients[0], {"method": "Browser.getVersion"})
        self.assertEqual([m["method"] for m in self.forwarded[before:]], ["Browser.getVersion"])

    async def test_parameter_selectors_require_owned_sessions(self):
        own, foreign = self.sessions
        for method in ("Target.detachFromTarget", "Target.sendMessageToTarget"):
            for selected in (foreign, "unknown", "", None, [], {}):
                for outer in (None, own):
                    with self.subTest(method=method, selected=selected, outer=outer):
                        command = {"method": method, "params": {
                            "sessionId": selected, "message": '{"id": 9, "method": "Runtime.enable"}'}}
                        if outer:
                            command["sessionId"] = outer
                        await self.assert_rejected(command)
        for ws, session in zip(self.clients, self.sessions):
            self.assertIn("result", await self.request(ws, {"method": "Runtime.enable", "sessionId": session}))

    async def test_legacy_target_selectors_are_not_forwarded(self):
        for method in ("Target.detachFromTarget", "Target.sendMessageToTarget"):
            for params in ({}, {"targetId": "peer-target"},
                           {"targetId": "peer-target", "sessionId": self.sessions[0]}):
                with self.subTest(method=method, params=params):
                    await self.assert_rejected({"method": method, "params": params})

    async def test_nested_commands_cannot_hide_foreign_selectors(self):
        own, foreign = self.sessions
        commands = [
            {"method": "Runtime.enable", "sessionId": foreign},
            {"method": "Target.detachFromTarget", "params": {"sessionId": foreign}},
            {"method": "Target.sendMessageToTarget", "params": {
                "sessionId": foreign, "message": '{"id": 9, "method": "Runtime.enable"}'}},
            {"method": "Target.detachFromTarget", "params": {"targetId": "peer-target"}},
        ]
        for inner in commands:
            for depth in (1, 3):
                with self.subTest(inner=inner, depth=depth):
                    command = inner
                    for _ in range(depth):
                        command = {"method": "Target.sendMessageToTarget", "params": {
                            "sessionId": own, "message": json.dumps({"id": 9, **command})}}
                    await self.assert_rejected(command)

    async def test_owned_selectors_and_nested_messages_still_forward(self):
        for ws, own in zip(self.clients, self.sessions):
            for method in ("Target.detachFromTarget", "Target.sendMessageToTarget"):
                for outer in (None, own):
                    with self.subTest(method=method, outer=outer, own=own):
                        command = {"method": method, "params": {"sessionId": own}}
                        if method == "Target.sendMessageToTarget":
                            command["params"]["message"] = json.dumps({"id": 9, "method": "Target.sendMessageToTarget",
                                "params": {"sessionId": own, "message": '{"id": 10, "method": "Runtime.enable"}'}})
                        if outer:
                            command["sessionId"] = outer
                        self.assertIn("result", await self.request(ws, command))
                        self.assertEqual({k: v for k, v in self.forwarded[-1].items() if k != "id"}, command)


if __name__ == "__main__":
    unittest.main()
