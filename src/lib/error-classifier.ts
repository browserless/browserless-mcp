import type {
  ClassifiedError,
  ClassifyInput,
  ErrorCategory,
} from '../@types/types.js';

// Re-export the classifier types consumers of `@browserless.io/mcp/errors` need.
export type {
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
  UNKNOWN: 'Re-snapshot and re-plan from the current page state.',
};

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

  // waitForSelector failures are timeouts in intent — the upstream agent
  // surfaces them as SELECTOR_NOT_FOUND, but the user explicitly asked to
  // wait, so the actionable signal is "the wait expired", not "the DOM is
  // missing the element right now".
  if (cmd?.method === 'waitForSelector' && code === 'SELECTOR_NOT_FOUND') {
    return { category: 'TIMEOUT', code, recovery: RECOVERY.TIMEOUT };
  }

  if (code === 'SELECTOR_NOT_FOUND') {
    return {
      category: 'SELECTOR_MISS',
      code,
      recovery: RECOVERY.SELECTOR_MISS,
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

  return { category: 'UNKNOWN', code, recovery: RECOVERY.UNKNOWN };
};

export const formatClassifiedError = (
  classified: ClassifiedError,
  bodyLines: string[],
): string => {
  const parts: string[] = [`Category: ${classified.category}`, ...bodyLines];
  parts.push(`Recovery: ${classified.recovery}`);
  return parts.join('\n\n');
};
