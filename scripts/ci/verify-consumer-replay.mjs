import assert from 'node:assert/strict';

const [url, ownerSession] = process.argv.slice(2);
const headers = (token, session) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
  ...(session ? { 'mcp-session-id': session } : {}),
});
const post = (token, session, message) =>
  fetch(url, {
    method: 'POST',
    headers: headers(token, session),
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    signal: AbortSignal.timeout(5000),
  });

// Retain partial data on timeout: a denied replay may leave an empty SSE
// response open, but any leaked frame must still fail the assertion below.
async function read(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes('"id":4242') && text.includes('\n\n')) break;
    }
  } catch (error) {
    if (error.name !== 'TimeoutError' && error.name !== 'AbortError')
      throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

const initialized = await post('ci-other', undefined, {
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'replay-consumer', version: '1' },
  },
});
assert.equal(initialized.status, 200);
const otherSession = initialized.headers.get('mcp-session-id');
assert.ok(otherSession);
assert.notEqual(otherSession, ownerSession);
await initialized.text();
const notified = await post('ci-other', otherSession, {
  method: 'notifications/initialized',
});
assert.equal(notified.status, 202);
await notified.text();
const control = await post('ci-other', otherSession, {
  id: 2,
  method: 'tools/list',
});
assert.equal(control.status, 200, 'other principal has a valid session');
assert.match(await control.text(), /"tools":\[/);

const original = await post('ci-smoke', ownerSession, {
  id: 4242,
  method: 'tools/list',
});
assert.equal(original.status, 200);
const data = await read(original);
const cursor = data.match(/^id: *(.+)$/m)?.[1]?.trim();
assert.ok(cursor, 'request stream supplies a replay cursor');
assert.match(data, /"id":4242/);

const resume = (token, session) =>
  fetch(url, {
    headers: { ...headers(token, session), 'Last-Event-ID': cursor },
    signal: AbortSignal.timeout(2000),
  });
const other = await resume('ci-other', otherSession);
assert.ok([200, 400, 404].includes(other.status));
assert.doesNotMatch(await read(other), /"id":4242|"tools":\[/);

const own = await resume('ci-smoke', ownerSession);
assert.equal(own.status, 200);
const replay = await read(own);
assert.match(replay, /"id":4242/, 'owner can still replay its result');
assert.match(replay, /"tools":\[/);
console.log(
  '✓ Consumer replay: cross-principal denied, owner result preserved',
);
