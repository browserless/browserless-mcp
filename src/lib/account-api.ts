import { UserError } from 'fastmcp';

import { retryWithBackoff } from './retry.js';
import { compact, isMeaningfulBody } from './utils.js';
import { DEFAULT_API_SERVER_URL } from '../config.js';
import type { McpConfig } from '../@types/types.js';

type AccountApiConfig = Pick<
  McpConfig,
  'apiServerUrl' | 'requestTimeout' | 'maxRetries'
>;

/** Network-level failures are worth retrying; a GraphQL error is not. */
const isRetryable = (err: Error): boolean =>
  err.name === 'AbortError' || err instanceof TypeError;

// The token travels only in the `apiToken` variable — never a header, URL, log
// line or thrown message. Revoked tokens are rejected server-side, not here.
export const accountQuery = async <T>(
  config: AccountApiConfig,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const url = `${config.apiServerUrl ?? DEFAULT_API_SERVER_URL}/graphql`;
  const body = JSON.stringify({
    query,
    variables: { ...compact(variables ?? {}), apiToken: token },
  });

  const response = await retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeout);
      try {
        return await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
    {
      maxRetries: config.maxRetries,
      baseDelayMs: 250,
      shouldRetry: isRetryable,
    },
  );

  const payload = (await response.json().catch(() => undefined)) as
    { data?: T; errors?: Array<{ message?: string }> } | undefined;

  const serverMessage = payload?.errors?.[0]?.message;

  if (serverMessage && isMeaningfulBody(serverMessage)) {
    throw new UserError(serverMessage);
  }

  if (!response.ok) {
    throw new UserError(
      `The Browserless account API returned ${response.status}. Check that your token is valid and still active.`,
    );
  }

  if (!payload?.data) {
    throw new UserError(
      'The Browserless account API returned no data for this request.',
    );
  }

  return payload.data;
};
