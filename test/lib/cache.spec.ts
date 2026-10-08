import { expect } from 'chai';
import sinon from 'sinon';
import { ResponseCache } from '../../src/lib/cache.js';

describe('ResponseCache', () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it('stores and retrieves values', () => {
    const cache = new ResponseCache(60000);
    cache.set('key1', { data: 'value1' });
    expect(cache.get('key1')).to.deep.equal({ data: 'value1' });
  });

  it('returns undefined for missing keys', () => {
    const cache = new ResponseCache(60000);
    expect(cache.get('missing')).to.be.undefined;
  });

  it('expires entries after TTL', () => {
    const cache = new ResponseCache(1000);
    cache.set('key1', 'value');
    expect(cache.get('key1')).to.equal('value');

    clock.tick(1001);
    expect(cache.get('key1')).to.be.undefined;
  });

  it('supports a per-entry TTL without changing the default lifetime', () => {
    const cache = new ResponseCache(1000);
    cache.set('short', 'short-lived', 50);
    cache.set('default', 'default-lived');
    expect(cache.get('short')).to.equal('short-lived');
    clock.tick(60);
    expect(cache.get('short')).to.be.undefined;
    expect(cache.get('default')).to.equal('default-lived');
    clock.tick(941);
    expect(cache.get('default')).to.be.undefined;
    cache.dispose();
  });

  it('does not expire entries before TTL', () => {
    const cache = new ResponseCache(1000);
    cache.set('key1', 'value');

    clock.tick(999);
    expect(cache.get('key1')).to.equal('value');
  });

  it('clears all entries', () => {
    const cache = new ResponseCache(60000);
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    expect(cache.size).to.equal(2);

    cache.clear();
    expect(cache.size).to.equal(0);
    expect(cache.get('key1')).to.be.undefined;
  });

  it('reports correct size', () => {
    const cache = new ResponseCache(60000);
    expect(cache.size).to.equal(0);
    cache.set('a', 1);
    expect(cache.size).to.equal(1);
    cache.set('b', 2);
    expect(cache.size).to.equal(2);
  });

  it('overwrites existing keys', () => {
    const cache = new ResponseCache(60000);
    cache.set('key1', 'old');
    cache.set('key1', 'new');
    expect(cache.get('key1')).to.equal('new');
    expect(cache.size).to.equal(1);
  });

  it('sweep removes expired entries automatically', () => {
    const cache = new ResponseCache(1000);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).to.equal(2);

    // Advance past TTL but before sweep interval (ttl * 2)
    clock.tick(1001);
    expect(cache.size).to.equal(2); // still in map, just expired

    // Advance to trigger sweep (ttl * 2 = 2000ms total)
    clock.tick(999);
    expect(cache.size).to.equal(0); // sweep ran, entries removed
  });

  it('dispose clears entries and stops sweep timer', () => {
    const cache = new ResponseCache(1000);
    cache.set('key1', 'value');
    expect(cache.size).to.equal(1);

    cache.dispose();
    expect(cache.size).to.equal(0);
  });

  it('does not start sweep timer when ttl is 0', () => {
    const cache = new ResponseCache(0);
    cache.set('key1', 'value');
    clock.tick(100000);
    // No sweep runs, entry stays (ttl=0 means cache is effectively disabled on get anyway)
    expect(cache.size).to.equal(1);
    cache.dispose();
  });

  it('does not schedule a sweep timer until the first write (the leak fix)', () => {
    const before = clock.countTimers();
    // Constructed but never written: the per-call fallback cache the api-client
    // builds for every non-caching tool. It must register NO timer, so it is
    // GC'd with its client instead of leaking one timer + cache per tool call.
    const cache = new ResponseCache(60000);
    expect(
      clock.countTimers(),
      'constructor must not schedule a timer',
    ).to.equal(before);
    cache.set('k', 'v');
    expect(clock.countTimers(), 'first write starts one sweep timer').to.equal(
      before + 1,
    );
    cache.set('k2', 'v2');
    expect(clock.countTimers(), 'later writes reuse the one timer').to.equal(
      before + 1,
    );
    cache.dispose();
    expect(clock.countTimers(), 'dispose clears the timer').to.equal(before);
  });
});
