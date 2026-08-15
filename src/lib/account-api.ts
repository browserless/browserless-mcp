import { UserError } from 'fastmcp';

import type { McpConfig } from '../@types/types.js';
import { retryWithBackoff } from './retry.js';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

type AccountApiConfig = Pick<
  McpConfig,
  'accountGraphqlUrl' | 'requestTimeout' | 'maxRetries'
>;

const safeServerMessage = (message: string, token: string): string =>
  token ? message.split(token).join('[REDACTED]') : message;

export const accountQuery = async <T>(
  config: AccountApiConfig,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> =>
  retryWithBackoff(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.requestTimeout);
      try {
        const response = await fetch(config.accountGraphqlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query,
            variables: { ...variables, apiToken: token },
          }),
          signal: controller.signal,
        });

        let body: GraphQLResponse<T> | undefined;
        try {
          body = (await response.json()) as GraphQLResponse<T>;
        } catch {
          throw new UserError(
            `Browserless account API returned an invalid response (HTTP ${response.status}).`,
          );
        }

        const graphQLError = body.errors?.[0]?.message;
        if (graphQLError) {
          throw new UserError(safeServerMessage(graphQLError, token));
        }
        if (!response.ok) {
          throw new UserError(
            `Browserless account API returned HTTP ${response.status}.`,
          );
        }
        if (body.data === undefined) {
          throw new UserError(
            'Browserless account API returned no data for this request.',
          );
        }
        return body.data;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      maxRetries: config.maxRetries,
      baseDelayMs: 1000,
      // GraphQL and HTTP response errors are deterministic user-facing
      // outcomes. Retry only failures where fetch itself did not complete.
      shouldRetry: (error) => !(error instanceof UserError),
    },
  );
