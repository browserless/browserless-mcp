import assert from 'node:assert/strict';
import { liveURLView } from '../../src/lib/live-url-view.js';

describe('direct live viewer capabilities', () => {
  it('preserves routing and IDs while bounding expiry by the browser, link and server cap', () => {
    const started = Date.now();
    const result = {
      liveURL: 'http://localhost:3000/e/abcdef/live/index.html?i=viewer-id',
      liveURLId: 'viewer-id',
      targetId: 'page-id',
      timeout: 60_000,
      browserExpiresAt: started + 12_000,
    };
    const view = liveURLView(
      result,
      'browser-id',
      'http://localhost:3000',
      started,
      'https://viewer.example',
    );
    assert.equal(
      (view._meta!.payload as any).liveURL,
      'https://viewer.example/e/abcdef/live/index.html?i=viewer-id',
    );
    assert.equal(
      view.structuredContent!.expiresAt,
      new Date(started + 12_000).toISOString(),
    );
    assert.equal(view.structuredContent!.targetId, 'page-id');
    const link = liveURLView(
      { ...result, browserExpiresAt: null },
      'b',
      'http://localhost:3000',
      started,
    );
    assert.equal(
      link.structuredContent!.expiresAt,
      new Date(started + 60_000).toISOString(),
    );
    const capped = liveURLView(
      { ...result, browserExpiresAt: null, timeout: 2_000_000 },
      'b',
      'http://localhost:3000',
      started,
    );
    assert.equal(
      capped.structuredContent!.expiresAt,
      new Date(started + 900_000).toISOString(),
    );
  });

  it('does not embed foreign, credentialed, mismatched, malformed or expired capabilities, without failing creation', () => {
    for (const [index, liveURL] of [
      'https://foreign.example/live/index.html?i=id',
      'https://user:pass@api.example/live/index.html?i=id',
      'https://api.example/live/index.html?i=wrong',
      'https://api.example/e/not-hex/live/index.html?i=id',
      'javascript:alert(1)',
      'https://api.example/live/index.html?i=id',
    ].entries()) {
      const result = { liveURL, liveURLId: 'id', timeout: 10_000 };
      const view = liveURLView(
        result,
        'b',
        'https://api.example',
        Date.now() - (index === 5 ? 20_000 : 0),
      );
      assert.equal(view._meta, undefined);
      assert.equal(
        view.structuredContent!.action,
        index === 5 ? 'expired' : 'unavailable',
      );
      assert.deepEqual(
        JSON.parse((view.content[0] as { text: string }).text),
        result,
      );
    }
  });
});
