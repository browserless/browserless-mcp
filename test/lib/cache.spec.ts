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
});
