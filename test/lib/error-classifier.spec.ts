import { expect } from 'chai';
import {
  categoryFromStatus,
  classifyAgentError,
  classifyNavigationResult,
  toAnalyticsCategory,
} from '../../src/lib/error-classifier.js';
import type { ErrorCategory } from '../../src/@types/types.js';

interface Row {
  name: string;
  err: { code?: string; message: string; status?: number };
  cmd?: { method: string; params: Record<string, unknown> };
  expected: ErrorCategory;
  expectedStatus?: number;
}

const cmd = (method = 'goto', params: Record<string, unknown> = {}) => ({
  method,
  params,
});

const ROWS: Row[] = [
  {
    name: 'SELECTOR_NOT_FOUND code → SELECTOR_MISS',
    err: { code: 'SELECTOR_NOT_FOUND', message: 'no element matched' },
    cmd: cmd('click', { selector: 'button#x' }),
    expected: 'SELECTOR_MISS',
  },
  {
    name: 'BROWSER_CRASHED code → SESSION_LOST',
    err: { code: 'BROWSER_CRASHED', message: 'browser exited' },
    expected: 'SESSION_LOST',
  },
  {
    name: 'WS closed mid-flight → SESSION_LOST',
    err: { message: 'WebSocket closed while waiting for "click" response' },
    cmd: cmd('click'),
    expected: 'SESSION_LOST',
  },
  {
    name: 'WS connect failed → SESSION_LOST',
    err: { message: 'Agent WebSocket connection failed: ECONNRESET' },
    expected: 'SESSION_LOST',
  },
  {
    name: 'WS connect timeout → TIMEOUT',
    err: { message: 'Agent WebSocket connection timed out after 30s' },
    expected: 'TIMEOUT',
  },
  {
    name: 'INVALID_PARAMS code → INVALID_PARAMS',
    err: { code: 'INVALID_PARAMS', message: 'bad input' },
    expected: 'INVALID_PARAMS',
  },
  {
    name: 'INTERNAL_ERROR with "Invalid parameters" message → INVALID_PARAMS',
    err: {
      code: 'INTERNAL_ERROR',
      message:
        'goto failed: Invalid parameters Failed to deserialize params.url: invalid type',
    },
    cmd: cmd('goto'),
    expected: 'INVALID_PARAMS',
  },
  {
    name: 'message contains "Failed to deserialize" → INVALID_PARAMS',
    err: { message: 'Failed to deserialize params.timeout' },
    expected: 'INVALID_PARAMS',
  },
  {
    name: 'waitForSelector + SELECTOR_NOT_FOUND → SELECTOR_MISS (same bucket as click)',
    err: {
      code: 'SELECTOR_NOT_FOUND',
      message: 'no element matched ".thing" within 5000ms',
    },
    cmd: cmd('waitForSelector', { selector: '.thing', timeout: 5000 }),
    expected: 'SELECTOR_MISS',
  },
  {
    name: 'UNKNOWN_METHOD code → UNKNOWN_METHOD',
    err: { code: 'UNKNOWN_METHOD', message: 'Unknown method: explode' },
    cmd: cmd('explode'),
    expected: 'UNKNOWN_METHOD',
  },
  {
    name: 'code-less "Unknown method" message → UNKNOWN_METHOD',
    err: { message: 'Unknown method: explode' },
    cmd: cmd('explode'),
    expected: 'UNKNOWN_METHOD',
  },
  {
    name: 'evaluate script throw → SCRIPT_ERROR',
    err: {
      code: 'INTERNAL_ERROR',
      message: 'ReferenceError: x is not defined',
    },
    cmd: cmd('evaluate', { content: 'return x' }),
    expected: 'SCRIPT_ERROR',
  },
  {
    name: 'evaluate + target closed → SESSION_LOST, not SCRIPT_ERROR',
    err: { message: 'WebSocket closed while waiting for "evaluate" response' },
    cmd: cmd('evaluate', { content: 'return 1' }),
    expected: 'SESSION_LOST',
  },
  {
    name: 'evaluate + timeout → TIMEOUT, not SCRIPT_ERROR',
    err: { message: 'Agent command "evaluate" timed out after 30000ms' },
    cmd: cmd('evaluate', { content: 'return 1' }),
    expected: 'TIMEOUT',
  },
  {
    name: 'goto 401 message → UNAUTHORIZED',
    err: { message: 'goto failed: 401 Unauthorized' },
    cmd: cmd('goto'),
    expected: 'UNAUTHORIZED',
    expectedStatus: 401,
  },
  {
    name: '403 in message → FORBIDDEN',
    err: { message: 'origin returned 403 Forbidden' },
    expected: 'FORBIDDEN',
    expectedStatus: 403,
  },
  {
    name: '404 in message → NOT_FOUND',
    err: { message: 'navigation: 404 Not Found' },
    expected: 'NOT_FOUND',
    expectedStatus: 404,
  },
  {
    name: '503 in message → SERVER_ERROR',
    err: { message: 'goto failed with 503 Service Unavailable' },
    expected: 'SERVER_ERROR',
    expectedStatus: 503,
  },
  {
    name: 'explicit status field → category from status',
    err: { message: 'request failed', status: 500 },
    expected: 'SERVER_ERROR',
    expectedStatus: 500,
  },
  {
    name: 'net::ERR_NAME_NOT_RESOLVED → NAVIGATION_FAILED',
    err: { message: 'goto failed: net::ERR_NAME_NOT_RESOLVED' },
    expected: 'NAVIGATION_FAILED',
  },
  {
    name: 'ECONNREFUSED → NAVIGATION_FAILED',
    err: { message: 'navigation failed: ECONNREFUSED 127.0.0.1' },
    expected: 'NAVIGATION_FAILED',
  },
  {
    name: 'plain timeout message → TIMEOUT',
    err: { message: 'Agent command "waitForSelector" timed out after 5000ms' },
    cmd: cmd('waitForSelector'),
    expected: 'TIMEOUT',
  },
  {
    name: 'unrecognized error → UNKNOWN',
    err: { message: 'something weird happened' },
    expected: 'UNKNOWN',
  },
  {
    name: 'TAB_NOT_FOUND code → UNKNOWN (handled by tab skill, not classifier)',
    err: { code: 'TAB_NOT_FOUND', message: 'no tab' },
    expected: 'UNKNOWN',
  },
];

describe('classifyAgentError', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const out = classifyAgentError({
        err: row.err,
        cmd: row.cmd ?? cmd(),
      });
      expect(out.category).to.equal(row.expected);
      if (row.expectedStatus !== undefined) {
        expect(out.status).to.equal(row.expectedStatus);
      }
      expect(out.recovery).to.be.a('string').and.have.length.greaterThan(0);
    });
  }

  it('preserves the upstream code on the result', () => {
    const out = classifyAgentError({
      err: { code: 'SELECTOR_NOT_FOUND', message: 'x' },
      cmd: cmd('click', { selector: 'button' }),
    });
    expect(out.code).to.equal('SELECTOR_NOT_FOUND');
  });

  it('gives waitForSelector wait-shaped recovery, click DOM-shaped recovery', () => {
    const err = { code: 'SELECTOR_NOT_FOUND', message: 'no element matched' };
    const wait = classifyAgentError({
      err,
      cmd: cmd('waitForSelector', { selector: '.thing' }),
    });
    const click = classifyAgentError({
      err,
      cmd: cmd('click', { selector: '.thing' }),
    });
    expect(wait.category).to.equal(click.category);
    expect(wait.recovery).to.not.equal(click.recovery);
    expect(wait.recovery).to.match(/wait expired/i);
  });

  it('prefers explicit status over message regex', () => {
    const out = classifyAgentError({
      err: { message: 'unrelated 200 in text', status: 403 },
      cmd: cmd('goto'),
    });
    expect(out.category).to.equal('FORBIDDEN');
    expect(out.status).to.equal(403);
  });
});

describe('classifyNavigationResult', () => {
  const CHROME_ERROR = 'chrome-error://chromewebdata/';

  it('flags a goto that landed on the Chrome error page', () => {
    const out = classifyNavigationResult(cmd('goto'), {
      url: CHROME_ERROR,
      status: null,
      text: 'ok',
      rejected: false,
    });
    expect(out?.category).to.equal('NAVIGATION_FAILED');
    expect(toAnalyticsCategory(out?.category)).to.equal('network');
    expect(out?.recovery).to.be.a('string').and.have.length.greaterThan(0);
  });

  it('flags a null status even when the URL survived', () => {
    const out = classifyNavigationResult(cmd('reload'), {
      url: 'https://example.com/',
      status: null,
    });
    expect(out?.category).to.equal('NAVIGATION_FAILED');
  });

  it('ignores a document the caller aborted itself', () => {
    expect(
      classifyNavigationResult(cmd('goto'), {
        url: CHROME_ERROR,
        status: null,
        rejected: true,
      }),
    ).to.equal(undefined);
  });

  it('ignores a successful navigation', () => {
    expect(
      classifyNavigationResult(cmd('goto'), {
        url: 'https://example.com/',
        status: 200,
      }),
    ).to.equal(undefined);
  });

  it('ignores non-navigation methods parked on an error page', () => {
    expect(
      classifyNavigationResult(cmd('snapshot'), { url: CHROME_ERROR }),
    ).to.equal(undefined);
  });

  it('ignores an empty result (back/forward with no history)', () => {
    expect(classifyNavigationResult(cmd('back'), null)).to.equal(undefined);
  });
});

describe('analytics categories', () => {
  it('reports HTTP failures through the shared status policy', () => {
    const cases: Array<[ErrorCategory, number]> = [
      ['UNAUTHORIZED', 401],
      ['FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['SERVER_ERROR', 500],
    ];
    for (const [category, status] of cases) {
      expect(toAnalyticsCategory(category)).to.equal(
        categoryFromStatus(status),
      );
    }
  });

  it('collapses the non-HTTP categories', () => {
    expect(toAnalyticsCategory('SELECTOR_MISS')).to.equal('user_error');
    expect(toAnalyticsCategory('UNKNOWN_METHOD')).to.equal('user_error');
    expect(toAnalyticsCategory('SCRIPT_ERROR')).to.equal('user_error');
    expect(toAnalyticsCategory('SESSION_LOST')).to.equal('network');
    expect(toAnalyticsCategory('NAVIGATION_FAILED')).to.equal('network');
    expect(toAnalyticsCategory('TIMEOUT')).to.equal('timeout');
    expect(toAnalyticsCategory(undefined)).to.equal('unknown');
  });

  it('has no status to judge outside 4xx/5xx', () => {
    expect(categoryFromStatus(200)).to.equal(undefined);
    expect(categoryFromStatus(undefined)).to.equal(undefined);
    expect(categoryFromStatus(504)).to.equal('timeout');
  });
});
