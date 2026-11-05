import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ViewStore,
  VIEW_TTL_MS,
  VIEW_UNAVAILABLE,
} from '../../src/lib/view-store.js';
import {
  ShowOutputSchema,
  VIEW_RESULT_MAX_BYTES,
} from '../../src/lib/view-schemas.js';
import {
  LogPayloadSchema,
  LogEntrySchema,
  LOG_VIEW_MAX_ENTRIES,
  LOG_VIEW_MAX_BYTES,
  mergeLogEntries,
} from '../../src/lib/log-view-schemas.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/request-logs.json', 'utf8'),
);
describe('request log views', () => {
  it('validates nullable fields, preserves zero and fractional cost, and drops unselected fields', () => {
    const parsed = LogPayloadSchema.parse({
      ...fixture,
      filters: {},
      secret: 'not-copied',
    });
    assert.equal(parsed.entries[2].durationMs, 0);
    assert.equal(parsed.entries[2].totalUnits, 0);
    assert.equal(parsed.entries[0].totalUnits, 0.25);
    assert.equal(parsed.entries[3].level, null);
    assert.equal(JSON.stringify(parsed).includes('not-copied'), false);
    assert.equal(
      LogPayloadSchema.safeParse({ ...parsed, entries: Array(101).fill({}) })
        .success,
      false,
    );
    assert.equal(
      LogPayloadSchema.safeParse({ ...parsed, nextCursor: 'x'.repeat(513) })
        .success,
      false,
    );
  });

  it('keeps rows, filters and cursors UI-only, immutable, authorized and subject to fixed expiry', async () => {
    let now = Date.now();
    const store = new ViewStore({ now: () => now });
    try {
      const payload = {
        ...structuredClone(fixture),
        filters: { requestId: 'private-request', url: 'https://private.test/' },
      };
      const first = store.prepareLogs('alice', payload)!;
      assert.ok(ShowOutputSchema.safeParse(first).success);
      assert.equal(first.kind, 'request-logs');
      const visible = JSON.stringify(first);
      for (const secret of [
        'private-request',
        'private.test',
        'opaque-log-page-2',
        'Too many',
        'request-failure',
      ])
        assert.ok(!visible.includes(secret));
      payload.entries[0].message = 'mutated';
      const shown = store.show(first.viewRef, 'alice');
      assert.equal(
        (shown._meta!.payload as any).entries[0].message,
        'Screenshot completed',
      );
      assert.equal(
        (shown._meta!.payload as any).nextCursor,
        fixture.nextCursor,
      );
      assert.ok(
        Buffer.byteLength(JSON.stringify(shown)) <= VIEW_RESULT_MAX_BYTES,
      );
      assert.throws(() => store.show(first.viewRef, 'bob'), {
        message: VIEW_UNAVAILABLE,
      });
      await assert.rejects(store.read(first.viewRef, 'alice', 'identity'), {
        message: VIEW_UNAVAILABLE,
      });
      now += 1000;
      const next = store.prepareLogs('alice', { ...fixture, filters: {} })!;
      now = Date.parse(first.expiresAt);
      assert.throws(() => store.show(first.viewRef, 'alice'), {
        message: VIEW_UNAVAILABLE,
      });
      assert.equal(Date.parse(next.expiresAt), now + 1000);
      assert.ok(store.show(next.viewRef, 'alice'));
      assert.equal(now, Date.parse(first.expiresAt));
      assert.equal(
        Date.parse(first.expiresAt) - VIEW_TTL_MS + 1000,
        Date.parse(next.expiresAt) - VIEW_TTL_MS,
      );
    } finally {
      await store.clear();
    }
  });

  it('deduplicates overlapping pages without merging distinct events from one request and caps rows/bytes', () => {
    const rows = LogPayloadSchema.parse({ ...fixture, filters: {} }).entries;
    const anotherEvent = { ...rows[0], eventName: 'request.started' };
    const merged = mergeLogEntries(rows, [rows[0], anotherEvent]);
    assert.equal(merged.rows.length, rows.length + 1);
    assert.equal(merged.bounded, false);
    const many = Array.from(
      { length: LOG_VIEW_MAX_ENTRIES + 1 },
      (_, index) => ({ ...rows[0], requestId: String(index) }),
    );
    assert.equal(mergeLogEntries([], many).rows.length, LOG_VIEW_MAX_ENTRIES);
    assert.equal(mergeLogEntries([], many).bounded, true);
    const big = Array.from({ length: 30 }, (_, index) =>
      LogEntrySchema.parse({
        requestId: String(index),
        message: '界'.repeat(100000),
      }),
    );
    const bounded = mergeLogEntries([], big);
    assert.equal(bounded.bounded, true);
    assert.ok(
      Buffer.byteLength(JSON.stringify(bounded.rows)) <= LOG_VIEW_MAX_BYTES,
    );
  });

  it('rejects oversized results instead of leaking a raw fallback and enforces owner-scoped storage limits', async () => {
    const store = new ViewStore({ maxEntries: 1 });
    try {
      const oversized = {
        filters: {},
        nextCursor: null,
        entries: Array.from({ length: 10 }, () => ({
          message: 'x'.repeat(128 * 1024),
        })),
      };
      assert.equal(store.prepareLogs('alice', oversized), undefined);
      const first = store.prepareLogs('alice', { ...fixture, filters: {} })!;
      assert.equal(
        store.prepareLogs('bob', { ...fixture, filters: {} }),
        undefined,
      );
      const second = store.prepareLogs('alice', {
        entries: [],
        filters: {},
        nextCursor: null,
      })!;
      assert.throws(() => store.show(first.viewRef, 'alice'));
      assert.ok(store.show(second.viewRef, 'alice'));
    } finally {
      await store.clear();
    }
  });
});
