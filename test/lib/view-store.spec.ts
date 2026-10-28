import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import {
  ViewStore,
  VIEW_TTL_MS,
  VIEW_UNAVAILABLE,
} from '../../src/lib/view-store.js';
import {
  VIEW_CHUNK_MAX_BYTES,
  VIEW_DATA_MAX_BYTES,
  VIEW_RESULT_MAX_BYTES,
} from '../../src/lib/view-schemas.js';
import type { ReplayArtifact } from '../../src/lib/session-replay-artifact.js';

const fixture = JSON.parse(
  readFileSync('test/fixtures/replay-widget.json', 'utf8'),
) as ReplayArtifact;
const serializedBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value));

describe('owned replay view snapshots', () => {
  let now: number;
  let store: ViewStore;
  beforeEach(() => {
    now = 1_800_000_000_000;
    store = new ViewStore({ now: () => now });
  });
  afterEach(() => store.clear());

  it('snapshots immutable events, exposes only a compact summary, and strips URL credentials/query', () => {
    const artifact = structuredClone(fixture);
    artifact.website =
      'https://name:secret@example.com/page?token=private#secret';
    const prepared = store.prepare('owner', artifact)!;
    expect(prepared.data.website).to.equal('example.com');
    expect(JSON.stringify(prepared)).not.to.match(
      /secret|private|Step 1|events/,
    );
    artifact.events.length = 0;
    const result = store.show(prepared.viewRef, 'owner');
    expect((result._meta!.payload as ReplayArtifact).events).to.have.length(6);
    expect(result.structuredContent).to.deep.equal(prepared);
  });

  it('denies unknown/foreign refs identically and never extends the fixed deadline', () => {
    const prepared = store.prepare('owner', fixture)!;
    expect(() => store.show(prepared.viewRef, 'other')).to.throw(
      VIEW_UNAVAILABLE,
    );
    expect(() => store.show('unknown', 'owner')).to.throw(VIEW_UNAVAILABLE);
    now += VIEW_TTL_MS - 1;
    expect(
      store.show(prepared.viewRef, 'owner').structuredContent!.expiresAt,
    ).to.equal(prepared.expiresAt);
    store.read(prepared.viewRef, 'owner', 'identity');
    now++;
    expect(() => store.show(prepared.viewRef, 'owner')).to.throw(
      VIEW_UNAVAILABLE,
    );
    expect(() => store.read(prepared.viewRef, 'owner', 'gzip')).to.throw(
      VIEW_UNAVAILABLE,
    );
  });

  it('evicts under count and byte pressure, rejects oversized views without disturbing existing ones', () => {
    store.clear();
    store = new ViewStore({
      now: () => now,
      maxEntries: 2,
      maxBytes: serializedBytes(fixture) * 2,
    });
    const first = store.prepare('a', fixture)!;
    const second = store.prepare('b', fixture)!;
    const third = store.prepare('c', fixture)!;
    expect(() => store.show(first.viewRef, 'a')).to.throw(VIEW_UNAVAILABLE);
    expect(store.show(second.viewRef, 'b')).to.have.property('content');
    expect(store.show(third.viewRef, 'c')).to.have.property('content');
    expect(
      store.prepare('c', {
        ...fixture,
        padding: 'x'.repeat(VIEW_DATA_MAX_BYTES),
      }),
    ).to.equal(undefined);
    expect(store.show(third.viewRef, 'c')).to.have.property('content');
  });

  it('measures the entire serialized result at the exact 2 MiB boundary', () => {
    const baseline = store.prepare('owner', { ...fixture, padding: '' })!;
    const overhead = serializedBytes(store.show(baseline.viewRef, 'owner'));
    for (const delta of [-1, 0, 1]) {
      const prepared = store.prepare('owner', {
        ...fixture,
        padding: 'x'.repeat(VIEW_RESULT_MAX_BYTES - overhead + delta),
      })!;
      const result = store.show(prepared.viewRef, 'owner');
      if (delta <= 0) {
        expect(result._meta).to.have.property('payload');
        expect(serializedBytes(result)).to.equal(VIEW_RESULT_MAX_BYTES + delta);
      } else {
        expect(result._meta).to.have.property('source');
        expect(serializedBytes(result)).to.be.lessThan(VIEW_RESULT_MAX_BYTES);
      }
    }
  });

  it('reconstructs poorly compressible Unicode JSON across bounded identity and gzip pages', () => {
    const artifact = {
      ...fixture,
      padding: `🚀${randomBytes(350_000).toString('base64')}雪`,
    };
    const prepared = store.prepare('owner', artifact)!;
    const first = store.read(prepared.viewRef, 'owner', 'identity');
    const cursor = first.structuredContent!.nextCursor as string;
    expect(() =>
      store.read(prepared.viewRef, 'owner', 'gzip', cursor),
    ).to.throw(VIEW_UNAVAILABLE);
    const other = store.prepare('owner', artifact)!;
    expect(() =>
      store.read(other.viewRef, 'owner', 'identity', cursor),
    ).to.throw(VIEW_UNAVAILABLE);
    expect(() => store.read(prepared.viewRef, 'other', 'identity')).to.throw(
      VIEW_UNAVAILABLE,
    );
    for (const encoding of ['identity', 'gzip'] as const) {
      let next: string | undefined;
      let encoded = '';
      let pages = 0;
      do {
        const result = store.read(prepared.viewRef, 'owner', encoding, next);
        expect(serializedBytes(result)).to.be.at.most(VIEW_CHUNK_MAX_BYTES);
        encoded += result._meta!.data;
        next = result.structuredContent!.nextCursor as string | undefined;
        expect(result.structuredContent!.complete).to.equal(!next);
        pages++;
      } while (next);
      expect(pages).to.be.greaterThan(1);
      let bytes = Buffer.from(encoded, 'base64');
      if (encoding === 'gzip') bytes = gunzipSync(bytes);
      expect(JSON.parse(bytes.toString('utf8'))).to.deep.equal(artifact);
    }
    expect(
      store.read(prepared.viewRef, 'owner', 'identity')._meta,
    ).to.deep.equal(first._meta);
  });

  it('bounds cached compressed bytes and releases them on clear', () => {
    store.clear();
    const artifact = { ...fixture, padding: 'x'.repeat(100_000) };
    const size = serializedBytes(artifact);
    store = new ViewStore({ now: () => now, maxBytes: size + 10_000 });
    const prepared = store.prepare('a', artifact)!;
    store.read(prepared.viewRef, 'a', 'gzip');
    store.clear();
    expect(store.prepare('b', artifact)).not.to.equal(undefined);
  });

  it('declines malformed recordings without creating a view', () => {
    expect(store.prepare('owner', { ...fixture, events: [] })).to.equal(
      undefined,
    );
    expect(
      store.prepare('owner', { ...fixture, events: [{ timestamp: NaN }, {}] }),
    ).to.equal(undefined);
  });
});
