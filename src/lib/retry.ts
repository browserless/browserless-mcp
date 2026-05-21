import type { RetryOptions } from '../@types/types.js';

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs, shouldRetry } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      if (attempt === maxRetries) break;
      if (shouldRetry && !shouldRetry(lastError)) break;

      const delay =
        baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
