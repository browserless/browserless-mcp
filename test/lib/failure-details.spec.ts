import { expect } from 'chai';
import {
  failureDetails,
  fallbackCodeCategory,
} from '../../src/lib/failure-details.js';

describe('failureDetails', () => {
  for (const [status, reason] of [
    [400, 'invalid_params'],
    [422, 'invalid_params'],
    [429, 'rate_limited'],
    [408, 'timeout'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [499, 'unknown'],
    [500, 'server_error'],
    [599, 'server_error'],
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

  for (const [code, reason] of [
    ['SELECTOR_NOT_FOUND', 'selector_miss'],
    ['BROWSER_CRASHED', 'session_lost'],
    ['NAVIGATION_TIMEOUT', 'timeout'],
    ['FORBIDDEN', 'forbidden'],
    ['INTERNAL_ERROR', 'unauthorized'],
  ] as const) {
    it(`preserves code/status precedence for ${code}`, () => {
      expect(failureDetails({ code, status: 401 })).to.include({
        error_code: code,
        error_reason: reason,
      });
      expect(
        failureDetails({ code, status: 401 }, { category: 'SCRIPT_ERROR' }),
      ).to.have.property('error_reason', 'script_error');
    });
  }

  it('attributes an API 400 to invalid params', () => {
    expect(failureDetails({ apiStatus: 400 })).to.include({
      error_reason: 'invalid_params',
      error_source: 'api',
      error_status_code: 400,
      error_status_origin: 'api',
    });
  });

  for (const [code, reason] of [
    ['INTERNAL_ERROR', 'server_error'],
    ['TAB_NOT_FOUND', 'not_found'],
  ] as const) {
    it(`falls back to ${reason} for ${code} without a status`, () => {
      expect(failureDetails({ code })).to.include({
        error_code: code,
        error_reason: reason,
      });
    });
  }

  it('ignores inherited property names as fallback codes', () => {
    for (const code of ['constructor', '__proto__', 'toString']) {
      expect(fallbackCodeCategory(code)).to.equal(undefined);
    }
  });

  it('classifies an oversized script result as a script failure', () => {
    expect(failureDetails({ code: 'RESPONSE_TOO_LARGE' })).to.include({
      error_code: 'RESPONSE_TOO_LARGE',
      error_reason: 'response_too_large',
      error_source: 'script',
    });
  });

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
