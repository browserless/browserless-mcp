import type { BrowserlessSession } from '../@types/types.js';
import type { AnalyticsHelper } from './analytics.js';
import {
  diagnosticPreview,
  escapeDiagnosticString,
} from './diagnostic-string.js';
import { exportLogRecord, type LogAttributes } from './otlp-log.js';
import { skillSource } from './skill-telemetry.js';
import { hashToken, resolveMcpSource } from './utils.js';

export const sessionOpenAttributes = (
  auth: BrowserlessSession,
  clientInfo: { name?: string; version?: string } | undefined,
): LogAttributes => {
  const source = resolveMcpSource(auth, clientInfo, 'httpStream');
  return {
    transport: source.transport,
    auth_method: source.auth_method,
    key_fp: hashToken(auth.token),
    source: skillSource(source.source),
    client_family: source.client_family,
    user_agent_family: [
      'node',
      'python-httpx',
      'python-requests',
      'curl',
      'mozilla',
      'undici',
      'go-http-client',
      'claude-user',
      'agent',
    ].includes(source.user_agent_family)
      ? source.user_agent_family
      : 'unknown',
    usage_mode: source.usage_mode,
    ...(auth.accountId ? { account_id: auth.accountId } : {}),
    ...(clientInfo?.name
      ? {
          client_name: escapeDiagnosticString(
            diagnosticPreview(clientInfo.name, 128),
          ),
        }
      : {}),
    ...(clientInfo?.version
      ? {
          client_version: escapeDiagnosticString(
            diagnosticPreview(clientInfo.version, 128),
          ),
        }
      : {}),
  };
};

export const recordSessionOpen = (
  auth: BrowserlessSession,
  clientInfo: { name?: string; version?: string } | undefined,
  analytics: Pick<AnalyticsHelper, 'fireSessionStarted'>,
): void => {
  try {
    const attributes = sessionOpenAttributes(auth, clientInfo);
    void exportLogRecord({
      scope: 'session-open',
      event: 'browserless.mcp.session.open',
      severity: 'INFO',
      attributes,
    });
    if (auth.transport === 'sse')
      analytics.fireSessionStarted(auth.token, attributes);
  } catch {
    // Best-effort telemetry must not interrupt session initialization.
  }
};

export const whenSessionReady = (
  session: {
    isReady: boolean;
    once(event: 'ready', listener: () => void): unknown;
  },
  listener: () => void,
): void => {
  if (session.isReady) listener();
  else session.once('ready', listener);
};
