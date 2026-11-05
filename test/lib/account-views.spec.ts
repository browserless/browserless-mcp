import assert from 'node:assert/strict';
import {
  ViewStore,
  VIEW_TTL_MS,
  VIEW_UNAVAILABLE,
} from '../../src/lib/view-store.js';
import {
  UsageSnapshotSchema,
  ActiveSessionsSnapshotSchema,
} from '../../src/lib/account-view-schemas.js';
import { ShowOutputSchema } from '../../src/lib/view-schemas.js';

const usage = () => ({
  timeframe: 'day' as const,
  fetchedAt: new Date().toISOString(),
  currentPeriodEnd: null,
  units: { used: 12, available: 10, overageFee: 0 },
  counters: { successful: 0 },
});

describe('account view snapshots', () => {
  it('preserves null, zero, empty counters and zero allotments without copying extra fields', () => {
    const value = UsageSnapshotSchema.parse({
      ...usage(),
      units: { used: null, available: 0 },
      counters: { successful: 0, apiToken: 'must-not-copy' },
    });
    assert.equal(value.units!.used, null);
    assert.equal(value.units!.available, 0);
    assert.equal(value.units!.overageFee, null);
    assert.equal(value.counters!.successful, 0);
    assert.equal(value.counters!.errored, null);
    assert.equal(JSON.stringify(value).includes('must-not-copy'), false);
    assert.equal(
      UsageSnapshotSchema.parse({ ...usage(), units: null, counters: null })
        .counters,
      null,
    );
    assert.deepEqual(
      ActiveSessionsSnapshotSchema.parse({
        fetchedAt: value.fetchedAt,
        count: null,
        limit: 50,
        skip: 0,
        sessions: [{}],
      }).sessions[0],
      { browserId: null, browserName: null, startTime: null, type: null },
    );
  });

  it('keeps independent immutable references with fixed expiry and denies other owners and replay reads', async () => {
    let now = Date.now();
    const store = new ViewStore({ now: () => now });
    try {
      const input = usage();
      const first = store.prepareSnapshot('alice', 'usage', 'Usage', input)!;
      input.units.used = 99;
      first.data = {} as never;
      assert.throws(() => store.show(first.viewRef, 'bob'), {
        message: VIEW_UNAVAILABLE,
      });
      await assert.rejects(store.read(first.viewRef, 'alice', 'identity'), {
        message: VIEW_UNAVAILABLE,
      });
      now += 1000;
      const next = store.prepareSnapshot('alice', 'usage', 'Usage', {
        ...input,
        timeframe: 'week',
      })!;
      const original = store.show(first.viewRef, 'alice')
        .structuredContent as any;
      assert.equal(original.data.units.used, 12);
      assert.equal(original.data.timeframe, 'day');
      assert.equal(next.data && (next.data as any).timeframe, 'week');
      assert.notEqual(first.viewRef, next.viewRef);
      assert.equal(Date.parse(original.expiresAt), now - 1000 + VIEW_TTL_MS);
      now = Date.parse(original.expiresAt);
      assert.throws(() => store.show(first.viewRef, 'alice'), {
        message: VIEW_UNAVAILABLE,
      });
      assert.equal(
        store.show(next.viewRef, 'alice').structuredContent!.kind,
        'usage',
      );
    } finally {
      await store.clear();
    }
  });

  it('bounds storage and rejects mismatched or oversized snapshots', async () => {
    const store = new ViewStore({ maxEntries: 1 });
    try {
      const first = store.prepareSnapshot('alice', 'usage', 'Usage', usage())!;
      assert.equal(
        store.prepareSnapshot('bob', 'usage', 'Usage', usage()),
        undefined,
      );
      assert.equal(
        store.prepareSnapshot(
          'alice',
          'active-sessions',
          'Wrong kind',
          usage(),
        ),
        undefined,
      );
      assert.equal(
        store.prepareSnapshot('alice', 'usage', 'Usage', {
          ...usage(),
          apiKeyIds: ['a'.repeat(257)],
        }),
        undefined,
      );
      assert.equal(
        ShowOutputSchema.safeParse({ ...first, kind: 'active-sessions' })
          .success,
        false,
      );
      const second = store.prepareSnapshot('alice', 'usage', 'Usage', usage())!;
      assert.throws(() => store.show(first.viewRef, 'alice'));
      assert.ok(store.show(second.viewRef, 'alice'));
    } finally {
      await store.clear();
    }
    const tiny = new ViewStore({ maxBytes: 1 });
    assert.equal(
      tiny.prepareSnapshot('alice', 'usage', 'Usage', usage()),
      undefined,
    );
  });
});
