import type { McpConfig } from '../config.js';
import type { PowerScraperResponse } from '../tools/schemas.js';
import { retryWithBackoff } from './retry.js';
import { ResponseCache } from './cache.js';

export interface PowerScrapeRequest {
  url: string;
  screenshot?: boolean;
  pdf?: boolean;
  markdown?: boolean;
  timeout?: number;
}

export interface ApiClient {
  powerScrape(params: PowerScrapeRequest): Promise<PowerScraperResponse>;
  getStatus(): Promise<{ ok: boolean; message: string }>;
}

export function createApiClient(config: McpConfig): ApiClient {
  const cache = new ResponseCache(config.cacheTtlMs);

  return {
    async powerScrape(
      params: PowerScrapeRequest,
    ): Promise<PowerScraperResponse> {
      const cacheKey = JSON.stringify({
        url: params.url,
        screenshot: params.screenshot ?? false,
        pdf: params.pdf ?? false,
        markdown: params.markdown ?? true,
      });

      const cached = cache.get<PowerScraperResponse>(cacheKey);
      if (cached) {
        return cached;
      }

      const timeout = params.timeout ?? config.requestTimeout;
      const queryParams = new URLSearchParams({
        token: config.browserlessToken!,
        timeout: String(timeout),
      });

      const apiUrl = `${config.browserlessApiUrl}?${queryParams.toString()}`;

      const body = {
        url: params.url,
        screenshot: params.screenshot,
        pdf: params.pdf,
        markdown: params.markdown,
      };

      const result = await retryWithBackoff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            timeout + 5000,
          );

          try {
            const res = await fetch(apiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            });

            if (!res.ok && res.status >= 500) {
              throw new Error(
                `Server error ${res.status}: ${res.statusText}`,
              );
            }

            return (await res.json()) as PowerScraperResponse;
          } finally {
            clearTimeout(timeoutId);
          }
        },
        {
          maxRetries: config.maxRetries,
          baseDelayMs: 1000,
          shouldRetry: (error: Error) => {
            return !error.message.startsWith('Server error 4');
          },
        },
      );

      cache.set(cacheKey, result);
      return result;
    },

    async getStatus(): Promise<{ ok: boolean; message: string }> {
      try {
        const queryParams = new URLSearchParams({
          token: config.browserlessToken!,
        });
        const res = await fetch(
          `${config.browserlessApiUrl}/active?${queryParams.toString()}`,
        );
        if (res.ok) {
          return { ok: true, message: 'Browserless API is reachable' };
        }
        return {
          ok: false,
          message: `API returned status ${res.status}`,
        };
      } catch (err) {
        return {
          ok: false,
          message: `Cannot reach API: ${(err as Error).message}`,
        };
      }
    },
  };
}
