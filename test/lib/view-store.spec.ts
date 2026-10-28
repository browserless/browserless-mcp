import { expect } from 'chai';
import assert from 'node:assert/strict';
import sinon from 'sinon';
import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
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

  it('denies unknown/foreign refs identically and never extends the fixed deadline', async () => {
    const prepared = store.prepare('owner', fixture)!;
    expect(() => store.show(prepared.viewRef, 'other')).to.throw(
      VIEW_UNAVAILABLE,
    );
    expect(() => store.show('unknown', 'owner')).to.throw(VIEW_UNAVAILABLE);
    now += VIEW_TTL_MS - 1;
    expect(
      store.show(prepared.viewRef, 'owner').structuredContent!.expiresAt,
    ).to.equal(prepared.expiresAt);
    await store.read(prepared.viewRef, 'owner', 'identity');
    now++;
    expect(() => store.show(prepared.viewRef, 'owner')).to.throw(
      VIEW_UNAVAILABLE,
    );
    await assert.rejects(
      async () => store.read(prepared.viewRef, 'owner', 'gzip'),
      { message: VIEW_UNAVAILABLE },
    );
  });

  for (const limits of [
    { maxEntries: 2 },
    { maxBytes: serializedBytes(fixture) * 2 },
  ]) {
    it(`evicts only the caller's views under ${'maxEntries' in limits ? 'count' : 'byte'} pressure`, () => {
      store = new ViewStore({ now: () => now, ...limits });
      const first = store.prepare('a', fixture)!;
      const second = store.prepare('b', fixture)!;
      expect(store.prepare('c', fixture)).to.equal(undefined);
      expect(store.show(first.viewRef, 'a')).to.have.property('content');
      expect(store.show(second.viewRef, 'b')).to.have.property('content');
      const replacement = store.prepare('a', fixture)!;
      expect(() => store.show(first.viewRef, 'a')).to.throw(VIEW_UNAVAILABLE);
      expect(store.show(second.viewRef, 'b')).to.have.property('content');
      expect(store.show(replacement.viewRef, 'a')).to.have.property('content');
    });
  }

  it('rejects oversized views without disturbing existing ones', () => {
    const prepared = store.prepare('owner', fixture)!;
    expect(
      store.prepare('owner', {
        ...fixture,
        padding: 'x'.repeat(VIEW_DATA_MAX_BYTES),
      }),
    ).to.equal(undefined);
    expect(store.show(prepared.viewRef, 'owner')).to.have.property('content');
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

  it('does not parse recordings too large for the show envelope', () => {
    const prepared = store.prepare('owner', {
      ...fixture,
      padding: '雪'.repeat(VIEW_RESULT_MAX_BYTES / 2),
    })!;
    const parse = sinon.spy(JSON, 'parse');
    try {
      const result = store.show(prepared.viewRef, 'owner');
      expect(result._meta).to.have.property('source');
      expect(parse.called).to.equal(false);
    } finally {
      parse.restore();
    }
  });

  it('reconstructs poorly compressible Unicode JSON across bounded identity and gzip pages', async () => {
    const artifact = {
      ...fixture,
      padding: `🚀${randomBytes(350_000).toString('base64')}雪`,
    };
    const prepared = store.prepare('owner', artifact)!;
    const first = await store.read(prepared.viewRef, 'owner', 'identity');
    const cursor = first.structuredContent!.nextCursor as string;
    await assert.rejects(
      async () => store.read(prepared.viewRef, 'owner', 'gzip', cursor),
      { message: VIEW_UNAVAILABLE },
    );
    const other = store.prepare('owner', artifact)!;
    await assert.rejects(
      async () => store.read(other.viewRef, 'owner', 'identity', cursor),
      { message: VIEW_UNAVAILABLE },
    );
    await assert.rejects(
      async () => store.read(prepared.viewRef, 'other', 'identity'),
      { message: VIEW_UNAVAILABLE },
    );
    for (const encoding of ['identity', 'gzip'] as const) {
      let next: string | undefined;
      let encoded = '';
      let pages = 0;
      do {
        const result = await store.read(
          prepared.viewRef,
          'owner',
          encoding,
          next,
        );
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
      (await store.read(prepared.viewRef, 'owner', 'identity'))._meta,
    ).to.deep.equal(first._meta);
  });

  it('bounds cached compressed bytes and releases them on clear', async () => {
    store.clear();
    const artifact = { ...fixture, padding: 'x'.repeat(100_000) };
    const size = serializedBytes(artifact);
    store = new ViewStore({ now: () => now, maxBytes: size + 10_000 });
    const prepared = store.prepare('a', artifact)!;
    await store.read(prepared.viewRef, 'a', 'gzip');
    store.clear();
    expect(store.prepare('b', artifact)).not.to.equal(undefined);
  });

  it('never evicts another owner or the requested view to cache gzip', async () => {
    const artifact = {
      ...fixture,
      padding: randomBytes(100_000).toString('base64'),
    };
    const size = serializedBytes(artifact);
    const compressedSize = gzipSync(
      Buffer.from(JSON.stringify(artifact)),
    ).length;
    store = new ViewStore({
      now: () => now,
      maxBytes: size * 2 + compressedSize - 1,
    });
    const foreign = store.prepare('b', artifact)!;
    const prepared = store.prepare('a', artifact)!;
    await assert.rejects(
      async () => store.read(prepared.viewRef, 'a', 'gzip'),
      { message: VIEW_UNAVAILABLE },
    );
    expect(store.show(foreign.viewRef, 'b')).to.have.property('content');
    expect(store.show(prepared.viewRef, 'a')).to.have.property('content');
  });

  it('shares asynchronous compression and counts its cached bytes only once', async () => {
    const artifact = {
      ...fixture,
      padding: randomBytes(350_000).toString('base64'),
    };
    const size = serializedBytes(artifact);
    const compressedSize = gzipSync(
      Buffer.from(JSON.stringify(artifact)),
    ).length;
    store = new ViewStore({
      now: () => now,
      maxBytes: size * 2 + compressedSize,
    });
    const prepared = store.prepare('a', artifact)!;
    const view = store.require(prepared.viewRef, 'a');
    const first = store.read(prepared.viewRef, 'a', 'gzip');
    // Compression must yield before caching or serving the first page.
    expect(view.gzip).to.equal(undefined);
    const compression = view.gzipPromise;
    expect(compression).to.be.instanceOf(Promise);
    const second = store.read(prepared.viewRef, 'a', 'gzip');
    expect(view.gzipPromise).to.equal(compression);
    const [one, two] = await Promise.all([first, second]);
    expect(one).to.deep.equal(two);
    expect(await store.read(prepared.viewRef, 'a', 'gzip')).to.deep.equal(one);
    expect(store.prepare('b', artifact)).not.to.equal(undefined);
    expect(store.show(prepared.viewRef, 'a')).to.have.property('content');
  });

  for (const change of ['expiry', 'clear', 'eviction'] as const) {
    it(`rejects a gzip read if ${change} happens during compression`, async () => {
      store = new ViewStore({ now: () => now, maxEntries: 1 });
      const prepared = store.prepare('owner', fixture)!;
      const pending = store.read(prepared.viewRef, 'owner', 'gzip');
      if (change === 'expiry') now += VIEW_TTL_MS;
      else if (change === 'clear') store.clear();
      else expect(store.prepare('owner', fixture)).not.to.equal(undefined);
      await assert.rejects(async () => pending, { message: VIEW_UNAVAILABLE });
    });
  }

  it('declines malformed recordings without creating a view', () => {
    expect(store.prepare('owner', { ...fixture, events: [] })).to.equal(
      undefined,
    );
    expect(
      store.prepare('owner', { ...fixture, events: [{ timestamp: NaN }, {}] }),
    ).to.equal(undefined);
  });
});
