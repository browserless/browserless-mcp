import { expect } from 'chai';
import sinon from 'sinon';
import { retryWithBackoff } from '../../src/lib/retry.js';

describe('retryWithBackoff', () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it('returns result on first success', async () => {
    const fn = sinon.stub().resolves('ok');
    const promise = retryWithBackoff(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
    });
    const result = await promise;
    expect(result).to.equal('ok');
    expect(fn.callCount).to.equal(1);
  });

  it('retries on failure and returns on eventual success', async () => {
    const fn = sinon
      .stub()
      .onFirstCall()
      .rejects(new Error('fail'))
      .onSecondCall()
      .resolves('ok');

    const promise = retryWithBackoff(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
    });

    // Advance past the first retry delay
    await clock.tickAsync(500);

    const result = await promise;
    expect(result).to.equal('ok');
    expect(fn.callCount).to.equal(2);
  });

  it('throws after exhausting max retries', async () => {
    const fn = sinon.stub().rejects(new Error('always fails'));

    const promise = retryWithBackoff(fn, {
      maxRetries: 2,
      baseDelayMs: 100,
    });

    // Advance timers enough for all retries
    await clock.tickAsync(10000);

    try {
      await promise;
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.equal('always fails');
      expect(fn.callCount).to.equal(3); // initial + 2 retries
    }
  });

  it('respects shouldRetry predicate', async () => {
    const fn = sinon.stub().rejects(new Error('do not retry'));

    const promise = retryWithBackoff(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      shouldRetry: () => false,
    });

    try {
      await promise;
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.equal('do not retry');
      expect(fn.callCount).to.equal(1);
    }
  });

  it('retries when shouldRetry returns true', async () => {
    const fn = sinon
      .stub()
      .onFirstCall()
      .rejects(new Error('retry me'))
      .onSecondCall()
      .resolves('recovered');

    const promise = retryWithBackoff(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      shouldRetry: (err) => err.message === 'retry me',
    });

    await clock.tickAsync(500);

    const result = await promise;
    expect(result).to.equal('recovered');
    expect(fn.callCount).to.equal(2);
  });
});
