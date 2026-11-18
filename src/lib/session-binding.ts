import type { BrowserlessSession } from '../@types/types.js';
import { fullHash } from './account-resolver.js';
import { touchSession } from './session-reaper.js';

export type SessionLike = {
  readonly sessionId?: string;
  readonly auth?: unknown;
};

export type SessionRefusal = 'unknown_session' | 'principal_mismatch';

export const findLiveSession = (
  sessionId: string | undefined,
  sessions: readonly SessionLike[],
): SessionLike | undefined =>
  sessionId
    ? sessions.find((s) => s.sessionId === sessionId && s.auth !== undefined)
    : undefined;

export const requestSessionId = (request: {
  headers?: Record<string, string | string[] | undefined>;
}): string | undefined => {
  const header = request.headers?.['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
};

export const sessionPrincipal = (auth: BrowserlessSession): string =>
  auth.authMethod === 'oauth' && auth.accountId && auth.userId
    ? `user:${auth.accountId}:${auth.userId}`
    : `key:${fullHash(auth.token)}`;

export const sessionNotFoundResponse = (): Response =>
  new Response(
    '{"error":{"code":-32001,"message":"Session not found"},"id":null,"jsonrpc":"2.0"}',
    {
      status: 404,
      statusText: 'Not Found',
      headers: { 'Content-Type': 'application/json' },
    },
  );

export const assertSessionPrincipal = (
  sessionId: string | undefined,
  auth: BrowserlessSession,
  sessions: readonly SessionLike[],
  onRefused?: (refusal: SessionRefusal, owner?: BrowserlessSession) => void,
): void => {
  if (!sessionId) return;
  const session = findLiveSession(sessionId, sessions);
  if (
    session?.auth === undefined ||
    sessionPrincipal(session.auth as BrowserlessSession) !==
      sessionPrincipal(auth)
  ) {
    try {
      onRefused?.(
        session ? 'principal_mismatch' : 'unknown_session',
        session?.auth as BrowserlessSession | undefined,
      );
    } catch {
      // Observation does not affect admission.
    }
    throw sessionNotFoundResponse();
  }
};

export const admitSessionRequest = (
  sessionId: string | undefined,
  auth: BrowserlessSession,
  sessions: readonly SessionLike[],
  onRefused?: (refusal: SessionRefusal, owner?: BrowserlessSession) => void,
): void => {
  assertSessionPrincipal(sessionId, auth, sessions, onRefused);
  touchSession(sessionId);
};

export const authOutcome = (err: unknown): 'session_mismatch' | 'rejected' =>
  err instanceof Response && err.status === 404
    ? 'session_mismatch'
    : 'rejected';
