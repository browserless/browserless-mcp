import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { getOrCreateSession, send } from '../../src/lib/agent-client.js';
import { makeRespondingServer } from '../helpers/upgrade-server.js';

const frame = process.argv[2];
const peer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(peer, 'listening');
const address = peer.address();
assert(address && typeof address !== 'string');
const healthyPeer = await makeRespondingServer(() => ({ healthy: true }));

peer.on('connection', (ws) => {
  const ids: number[] = [];
  ws.on('message', (data) => {
    const { id } = JSON.parse(data.toString());
    ids.push(id);
    if (ids.length !== 2) return;
    if (frame === 'valid') {
      ws.send(JSON.stringify({ id: 999, result: 'unrelated' }));
      ws.send(JSON.stringify({ id: ids[1], error: { message: 'rejected' } }));
      ws.send(JSON.stringify({ id: ids[0], result: null, extra: true }));
    } else {
      ws.send(frame);
    }
  });
});

try {
  const failed = await getOrCreateSession(
    'malformed-fixture',
    `http://127.0.0.1:${address.port}`,
    'fixture-token',
  );
  const healthy = await getOrCreateSession(
    'healthy-fixture',
    healthyPeer.url,
    'fixture-token',
  );
  assert.deepEqual((await send(healthy, 'snapshot')).result, { healthy: true });
  const closed = once(failed.ws, 'close');
  const results = await Promise.allSettled([
    send(failed, 'snapshot', {}, 1500),
    send(failed, 'getCookies', {}, 1500),
    send(healthy, 'snapshot', {}, 1500),
  ]);
  if (frame === 'valid') {
    assert.deepEqual(results[0], {
      status: 'fulfilled',
      value: { id: 1, result: null, extra: true },
    });
    assert.deepEqual(results[1], {
      status: 'fulfilled',
      value: { id: 2, error: { message: 'rejected' } },
    });
  } else {
    for (const result of results.slice(0, 2)) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.match(result.reason.message, /malformed|WebSocket closed/i);
        assert.doesNotMatch(result.reason.message, /timed out/i);
      }
    }
    await closed;
  }
  assert.deepEqual(results[2], {
    status: 'fulfilled',
    value: { id: 2, result: { healthy: true } },
  });
  assert.deepEqual((await send(healthy, 'snapshot')).result, { healthy: true });
} finally {
  for (const ws of peer.clients) ws.terminate();
  await Promise.all([
    new Promise<void>((resolve) => peer.close(() => resolve())),
    healthyPeer.close(),
  ]);
}
