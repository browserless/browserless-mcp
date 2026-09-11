import type { ErrorCategory } from '../@types/types.js';

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
  UNKNOWN: 'unknown',
} satisfies Record<ErrorCategory, string>;

// Codes are untrusted text too. Only documented categories and transport codes
// are safe to publish; an opaque provider code could itself contain a secret.
const safeCodes = new Set([
  ...Object.keys(reasons),
  'SELECTOR_NOT_FOUND',
  'BROWSER_CRASHED',
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
] as const;

/** Build analytics only from structured evidence, never arbitrary error prose. */
export function failureDetails(
  error: unknown,
  options: {
    category?: ErrorCategory;
    source?: Source;
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
    (code === 'SELECTOR_NOT_FOUND'
      ? 'SELECTOR_MISS'
      : code === 'BROWSER_CRASHED'
        ? 'SESSION_LOST'
        : code && Object.hasOwn(reasons, code)
          ? (code as ErrorCategory)
          : status === 401
            ? 'UNAUTHORIZED'
            : status === 403
              ? 'FORBIDDEN'
              : status === 404
                ? 'NOT_FOUND'
                : status !== undefined && status >= 500
                  ? 'SERVER_ERROR'
                  : 'UNKNOWN');
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
    ...(status === undefined
      ? {}
      : {
          error_status_code: status,
          error_status_origin:
            source === 'api' || source === 'target_website'
              ? source
              : 'unknown',
        }),
  };
}
