import type {
  AnalyticsErrorCategory,
  ClassifiedError,
  ClassifyInput,
  ErrorCategory,
} from '../@types/types.js';

// Re-export the classifier types consumers of `@browserless.io/mcp/errors` need.
export type {
  AnalyticsErrorCategory,
  ErrorCategory,
  ClassifiedError,
  ClassifyInput,
} from '../@types/types.js';

const RECOVERY: Record<ErrorCategory, string> = {
  SELECTOR_MISS:
    'Re-snapshot — the element is not in the current DOM. If you have not tried it yet, retry with a deep selector "< selector" in case the element is inside a shadow root.',
  SESSION_LOST:
    'A fresh session was opened automatically. Re-run goto then snapshot — page state from before the failure is gone.',
  UNAUTHORIZED:
    'The server returned 401. Authentication is missing or invalid; the page is not reachable from this session. Do not retry the prior selector.',
  FORBIDDEN:
    'The server returned 403. Cookies/auth may be missing or invalid, or the resource is geo/IP-blocked. Do not retry the prior selector.',
  NOT_FOUND:
    'The server returned 404. The URL no longer exists; pick a different navigation target.',
  SERVER_ERROR:
    'The origin returned a 5xx error. Back off briefly, then retry once. If it persists, choose a different path.',
  NAVIGATION_FAILED:
    'A network/DNS error prevented navigation. Verify the URL is correct and reachable.',
  TIMEOUT:
    'The page or wait condition did not resolve in time. Try a longer waitFor, a different signal (waitForResponse with a known URL), or re-snapshot to confirm current state.',
  INVALID_PARAMS:
    'The parameters were rejected. The schema is authoritative — fix the params; do not blind-retry.',
  UNKNOWN_METHOD:
    'That method does not exist. Pick one from the command list in the tool schema and re-issue; do not retry the same name.',
  SCRIPT_ERROR:
    'Your script threw. The page is still alive — re-snapshot to confirm its state, then fix the script.',
  UNKNOWN: 'Re-snapshot and re-plan from the current page state.',
};

// A wait that expired is reported by the agent as SELECTOR_NOT_FOUND, so it
// classifies as SELECTOR_MISS like any other miss — but "re-snapshot" is not the
// move when the caller explicitly asked to wait.
const SELECTOR_WAIT_RECOVERY =
  'The wait expired without the element appearing. Try a longer timeout, a different signal (waitForResponse with a known URL), or re-snapshot to confirm the current state.';

const NAVIGATION_RESULT_METHODS = new Set([
  'goto',
  'reload',
  'back',
  'forward',
  'waitForNavigation',
]);

const CHROME_ERROR_URL_PREFIX = 'chrome-error://';

const FATAL_SESSION_CODES = new Set(['BROWSER_CRASHED']);

const NAVIGATION_FAIL_PATTERNS = [
  /net::ERR_/i,
  /\bECONNREFUSED\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bECONNRESET\b/,
  /navigation aborted/i,
  /failed to navigate/i,
];

const WS_LOSS_PATTERNS = [
  /WebSocket closed/i,
  /WebSocket connection failed/i,
  /Agent WebSocket connection failed/i,
];

const TIMEOUT_PATTERNS = [/timed out/i, /\btimeout\b/i];

const extractStatus = (err: ClassifyInput['err']): number | undefined => {
  if (typeof (err as { status?: unknown }).status === 'number') {
    return (err as { status: number }).status;
  }
  const match = err.message?.match(/\b(401|403|404|5\d\d)\b/);
  if (match) return Number(match[1]);
  return undefined;
};

const fromStatus = (status: number): ErrorCategory | undefined => {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500 && status <= 599) return 'SERVER_ERROR';
  return undefined;
};

const INVALID_PARAMS_PATTERNS = [
  /\bInvalid parameters?\b/i,
  /\bFailed to deserialize\b/i,
];

export const classifyAgentError = (input: ClassifyInput): ClassifiedError => {
  const { err, cmd } = input;
  const code = (err as { code?: string }).code;
  const message = err.message ?? '';

  // Every "the element never appeared" failure reports as SELECTOR_MISS —
  // splitting waitForSelector into TIMEOUT would scatter one root cause across
  // two analytics buckets. Only the recovery wording follows the intent.
  if (code === 'SELECTOR_NOT_FOUND') {
    return {
      category: 'SELECTOR_MISS',
      code,
      recovery:
        cmd?.method === 'waitForSelector'
          ? SELECTOR_WAIT_RECOVERY
          : RECOVERY.SELECTOR_MISS,
    };
  }

  if (code === 'UNKNOWN_METHOD' || /Unknown method/i.test(message)) {
    return {
      category: 'UNKNOWN_METHOD',
      code,
      recovery: RECOVERY.UNKNOWN_METHOD,
    };
  }

  // Authoritative upstream codes win first.
  if (code === 'INVALID_PARAMS') {
    return {
      category: 'INVALID_PARAMS',
      code,
      recovery: RECOVERY.INVALID_PARAMS,
    };
  }

  if (code && FATAL_SESSION_CODES.has(code)) {
    return { category: 'SESSION_LOST', code, recovery: RECOVERY.SESSION_LOST };
  }

  // HTTP status before the INVALID_PARAMS *message-pattern* heuristic so a
  // message that happens to mention 4xx/5xx isn't swallowed by it.
  const status = extractStatus(err);
  if (status !== undefined) {
    const fromCode = fromStatus(status);
    if (fromCode) {
      return {
        category: fromCode,
        code,
        status,
        recovery: RECOVERY[fromCode],
      };
    }
  }

  if (INVALID_PARAMS_PATTERNS.some((re) => re.test(message))) {
    return {
      category: 'INVALID_PARAMS',
      code,
      recovery: RECOVERY.INVALID_PARAMS,
    };
  }

  const isTimeout = TIMEOUT_PATTERNS.some((re) => re.test(message));

  if (/Agent WebSocket connection timed out/i.test(message)) {
    return { category: 'TIMEOUT', code, recovery: RECOVERY.TIMEOUT };
  }

  if (WS_LOSS_PATTERNS.some((re) => re.test(message))) {
    return { category: 'SESSION_LOST', code, recovery: RECOVERY.SESSION_LOST };
  }

  if (NAVIGATION_FAIL_PATTERNS.some((re) => re.test(message))) {
    return {
      category: 'NAVIGATION_FAILED',
      code,
      recovery: RECOVERY.NAVIGATION_FAILED,
    };
  }

  if (isTimeout) {
    return { category: 'TIMEOUT', code, recovery: RECOVERY.TIMEOUT };
  }

  // Last, so an infrastructure failure that happened to occur during evaluate
  // (target closed, timeout, 5xx) keeps its real category: whatever is left is
  // the caller's own script throwing.
  if (cmd?.method === 'evaluate') {
    return { category: 'SCRIPT_ERROR', code, recovery: RECOVERY.SCRIPT_ERROR };
  }

  return { category: 'UNKNOWN', code, recovery: RECOVERY.UNKNOWN };
};

/**
 * A navigation that resolved onto Chrome's error page. DNS/TLS/refused failures
 * never throw — goto returns `chrome-error://chromewebdata/` with a null status —
 * so without this check a failed navigation reports as a success.
 */
export const classifyNavigationResult = (
  cmd: { method: string },
  result: unknown,
): ClassifiedError | undefined => {
  if (!NAVIGATION_RESULT_METHODS.has(cmd.method)) return undefined;
  if (!result || typeof result !== 'object') return undefined;

  const { url, status, rejected } = result as {
    url?: unknown;
    status?: unknown;
    rejected?: unknown;
  };
  // The caller's own interceptor aborting the document is intentional, not a
  // failure — the agent route flags it separately from a no-response error.
  if (rejected === true) return undefined;

  const erroredUrl =
    typeof url === 'string' && url.startsWith(CHROME_ERROR_URL_PREFIX);
  if (!erroredUrl && status !== null) return undefined;

  return {
    category: 'NAVIGATION_FAILED',
    recovery: RECOVERY.NAVIGATION_FAILED,
  };
};

export const categoryFromStatus = (
  status: unknown,
): AnalyticsErrorCategory | undefined => {
  if (typeof status !== 'number') return undefined;
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'api_error';
  if (status >= 400) return 'user_error';
  return undefined;
};

const ANALYTICS_CATEGORY: Record<
  ErrorCategory,
  AnalyticsErrorCategory | number
> = {
  SELECTOR_MISS: 'user_error',
  INVALID_PARAMS: 'user_error',
  UNKNOWN_METHOD: 'user_error',
  SCRIPT_ERROR: 'user_error',
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SERVER_ERROR: 500,
  SESSION_LOST: 'network',
  NAVIGATION_FAILED: 'network',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
};

/** Collapse the 10 agent categories onto the 5 reported to analytics. */
export const toAnalyticsCategory = (
  category?: ErrorCategory,
): AnalyticsErrorCategory => {
  const mapped = category && ANALYTICS_CATEGORY[category];
  if (!mapped) return 'unknown';
  return typeof mapped === 'number'
    ? (categoryFromStatus(mapped) ?? 'unknown')
    : mapped;
};

/**
 * Category for any thrown value: the classifier's message patterns (net::ERR_,
 * timeouts, `Server error 5xx`) fit every tool's errors, not just BQL.
 */
export const categorizeThrown = (err: unknown): AnalyticsErrorCategory => {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  return toAnalyticsCategory(
    classifyAgentError({
      err: { code, message },
      cmd: { method: '', params: {} },
    }).category,
  );
};

export const formatClassifiedError = (
  classified: ClassifiedError,
  bodyLines: string[],
): string => {
  const parts: string[] = [`Category: ${classified.category}`, ...bodyLines];
  parts.push(`Recovery: ${classified.recovery}`);
  return parts.join('\n\n');
};
