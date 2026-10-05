import type { ErrorCategory } from '../@types/types.js';

export type FailureCategory = ErrorCategory | 'RATE_LIMITED';

type Source =
  'validation' | 'script' | 'target_website' | 'api' | 'transport' | 'unknown';

const reasons = {
  SELECTOR_MISS: 'selector_miss',
  INVALID_PARAMS: 'invalid_params',
  UNKNOWN_METHOD: 'unknown_method',
  SCRIPT_ERROR: 'script_error',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  SERVER_ERROR: 'server_error',
  SESSION_LOST: 'session_lost',
  NAVIGATION_FAILED: 'navigation_failed',
  TIMEOUT: 'timeout',
  RATE_LIMITED: 'rate_limited',
  UNKNOWN: 'unknown',
} satisfies Record<FailureCategory, string>;

const codeCategories: Partial<Record<string, FailureCategory>> = {
  SELECTOR_NOT_FOUND: 'SELECTOR_MISS',
  BROWSER_CRASHED: 'SESSION_LOST',
  NAVIGATION_TIMEOUT: 'TIMEOUT',
};

const statusCategories: Partial<Record<number, FailureCategory>> = {
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  408: 'TIMEOUT',
  429: 'RATE_LIMITED',
};

// Codes are untrusted text too. Only documented categories and transport codes
// are safe to publish; an opaque provider code could itself contain a secret.
const safeCodes = new Set([
  ...Object.keys(reasons),
  ...Object.keys(codeCategories),
  'INTERNAL_ERROR',
  'TAB_NOT_FOUND',
  'TAB_CLOSED',
  'TAB_LIMIT_EXCEEDED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
]);

export const failureFields = [
  'error_reason',
  'error_source',
  'error_code',
  'error_message',
  'error_status_code',
  'error_status_origin',
  'failed_method',
  'failed_command_index',
  'retryable',
] as const;

/** Build analytics only from structured evidence, never arbitrary error prose. */
export function failureDetails(
  error: unknown,
  options: {
    category?: FailureCategory;
    source?: Source;
    statusOrigin?: 'api' | 'target_website';
  } = {},
): Record<string, unknown> {
  const err =
    error && typeof error === 'object'
      ? (error as {
          code?: unknown;
          status?: unknown;
          statusCode?: unknown;
          apiStatus?: unknown;
          apiCode?: unknown;
          retryable?: unknown;
        })
      : {};
  const rawStatus = err.apiStatus ?? err.status ?? err.statusCode;
  const status =
    typeof rawStatus === 'number' &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 100 &&
    rawStatus <= 599
      ? rawStatus
      : undefined;
  const rawCode = err.apiCode ?? err.code;
  const code =
    typeof rawCode === 'string' && safeCodes.has(rawCode) ? rawCode : undefined;
  const category =
    options.category ??
    (code === undefined ? undefined : codeCategories[code]) ??
    (code && Object.hasOwn(reasons, code)
      ? (code as FailureCategory)
      : undefined) ??
    (status === undefined ? undefined : statusCategories[status]) ??
    (status !== undefined && status >= 500 ? 'SERVER_ERROR' : 'UNKNOWN');
  const reason = reasons[category];
  const source =
    options.source ??
    (err.apiStatus !== undefined
      ? 'api'
      : code === 'INVALID_PARAMS' || code === 'UNKNOWN_METHOD'
        ? 'validation'
        : 'unknown');
  return {
    error_reason: reason,
    error_source: source,
    // Synthesized summaries deliberately omit raw text rather than attempting
    // best-effort regex redaction of arbitrary scripts, selectors, or bodies.
    error_message: `Request failed: ${reason.replaceAll('_', ' ')}.`.slice(
      0,
      500,
    ),
    ...(code === undefined ? {} : { error_code: code }),
    ...(typeof err.retryable === 'boolean' ? { retryable: err.retryable } : {}),
    ...(status === undefined
      ? {}
      : {
          error_status_code: status,
          error_status_origin:
            options.statusOrigin ??
            (source === 'api' || source === 'target_website'
              ? source
              : 'unknown'),
        }),
  };
}
