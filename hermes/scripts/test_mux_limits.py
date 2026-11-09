"""Local-only CDP transport limits. Run: python -m unittest discover -s hermes/scripts -p 'test_*.py'."""
import asyncio
import json
from pathlib import Path
import sys
import unittest

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mux import Mux


LIMIT = 16 * 1024 * 1024


class LoopbackUpstream:
    def __init__(self, url):
        self.url = url

    async def connect(self):
        return await websockets.connect(self.url, max_size=None)

    async def after_connect(self, mux):
        pass

    async def shutdown(self, mux):
        pass


class MuxLimitsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async def respond(ws):
            async for raw in ws:
                msg = json.loads(raw)
                result = {"length": len(msg.get("params", {}).get("expression", ""))}
                if msg["method"] == "Page.captureScreenshot":
                    result = {"data": "A" * (LIMIT + 1)}
                await ws.send(json.dumps({"id": msg["id"], "result": result}))

        self.server = await websockets.serve(respond, "127.0.0.1", 0, max_size=None)
        self.addAsyncCleanup(self.server.wait_closed)
        self.addCleanup(self.server.close)
        port = self.server.sockets[0].getsockname()[1]
        self.mux = Mux(LoopbackUpstream(f"ws://127.0.0.1:{port}"), log=lambda _: None)
        await self.mux.start()
        self.addAsyncCleanup(self.mux.stop)

    def command(self, size, char="x"):
        empty = json.dumps({"id": 7, "method": "Runtime.evaluate", "params": {"expression": ""}})
        remaining = size - len(empty)
        width = len(char.encode())
        return empty.replace('"expression": ""',
                             '"expression": "' + char * (remaining // width) + "x" * (remaining % width) + '"')

    async def test_downstream_does_not_negotiate_compression(self):
        async with websockets.connect(self.mux.url) as ws:
            self.assertIsNone(ws.response.headers.get("Sec-WebSocket-Extensions"))

    async def test_accepts_command_at_byte_limit(self):
        raw = self.command(LIMIT, "é")
        self.assertEqual(len(raw.encode()), LIMIT)
        async with websockets.connect(self.mux.url) as ws:
            await ws.send(raw)
            reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
            self.assertEqual(reply, {"id": 7, "result": {"length": len(json.loads(raw)["params"]["expression"])}})

    async def test_oversize_closes_only_offending_peer(self):
        raw = self.command(LIMIT + 1)
        utf8 = self.command(LIMIT + 1, "é")
        for name, message in (("text", raw), ("binary", raw.encode()),
                              ("fragmented", [raw[:LIMIT // 2], raw[LIMIT // 2:]]), ("utf8", utf8)):
            with self.subTest(name=name):
                async with websockets.connect(self.mux.url) as healthy:
                    offender = await websockets.connect(self.mux.url)
                    try:
                        await offender.send(message)
                        await asyncio.wait_for(offender.wait_closed(), 5)
                        self.assertEqual(offender.close_code, 1009)
                        await healthy.send('{"id": 9, "method": "Browser.getVersion"}')
                        self.assertEqual(json.loads(await asyncio.wait_for(healthy.recv(), 5)),
                                         {"id": 9, "result": {"length": 0}})
                        self.assertEqual(self.mux.upstream_connects, 1)
                    finally:
                        # Don't re-close an already terminated transport after a large rejected write.
                        if offender.close_code is None:
                            await offender.close()

    async def test_large_browser_response_is_not_capped(self):
        async with websockets.connect(self.mux.url, max_size=None) as ws:
            await ws.send('{"id": 11, "method": "Page.captureScreenshot"}')
            reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
            self.assertEqual(reply["id"], 11)
            self.assertEqual(reply["result"]["data"], "A" * (LIMIT + 1))


if __name__ == "__main__":
    unittest.main()
