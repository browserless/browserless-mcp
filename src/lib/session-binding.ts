import type { BrowserlessSession } from '../@types/types.js';
import { fullHash } from './account-resolver.js';
import { touchSession } from './session-reaper.js';

export type SessionLike = {
  readonly sessionId?: string;
  readonly auth?: unknown;
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
): void => {
  if (!sessionId) return;
  const session = sessions.find((s) => s.sessionId === sessionId);
  if (
    session?.auth === undefined ||
    sessionPrincipal(session.auth as BrowserlessSession) !==
      sessionPrincipal(auth)
  )
    throw sessionNotFoundResponse();
};

export const admitSessionRequest = (
  sessionId: string | undefined,
  auth: BrowserlessSession,
  sessions: readonly SessionLike[],
): void => {
  assertSessionPrincipal(sessionId, auth, sessions);
  touchSession(sessionId);
};

export const authOutcome = (err: unknown): 'session_mismatch' | 'rejected' =>
  err instanceof Response && err.status === 404
    ? 'session_mismatch'
    : 'rejected';
