import { expect } from 'chai';
import { failureDetails } from '../../src/lib/failure-details.js';

describe('failureDetails', () => {
  for (const [status, reason] of [
    [429, 'rate_limited'],
    [408, 'timeout'],
    [401, 'unauthorized'],
  ] as const) {
    it(`maps structured status ${status} to ${reason}`, () => {
      expect(failureDetails({ status })).to.include({
        error_reason: reason,
        error_source: 'unknown',
        error_status_code: status,
        error_status_origin: 'unknown',
      });
    });
  }

  it('recognizes RATE_LIMITED without inventing a status', () => {
    expect(failureDetails({ code: 'RATE_LIMITED' })).to.deep.equal({
      error_reason: 'rate_limited',
      error_source: 'unknown',
      error_code: 'RATE_LIMITED',
      error_message: 'Request failed: rate limited.',
    });
  });

  it('keeps the API status origin separate from a script error source', () => {
    const options = {
      category: 'SCRIPT_ERROR' as const,
      source: 'script' as const,
      statusOrigin: 'api' as const,
    };
    expect(failureDetails({ status: 400 }, options)).to.include({
      error_reason: 'script_error',
      error_source: 'script',
      error_status_code: 400,
      error_status_origin: 'api',
    });
  });

  for (const [status, reason] of [
    [404, 'not_found'],
    [200, 'unknown'],
  ] as const) {
    it(`retains target status ${status} on a failed result`, () => {
      const options = {
        source: 'target_website' as const,
        statusOrigin: 'target_website' as const,
      };
      expect(failureDetails({ status }, options)).to.include({
        error_reason: reason,
        error_source: 'target_website',
        error_status_code: status,
        error_status_origin: 'target_website',
      });
    });
  }

  it('does not invent evidence for an absent error', () => {
    expect(failureDetails(undefined)).to.deep.equal({
      error_reason: 'unknown',
      error_source: 'unknown',
      error_message: 'Request failed: unknown.',
    });
  });
});
