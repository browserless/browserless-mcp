import { expect } from 'chai';
import sinon from 'sinon';
import {
  PerformanceAudits,
  PERFORMANCE_AUDIT_TTL_MS,
} from '../../src/lib/performance-audits.js';

describe('prepared performance audits', () => {
  it('evicts old completed results instead of blocking new audits', async () => {
    const audits = new PerformanceAudits();
    const first = audits.prepare({ url: 'https://example.com' }, 'alice');
    await audits.run(first, 'alice', undefined, async () => ({ content: [] }));
    for (let i = 1; i < 16; i++)
      audits.prepare({ url: 'https://example.com' }, 'alice');
    expect(() =>
      audits.prepare({ url: 'https://example.com' }, 'alice'),
    ).not.to.throw();
    expect(() => audits.read(first, 'alice')).to.throw('unavailable');
  });
  it('binds references to owners, expires them, and bounds retained input', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const audits = new PerformanceAudits();
      const params = { url: 'https://example.com' };
      const ref = audits.prepare(params, 'alice');
      expect(() => audits.read(ref, 'bob')).to.throw('unavailable');
      expect(() =>
        audits.run(ref, 'bob', undefined, async () => ({ content: [] })),
      ).to.throw('unavailable');
      expect(() =>
        audits.prepare(
          { ...params, config: { value: 'x'.repeat(65536) } },
          'alice',
        ),
      ).to.throw('size limit');
      for (let i = 1; i < 16; i++) audits.prepare(params, 'alice');
      expect(() => audits.prepare(params, 'alice')).to.throw('Too many');
      await clock.tickAsync(PERFORMANCE_AUDIT_TTL_MS);
      expect(() => audits.read(ref, 'alice')).to.throw('expired');
      expect(() => audits.prepare(params, 'alice')).not.to.throw();
    } finally {
      clock.restore();
    }
  });

  it('propagates cancellation and retains the failure instead of running again', async () => {
    const audits = new PerformanceAudits();
    const ref = audits.prepare({ url: 'https://example.com' }, 'alice');
    const controller = new AbortController();
    const execute = sinon
      .stub()
      .callsFake(
        (_params, signal: AbortSignal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new Error('Audit cancelled')),
              { once: true },
            ),
          ),
      );
    const result = audits
      .run(ref, 'alice', controller.signal, execute)
      .catch((error) => error);
    await Promise.resolve();
    controller.abort();
    expect((await result).message).to.equal('Audit cancelled');
    expect(() => audits.read(ref, 'alice')).to.throw('Audit cancelled');
    const repeated = await audits
      .run(ref, 'alice', undefined, execute)
      .catch((error) => error);
    expect(repeated.message).to.equal('Audit cancelled');
    expect(execute.callCount).to.equal(1);
  });
});
