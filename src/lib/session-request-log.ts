import type { IncomingMessage } from 'node:http';
import type { BrowserlessSession } from '../@types/types.js';
import type { BoundedEventStore } from './bounded-event-store.js';
import {
  findLiveSession,
  sessionPrincipal,
  type SessionLike,
  type SessionRefusal,
} from './session-binding.js';
import {
  recordEventStoreContextMissing,
  type CursorKind,
  type McpRequestDetail,
  type McpRequestReason,
} from './metrics-recorders.js';
import { authInputFromRequest, presentsCredential } from './http-auth.js';
import { sanitizeUserAgent } from './attribution.js';
import { hashToken } from './utils.js';
import { exportLogRecord, type LogAttributes } from './otlp-log.js';

export interface ObservedRequest {
  request: Pick<IncomingMessage, 'headers' | 'url' | 'socket'>;
  sessionId?: string;
  method: 'POST' | 'GET' | 'DELETE' | 'other';
  surface: 'full' | 'connector';
  failed: boolean;
  auth?: BrowserlessSession;
  refusal?: SessionRefusal;
  owner?: BrowserlessSession;
  store: Pick<BoundedEventStore, 'cursorContext'>;
  sessions: () => readonly SessionLike[];
}

export const classifyCursor = (
  lastEventId: string | undefined,
  now = Date.now(),
): CursorKind => {
  const value = lastEventId?.trim();
  if (!value) return 'none';
  if (value.length > 128) return 'malformed';
  const match =
    /^(?:(_GET_stream)|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d{13})_\d{1,9}_[0-9a-z]{0,6}$/.exec(
      value,
    );
  if (!match || Number(match[2]) > now) return 'malformed';
  if (Number(match[2]) < Math.floor(performance.timeOrigin))
    return 'prior_process';
  return match[1] ? 'standalone' : 'request';
};

type RecordReason =
  | 'principal_mismatch'
  | 'missing_credentials_live_session'
  | 'invalid_credentials_live_session'
  | 'cursor_context_mismatch';
type Window = {
  endsAt: number;
  count: number;
  dropped: number;
  timer?: NodeJS.Timeout;
};
const windows = new Map<RecordReason, Window>();
let contextNoted = false;

const finishWindow = (
  reason: RecordReason,
  surface: ObservedRequest['surface'],
  window: Window,
): void => {
  clearTimeout(window.timer);
  windows.delete(reason);
  if (window.dropped)
    void exportLogRecord({
      scope: 'session-requests',
      event: 'browserless.mcp.session.records_dropped',
      severity: 'INFO',
      attributes: { reason, dropped: window.dropped, window_s: 60, surface },
    });
};

const recordRefusal = (
  reason: RecordReason,
  surface: ObservedRequest['surface'],
  attributes: LogAttributes,
): void => {
  const now = Date.now();
  let window = windows.get(reason);
  if (window && now >= window.endsAt) {
    finishWindow(reason, surface, window);
    window = undefined;
  }
  if (!window) {
    window = { endsAt: now + 60_000, count: 0, dropped: 0 };
    windows.set(reason, window);
  }
  if (window.count >= 60) {
    window.dropped++;
    if (!window.timer) {
      const current = window;
      window.timer = setTimeout(
        () => {
          try {
            finishWindow(reason, surface, current);
          } catch {
            /* best effort */
          }
        },
        Math.max(0, window.endsAt - now),
      ).unref();
    }
    return;
  }
  window.count++;
  void exportLogRecord({
    scope: 'session-requests',
    event:
      reason === 'cursor_context_mismatch'
        ? 'browserless.mcp.event_store.replay_refused'
        : 'browserless.mcp.session.request_refused',
    severity: 'WARN',
    attributes: { ...attributes, reason },
  });
};

/** Counter details are synchronous; all additional identity work is deferred. */
export const observeSessionRequest = (
  input: ObservedRequest,
): McpRequestDetail | undefined => {
  try {
    const header = input.request.headers['last-event-id'];
    const lastEventId = Array.isArray(header) ? header[0] : header;
    const cursor =
      input.method === 'GET' ? classifyCursor(lastEventId) : undefined;
    const context =
      !input.failed && input.auth && cursor === 'request'
        ? input.store.cursorContext(lastEventId!.trim())
        : undefined;
    let reason: McpRequestReason = 'ok';
    if (input.failed)
      reason =
        input.refusal ??
        (presentsCredential(authInputFromRequest(input.request))
          ? 'invalid_credentials'
          : 'missing_credentials');
    else if (input.auth && cursor === 'request') {
      if (!context) reason = 'unknown_cursor';
      else if (!input.sessionId || context.sessionId !== input.sessionId)
        reason = 'cursor_context_mismatch';
    }
    const detail: McpRequestDetail = {
      reason,
      ...(cursor === undefined ? {} : { cursor }),
    };
    if (
      !input.sessionId ||
      ![
        'principal_mismatch',
        'missing_credentials',
        'invalid_credentials',
        'cursor_context_mismatch',
      ].includes(reason)
    )
      return detail;
    setImmediate(() => {
      try {
        const { auth, surface, sessionId, request } = input;
        let recordReason: RecordReason;
        let owner = input.owner;
        if (
          reason === 'missing_credentials' ||
          reason === 'invalid_credentials'
        ) {
          owner = findLiveSession(sessionId, input.sessions())?.auth as
            BrowserlessSession | undefined;
          if (!owner) return;
          recordReason = `${reason}_live_session`;
        } else if (reason === 'principal_mismatch') {
          if (!auth || !owner) return;
          recordReason = reason;
        } else {
          if (!auth || !context?.sessionId) return;
          recordReason = 'cursor_context_mismatch';
          owner = findLiveSession(context.sessionId, input.sessions())?.auth as
            BrowserlessSession | undefined;
        }
        const ipHeader = request.headers['x-real-ip'];
        const ua = sanitizeUserAgent(request.headers['user-agent']);
        const attributes: LogAttributes = {
          method: input.method,
          surface,
          has_last_event_id: Boolean(lastEventId),
          cursor_kind: cursor ?? 'none',
          session_ref: hashToken(sessionId!),
          ip:
            (Array.isArray(ipHeader) ? ipHeader[0] : ipHeader)?.trim() ||
            request.socket?.remoteAddress ||
            'unknown',
          user_agent: ua.user_agent ?? '',
          user_agent_family: ua.user_agent_family,
        };
        if (owner) attributes.owner_ref = hashToken(sessionPrincipal(owner));
        if (
          auth &&
          (recordReason === 'principal_mismatch' ||
            recordReason === 'cursor_context_mismatch')
        ) {
          attributes.presenter_ref = hashToken(sessionPrincipal(auth));
          if (auth.authMethod) attributes.auth_method = auth.authMethod;
        }
        if (recordReason === 'cursor_context_mismatch' && context?.sessionId) {
          attributes.cursor_session_ref = hashToken(context.sessionId);
          attributes.cursor_age_ms = context.ageMs;
          if (owner)
            attributes.same_principal =
              attributes.presenter_ref === attributes.owner_ref;
        }
        recordRefusal(recordReason, surface, attributes);
      } catch {
        // Diagnostics must not affect request processing.
      }
    });
    return detail;
  } catch {
    return undefined;
  }
};

export const noteMissingStoreContext = (
  surface: 'full' | 'connector',
): void => {
  recordEventStoreContextMissing();
  if (contextNoted) return;
  contextNoted = true;
  setImmediate(() => {
    try {
      void exportLogRecord({
        scope: 'session-requests',
        event: 'browserless.mcp.event_store.context_missing',
        severity: 'ERROR',
        attributes: { surface },
      });
    } catch {
      /* best effort */
    }
  });
};

export const resetSessionRequestLog = (): void => {
  for (const window of windows.values()) clearTimeout(window.timer);
  windows.clear();
  contextNoted = false;
};
